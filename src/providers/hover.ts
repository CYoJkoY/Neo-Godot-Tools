import * as vscode from "vscode";
import { HoverFallback } from "../fallback/hover";
import { LanguageService } from "../language/service";
import { SceneParser } from "../scene_tools";
import { convert_resource_path_to_uri, convert_uid_to_uri, convert_uri_to_resource_path } from "../utils";
import { RESOURCE_SELECTOR } from "./selectors";

/** `[extension, language id]` for the resource kinds the docs links point at. */
const RESOURCE_LANGUAGES: Array<[string, string]> = [
	[".gd", "gdscript"],
	[".cs", "csharp"],
	[".tscn", "gdscene"],
	[".tres", "gdresource"],
	[".png", "image"],
	[".svg", "image"],
];

const EXT_RESOURCE_WORD = /(?:Ext|Sub)Resource\(\s?"?(\w+)\s?"?\)/;
const RES_PATH_WORD = /res:\/\/[^"^']*/;
const UID_WORD = /uid:\/\/[0-9a-z]*/;
const RES_PATH_LINK = /res:\/\/[^"^']*/g;
const UID_LINK = /uid:\/\/[0-9a-z]*/g;

function languageFor(resourcePath: string): string | undefined {
	return RESOURCE_LANGUAGES.find(([extension]) => resourcePath.endsWith(extension))?.[1];
}

function imageMarkdown(uri: vscode.Uri | undefined): string {
	return `<img src="${uri}" min-width=100px max-width=500px/>`;
}

/** Renders an image inline; `<img>` needs HTML support and trust. */
function appendImage(contents: vscode.MarkdownString, markdown: string): void {
	contents.appendMarkdown(markdown);
	contents.supportHtml = true;
	contents.isTrusted = true;
}

/** Resource links of an `ExtResource` definition body, one markdown bullet each. */
async function getLinks(text: string): Promise<string> {
	const resources = await Promise.all(
		Array.from(text.matchAll(RES_PATH_LINK), async (match) => {
			const uri = await convert_resource_path_to_uri(match[0]);
			return uri instanceof vscode.Uri ? `* [${match[0]}](${uri})\n` : "";
		}),
	);
	const uids = await Promise.all(
		Array.from(text.matchAll(UID_LINK), async (match) => {
			const uri = await convert_uid_to_uri(match[0]);
			return uri instanceof vscode.Uri ? `* [${match[0]}](${uri})\n` : "";
		}),
	);
	return [...resources, ...uids].join("");
}

/** The hover of an `ExtResource`/`SubResource` declaration in a scene document. */
async function sceneHover(
	document: vscode.TextDocument,
	position: vscode.Position,
	parser: SceneParser,
): Promise<vscode.Hover | undefined> {
	if (!["gdresource", "gdscene"].includes(document.languageId)) return undefined;
	const word = document.getText(document.getWordRangeAtPosition(position, EXT_RESOURCE_WORD));
	const match = word.match(EXT_RESOURCE_WORD);
	if (!match) return undefined;
	const scene = parser.parse_scene(document);

	if (word.startsWith("ExtResource")) {
		const resource = scene.externalResources.get(match[1]);
		if (!resource) return undefined;
		const links = await getLinks(resource.body);
		const contents = new vscode.MarkdownString(links);
		contents.appendMarkdown("\n---\n");
		contents.appendCodeblock(resource.body, "gdresource");
		const uri = await convert_resource_path_to_uri(resource.path);
		if (resource.type === "Texture") appendImage(contents, `\n---\n${imageMarkdown(uri)}\n`);
		if (resource.type === "Script") {
			contents.appendMarkdown("\n---\n");
			contents.appendCodeblock((await vscode.workspace.openTextDocument(uri)).getText(), "gdscript");
		}
		return new vscode.Hover(contents);
	}

	const definition = scene.subResources.get(match[1])?.body?.replace(/Array\([0-9,\.\- ]*\)/, "Array(...)");
	const contents = new vscode.MarkdownString();
	contents.appendCodeblock(definition ?? `Definition not found for id ${match[1]}`, "gdresource");
	return new vscode.Hover(contents);
}

/** The hover of a `res://` path or `uid://` id, in any language. */
async function pathHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
	const path = document.getText(document.getWordRangeAtPosition(position, RES_PATH_WORD));
	const link = path.startsWith("res://") ? path : await uidToPath(document, position);
	if (!link?.startsWith("res://")) return undefined;
	const type = languageFor(link);
	if (!type) return undefined;

	const contents = new vscode.MarkdownString();
	const uri = await convert_resource_path_to_uri(link);
	if (type === "image") {
		appendImage(contents, imageMarkdown(uri));
		return new vscode.Hover(contents);
	}
	contents.appendCodeblock((await vscode.workspace.openTextDocument(uri)).getText(), type);
	return new vscode.Hover(contents);
}

/** Resolves a `uid://` id under the cursor to the `res://` path it points at. */
async function uidToPath(document: vscode.TextDocument, position: vscode.Position): Promise<string | undefined> {
	const uid = document.getText(document.getWordRangeAtPosition(position, UID_WORD));
	if (!uid.startsWith("uid://")) return undefined;
	const uri = await convert_uid_to_uri(uid);
	return await convert_uri_to_resource_path(uri ?? vscode.Uri.parse(uid));
}

export interface HoverProviderOptions {
	/** Local semantic hover; without it only scene and path documents are served. */
	languageService?: LanguageService;
	fallback?: HoverFallback;
}

export interface GDHoverProvider extends vscode.HoverProvider {
	/** Narrowed to a real hover: the caller never has to handle `null`. */
	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Hover | undefined>;
}

export function createHoverProvider(
	context: vscode.ExtensionContext,
	options: HoverProviderOptions = {},
): GDHoverProvider {
	const parser = new SceneParser();
	const fallback = options.fallback ?? new HoverFallback();
	const provider: GDHoverProvider = {
		async provideHover(document, position, token): Promise<vscode.Hover | undefined> {
			if (document.languageId === "gdscript" && options.languageService) {
				const local = options.languageService.getHover(document, position);
				if (local) return local;
				return fallback.provide(document, position, token);
			}
			return (await sceneHover(document, position, parser)) ?? pathHover(document, position);
		},
	};
	context.subscriptions.push(vscode.languages.registerHoverProvider(RESOURCE_SELECTOR, provider));
	return provider;
}
