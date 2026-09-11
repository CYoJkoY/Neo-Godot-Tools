import * as vscode from "vscode";
import { SceneParser } from "../scene_tools";
import { convert_resource_path_to_uri, convert_uid_to_uri, convert_uri_to_resource_path } from "../utils";
import { LanguageService } from "../language/service";
import { HoverFallback } from "../fallback/hover";

export class GDHoverProvider implements vscode.HoverProvider {
	public parser = new SceneParser();

	constructor(private readonly context: vscode.ExtensionContext, private readonly languageService?: LanguageService, private readonly fallback = new HoverFallback()) {
		const selector = [
			{ language: "gdresource", scheme: "file" },
			{ language: "gdscene", scheme: "file" },
			{ language: "gdscript", scheme: "file" },
		];
		context.subscriptions.push(vscode.languages.registerHoverProvider(selector, this));
	}

	async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		if (document.languageId === "gdscript" && this.languageService) {
			const local = this.languageService.getHover(document, position);
			if (local) return local;
			return this.fallback.provide(document, position, token);
		}
		return this.provideResourceHover(document, position);
	}

	private async provideResourceHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
		if (["gdresource", "gdscene"].includes(document.languageId)) {
			const scene = this.parser.parse_scene(document);
			const wordPattern = /(?:Ext|Sub)Resource\(\s?"?(\w+)\s?"?\)/;
			const word = document.getText(document.getWordRangeAtPosition(position, wordPattern));
			if (word.startsWith("ExtResource")) {
				const match = word.match(wordPattern);
				if (!match) return undefined;
				const resource = scene.externalResources.get(match[1]);
				if (!resource) return undefined;
				const definition = resource.body;
				const links = await this.getLinks(definition);
				const contents = new vscode.MarkdownString(links);
				const uri = await convert_resource_path_to_uri(resource.path);
				contents.appendMarkdown("\n---\n");
				contents.appendCodeblock(definition, "gdresource");
				if (resource.type === "Texture") {
					contents.appendMarkdown(`\n---\n<img src="${uri}" min-width=100px max-width=500px/>\n`);
					contents.supportHtml = true;
					contents.isTrusted = true;
				}
				if (resource.type === "Script") {
					contents.appendMarkdown("\n---\n");
					const text = (await vscode.workspace.openTextDocument(uri)).getText();
					contents.appendCodeblock(text, "gdscript");
				}
				return new vscode.Hover(contents);
			}
			if (word.startsWith("SubResource")) {
				const match = word.match(wordPattern);
				if (!match) return undefined;
				let definition = scene.subResources.get(match[1])?.body;
				definition = definition?.replace(/Array\([0-9,\.\- ]*\)/, "Array(...)");
				const contents = new vscode.MarkdownString();
				contents.appendCodeblock(definition ?? `Definition not found for id ${match[1]}`, "gdresource");
				return new vscode.Hover(contents);
			}
		}

		let link = document.getText(document.getWordRangeAtPosition(position, /res:\/\/[^"^']*/));
		if (!link.startsWith("res://")) {
			link = document.getText(document.getWordRangeAtPosition(position, /uid:\/\/[0-9a-z]*/));
			if (link.startsWith("uid://")) {
				const uri = await convert_uid_to_uri(link);
				link = await convert_uri_to_resource_path(uri ?? vscode.Uri.parse(link));
			}
		}
		if (!link.startsWith("res://")) return undefined;
		let type = "";
		if (link.endsWith(".gd")) type = "gdscript";
		else if (link.endsWith(".cs")) type = "csharp";
		else if (link.endsWith(".tscn")) type = "gdscene";
		else if (link.endsWith(".tres")) type = "gdresource";
		else if (link.endsWith(".png") || link.endsWith(".svg")) type = "image";
		else return undefined;
		const uri = await convert_resource_path_to_uri(link);
		const contents = new vscode.MarkdownString();
		if (type === "image") {
			contents.appendMarkdown(`<img src="${uri}" min-width=100px max-width=500px/>`);
			contents.supportHtml = true;
			contents.isTrusted = true;
		} else {
			const text = (await vscode.workspace.openTextDocument(uri)).getText();
			contents.appendCodeblock(text, type);
		}
		return new vscode.Hover(contents);
	}

	private async getLinks(text: string): Promise<string> {
		let links = "";
		for (const match of text.matchAll(/res:\/\/[^"^']*/g)) {
			const uri = await convert_resource_path_to_uri(match[0]);
			if (uri instanceof vscode.Uri) links += `* [${match[0]}](${uri})\n`;
		}
		for (const match of text.matchAll(/uid:\/\/[0-9a-z]*/g)) {
			const uri = await convert_uid_to_uri(match[0]);
			if (uri instanceof vscode.Uri) links += `* [${match[0]}](${uri})\n`;
		}
		return links;
	}
}
