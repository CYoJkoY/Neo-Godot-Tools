import * as vscode from "vscode";
import type {
	CancellationToken,
	Disposable,
	DocumentSymbol,
	Event,
	InlayHint,
	InlayHintsProvider,
	Position,
	TextDocument,
} from "vscode";
import { ManagerStatus } from "../lsp";
import { SceneParser } from "../scene_tools";
import { get_configuration } from "../utils";
import { RESOURCE_SELECTOR } from "./selectors";

/** The language-client surface the hints read; `globals.lsp` satisfies it. */
export interface InlayHintLsp {
	readonly client: InlayHintSource;
	onStatusChanged(listener: (status: ManagerStatus) => unknown): Disposable;
}

/** The subset of the language client the hints need. */
export interface InlayHintSource {
	isRunning(): boolean;
	sendRequest(method: string, params?: unknown): Promise<unknown>;
}

/**
 * Returns a label from a detail string.
 * E.g. `var a: int` gets parsed to ` int `.
 */
function fromDetail(detail: string): string {
	const match = detail.match(/: ([\w\d_.]+)/);
	const label = match ? match[1] : "unknown";
	// fix when detail includes a script name
	return label.includes(".gd.") ? label.split(".gd.")[1] : label;
}

type HoverResult = {
	contents: {
		kind: string;
		value: string;
	};
};

async function addByHover(
	document: TextDocument,
	hoverPosition: Position,
	client: InlayHintSource,
): Promise<string | undefined> {
	const response = (await client.sendRequest("textDocument/hover", {
		textDocument: { uri: document.uri.toString() },
		position: { line: hoverPosition.line, character: hoverPosition.character },
	})) as HoverResult;

	// An empty contents array means the server has no hover information.
	if (Array.isArray(response.contents) && response.contents.length === 0) return undefined;
	return response.contents?.value;
}

function buildHint(start: Position, detail: string): InlayHint {
	const label = fromDetail(detail);
	const hint = new vscode.InlayHint(start, label, vscode.InlayHintKind.Type);
	hint.paddingLeft = true;
	hint.paddingRight = true;
	hint.textEdits = [vscode.TextEdit.insert(start, ` ${label} `)];
	return hint;
}

/**
 * The engine answers `textDocument/documentSymbol` with a nested list on Godot
 * 4 and a flat one on 3.2 and below; the variable declarations arrive flat in
 * both cases.
 */
function variableSymbols(symbolsRequest: DocumentSymbol[]): DocumentSymbol[] {
	const first = symbolsRequest[0];
	return first && typeof first === "object" && "children" in first ? (first.children ?? []) : symbolsRequest;
}

/**
 * Hints the types of the inferred variable declarations in `range`. Neither the
 * LSP nor the grammar knows whether a variable is inferred, so the declarations
 * are matched textually and only their types are requested.
 */
export async function gdscriptHints(
	document: TextDocument,
	text: string,
	textStartOffset: number,
	token: CancellationToken,
	client: InlayHintSource | undefined,
): Promise<InlayHint[]> {
	if (!client?.isRunning()) return [];
	if (!get_configuration("inlayHints.gdscript", true)) return [];

	const response = (await client.sendRequest("textDocument/documentSymbol", {
		textDocument: { uri: document.uri.toString() },
	})) as DocumentSymbol[];
	if (!response.length) return [];

	const symbols = variableSymbols(response);
	const hasDetail = symbols.some((symbol) => symbol.detail);
	const matches = Array.from(text.matchAll(/((var|const)\s+)([\w\d_]+)\s*:=/g)).filter(
		(match) => match.index !== undefined,
	);

	// The engine answers hover requests one at a time, so the declarations are
	// resolved in order and a cancelled request ends the walk instead of
	// queueing a hover for every remaining declaration.
	return matches.reduce<Promise<InlayHint[]>>(async (previous, match) => {
		const hints = await previous;
		if (token.isCancellationRequested) return hints;
		const start = document.positionAt(textStartOffset + match.index + match[0].length - 1);
		const symbol = hasDetail ? symbols.find((entry) => entry.name === match[3]) : undefined;
		if (symbol?.detail) return [...hints, buildHint(start, symbol.detail)];
		const hoverPosition = document.positionAt(textStartOffset + match.index + match[1].length);
		const detail = await addByHover(document, hoverPosition, client);
		return detail ? [...hints, buildHint(start, detail)] : hints;
	}, Promise.resolve([]));
}

const EXTERNAL_RESOURCE_PATTERN = /ExtResource\(\s?"?(\w+)\s?"?\)/g;
const SUB_RESOURCE_PATTERN = /SubResource\(\s?"?(\w+)\s?"?\)/g;

/** Hints the resolved type of every `ExtResource`/`SubResource` id in a scene. */
export function sceneHints(
	document: TextDocument,
	text: string,
	textStartOffset: number,
	parser: SceneParser,
): InlayHint[] {
	const scene = parser.parse_scene(document);
	const resourceIds = (pattern: RegExp): Array<[string, Position]> =>
		Array.from(text.matchAll(pattern), (match) => [
			match[1],
			document.positionAt(textStartOffset + match.index + match[0].length),
		]);
	const makeHint = (label: string, position: Position): InlayHint => {
		const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Type);
		hint.paddingLeft = true;
		return hint;
	};
	return [
		...resourceIds(EXTERNAL_RESOURCE_PATTERN).map(([id, end]) => {
			const resource = scene.externalResources.get(id);
			return makeHint(`${resource?.type}: "${resource?.path}"`, end);
		}),
		...resourceIds(SUB_RESOURCE_PATTERN).map(([id, end]) => makeHint(`${scene.subResources.get(id)?.type}`, end)),
	];
}

/** How long to wait for the scene data the engine sends after the handshake. */
const REFRESH_DELAY_MS = 250;

export interface GDInlayHintsProvider extends InlayHintsProvider, Disposable {
	readonly onDidChangeInlayHints: Event<void>;
}

export interface InlayHintOptions {
	/** Resolved on every call: the connection manager replaces its client on reconnect. */
	lsp?: () => InlayHintLsp | undefined;
	/** Delay before the refresh that follows the handshake. */
	refreshDelayMs?: number;
}

export function createInlayHintsProvider(
	context: vscode.ExtensionContext,
	options: InlayHintOptions = {},
): GDInlayHintsProvider {
	const parser = new SceneParser();
	const lsp = options.lsp ?? (() => undefined);
	const onDidChangeInlayHints = new vscode.EventEmitter<void>();
	/** Latest-wins timer of the post-handshake refresh. */
	const refresh: { timer?: ReturnType<typeof setTimeout> } = {};

	/** The engine sends its scene data slightly after the handshake, so refresh once more. */
	const scheduleRefresh = (): void => {
		if (refresh.timer) clearTimeout(refresh.timer);
		refresh.timer = setTimeout(() => {
			refresh.timer = undefined;
			onDidChangeInlayHints.fire();
		}, options.refreshDelayMs ?? REFRESH_DELAY_MS);
	};
	const statusChanged: Disposable | undefined = lsp()?.onStatusChanged((status) => {
		onDidChangeInlayHints.fire();
		if (status === ManagerStatus.CONNECTED) scheduleRefresh();
	});
	const provider: GDInlayHintsProvider = {
		onDidChangeInlayHints: onDidChangeInlayHints.event,
		provideInlayHints(document, range, token): Promise<InlayHint[]> | InlayHint[] {
			const text = document.getText(range);
			const textStartOffset = document.offsetAt(range.start);
			if (document.fileName.endsWith(".gd"))
				return gdscriptHints(document, text, textStartOffset, token, lsp()?.client);
			if (!get_configuration("inlayHints.gdresource", true)) return [];
			return sceneHints(document, text, textStartOffset, parser);
		},
		dispose(): void {
			if (refresh.timer) clearTimeout(refresh.timer);
			refresh.timer = undefined;
			statusChanged?.dispose();
			onDidChangeInlayHints.dispose();
		},
	};

	context.subscriptions.push(vscode.languages.registerInlayHintsProvider(RESOURCE_SELECTOR, provider), provider);
	return provider;
}
