import * as vscode from "vscode";
import { get_configuration } from "../utils";
import { format_document_async } from "./textmate";

/** GDScript files, the only documents the built-in formatter handles. */
const SELECTOR = { language: "gdscript", scheme: "file" };

/**
 * Configuration `neoGodotTools.formatter.enabled`.
 *
 * VS Code only asks the formatter an extension registered for a language, so a
 * provider that stays registered keeps formatting even when
 * `editor.defaultFormatter` names someone else. Dropping the registration is
 * what lets another extension own GDScript files.
 */
export const FORMATTER_ENABLED_SETTING = "neoGodotTools.formatter.enabled";

/** Whether this extension should offer its formatter for GDScript. */
export function formatterEnabled(): boolean {
	return get_configuration("formatter.enabled", true) === true;
}

export class FormattingProvider implements vscode.DocumentFormattingEditProvider {
	private registration: vscode.Disposable | undefined;

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration(FORMATTER_ENABLED_SETTING)) return;
				this.syncRegistration();
			}),
			{ dispose: () => this.registration?.dispose() },
		);
		this.syncRegistration();
	}

	/** Whether VS Code currently routes GDScript formatting to this extension. */
	public get registered(): boolean {
		return this.registration !== undefined;
	}

	public provideDocumentFormattingEdits(document: vscode.TextDocument) {
		return format_document_async(document);
	}

	/** Applies the setting without requiring a window reload. */
	private syncRegistration(): void {
		if (formatterEnabled()) {
			this.registration ??= vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, this);
			return;
		}
		this.registration?.dispose();
		this.registration = undefined;
	}
}
