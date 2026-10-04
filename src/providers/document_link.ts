import * as vscode from "vscode";
import type {
	CancellationToken,
	DocumentLink,
	DocumentLinkProvider,
	ExtensionContext,
	Range,
	TextDocument,
	Uri,
} from "vscode";
import { SceneParser } from "../scene_tools";
import { convert_resource_path_to_uri, convert_uids_to_uris } from "../utils";
import { RESOURCE_SELECTOR } from "./selectors";

const POSITION_ZERO = new vscode.Position(0, 0);

function makeMatchRange(document: TextDocument, match: RegExpMatchArray): Range {
	if (match.index === undefined) return new vscode.Range(POSITION_ZERO, POSITION_ZERO);
	const start = document.positionAt(match.index);
	return new vscode.Range(start, document.positionAt(match.index + match[0].length));
}

const EXT_RESOURCE_PATTERN = /ExtResource\(\s?"?(\w+)\s?"?\)/g;
const SUB_RESOURCE_PATTERN = /SubResource\(\s?"?(\w+)\s?"?\)/g;
const RES_PATH_PATTERN = /res:\/\/([^"'\n]*)/g;
const UID_PATTERN = /uid:\/\/([0-9a-z]*)/g;

/** Links to the `ExtResource`/`SubResource` declarations inside the same file. */
function sceneLinks(document: TextDocument, text: string, parser: SceneParser): DocumentLink[] {
	const scene = parser.parse_scene(document);
	const path = document.uri.fsPath;
	const at = (line: number | undefined): Uri => vscode.Uri.from({ scheme: "file", path, fragment: `${line},0` });
	const makeLink = (match: RegExpMatchArray, uri: Uri, tooltip?: string): DocumentLink => {
		const link = new vscode.DocumentLink(makeMatchRange(document, match), uri);
		if (tooltip) link.tooltip = tooltip;
		return link;
	};
	return [
		...Array.from(text.matchAll(EXT_RESOURCE_PATTERN), (match) =>
			makeLink(match, at(scene.externalResources.get(match[1])?.line), "Jump to resource definition"),
		),
		...Array.from(text.matchAll(SUB_RESOURCE_PATTERN), (match) =>
			makeLink(match, at(scene.subResources.get(match[1])?.line)),
		),
	];
}

/** Links to the `res://` paths and `uid://` ids anywhere in the document. */
async function resourceLinks(document: TextDocument, text: string): Promise<DocumentLink[]> {
	const paths = await Promise.all(
		Array.from(text.matchAll(RES_PATH_PATTERN), async (match) => {
			const uri = await convert_resource_path_to_uri(match[0]);
			return uri instanceof vscode.Uri
				? new vscode.DocumentLink(makeMatchRange(document, match), uri)
				: undefined;
		}),
	);
	const uidMatches = Array.from(text.matchAll(UID_PATTERN));
	const uidMap = await convert_uids_to_uris([...new Set(uidMatches.map((match) => match[0]))]);
	const uids = uidMatches.map((match) => {
		const uri = uidMap.get(match[0]);
		return uri instanceof vscode.Uri ? new vscode.DocumentLink(makeMatchRange(document, match), uri) : undefined;
	});
	return [...paths, ...uids].filter((link): link is DocumentLink => link !== undefined);
}

export type GDDocumentLinkProvider = DocumentLinkProvider;

export function createDocumentLinkProvider(context: ExtensionContext): GDDocumentLinkProvider {
	const parser = new SceneParser();
	const provider: GDDocumentLinkProvider = {
		async provideDocumentLinks(document: TextDocument, _token: CancellationToken): Promise<DocumentLink[]> {
			const text = document.getText();
			if (!["gdresource", "gdscene"].includes(document.languageId)) return resourceLinks(document, text);
			return [...sceneLinks(document, text, parser), ...(await resourceLinks(document, text))];
		},
	};
	context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(RESOURCE_SELECTOR, provider));
	return provider;
}
