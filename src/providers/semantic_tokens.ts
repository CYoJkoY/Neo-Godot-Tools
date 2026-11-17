import * as vscode from "vscode";
import type {
	CancellationToken,
	DocumentSemanticTokensProvider,
	ExtensionContext,
	SemanticTokens,
	TextDocument,
} from "vscode";
import type { IndexedFile } from "../index";
import { tokensFor } from "../index/token_cache";
import type { LanguageService } from "../language/service";
import { RESOURCE_SELECTOR } from "./selectors";

const LEGEND = ["nodePath", "parameter"];

/**
 * The string literal handed to a node lookup, e.g. the `"Player/Camera"` in
 * `get_node("Player/Camera")`. The lookbehind keeps the match on the literal.
 */
const NODE_PATH_PATTERN =
	/(?<=(?:get_node|has_node|find_node|get_node_or_null|has_node_and_resource)\(\s?)(("|')((?!\2).)*\2)(?=\s?\))/g;

export type GDSemanticTokensProvider = DocumentSemanticTokensProvider;

export interface SemanticToken {
	start: number;
	end: number;
	type: "nodePath" | "parameter";
}

/** Ranges of the node-path literals passed to the node lookup builtins. */
function nodePathSemanticTokens(source: string): SemanticToken[] {
	return Array.from(source.matchAll(NODE_PATH_PATTERN), (match) => {
		const start = match.index ?? 0;
		return { start, end: start + match[0].length, type: "nodePath" };
	});
}

/** Identifiers bound to a function parameter, including its declaration. */
function parameterSemanticTokens(file: IndexedFile, bindings: LanguageService["bindings"]): SemanticToken[] {
	const tokens = tokensFor(file.uri, file.source, file.sourceFingerprint);
	return tokens.flatMap((token, index) => {
		if (token.kind !== "identifier" || tokens[index - 1]?.value === ".") return [];
		const binding = bindings.getBinding(file.uri, token.start, token.value);
		return binding?.kind === "parameter" ? [{ start: token.start, end: token.end, type: "parameter" }] : [];
	});
}

/**
 * Semantic ranges for one document, ordered by offset.
 *
 * The binding index is refreshed from the document itself first: semantic
 * tokens are requested while the user types, and the debounced index update may
 * still describe the previous text.
 */
export function collectSemanticTokens(document: TextDocument, languageService: LanguageService): SemanticToken[] {
	languageService.ensureDocumentIndexed(document);
	const file = document.languageId === "gdscript" ? languageService.files.get(document.uri.toString()) : undefined;
	const source = file?.source ?? document.getText();
	const parameters = file ? parameterSemanticTokens(file, languageService.bindings) : [];
	return [...nodePathSemanticTokens(source), ...parameters].sort((left, right) => left.start - right.start);
}

export function createSemanticTokensProvider(
	context: ExtensionContext,
	options: { languageService: LanguageService },
): GDSemanticTokensProvider {
	const legend = new vscode.SemanticTokensLegend(LEGEND);
	const provider: GDSemanticTokensProvider = {
		provideDocumentSemanticTokens(document: TextDocument, _token: CancellationToken): SemanticTokens {
			const builder = new vscode.SemanticTokensBuilder(legend);
			collectSemanticTokens(document, options.languageService).map((token) =>
				builder.push(
					new vscode.Range(document.positionAt(token.start), document.positionAt(token.end)),
					token.type,
					[],
				),
			);
			return builder.build();
		},
	};
	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider(RESOURCE_SELECTOR, provider, legend),
	);
	return provider;
}
