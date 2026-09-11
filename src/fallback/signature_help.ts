import * as vscode from "vscode";
import { SignatureHelpRequest } from "vscode-languageclient/node";
import { globals } from "../extension";

type LspParameter = { label: string | [number, number]; documentation?: string | { value: string } };
type LspSignatureHelp = {
	signatures?: Array<{ label: string; documentation?: string | { value: string }; parameters?: LspParameter[]; activeParameter?: number }>;
	activeSignature?: number;
	activeParameter?: number;
};

export class SignatureHelpFallback {
	async provide(document: vscode.TextDocument, position: vscode.Position, context: vscode.SignatureHelpContext, token: vscode.CancellationToken): Promise<vscode.SignatureHelp | undefined> {
		const client = globals.lsp?.client;
		if (!client) return undefined;
		try {
			const result = await client.sendRequest(SignatureHelpRequest.type, {
				textDocument: { uri: document.uri.toString() },
				position: { line: position.line, character: position.character },
				context: {
					triggerKind: context.triggerKind,
					triggerCharacter: context.triggerCharacter,
					isRetrigger: context.isRetrigger,
					activeSignatureHelp: context.activeSignatureHelp,
				},
			} as any, token) as LspSignatureHelp | null | undefined;
			if (!result?.signatures?.length) return undefined;
			const help = new vscode.SignatureHelp();
			help.activeSignature = result.activeSignature ?? 0;
			help.activeParameter = result.activeParameter ?? result.signatures[help.activeSignature]?.activeParameter ?? 0;
			help.signatures = result.signatures.map((signature) => {
				const info = new vscode.SignatureInformation(signature.label);
				if (typeof signature.documentation === "string") info.documentation = new vscode.MarkdownString(signature.documentation);
				else if (signature.documentation) info.documentation = new vscode.MarkdownString(signature.documentation.value);
				info.parameters = (signature.parameters ?? []).map((parameter) => {
					const parameterInfo = new vscode.ParameterInformation(parameter.label);
					if (typeof parameter.documentation === "string") parameterInfo.documentation = new vscode.MarkdownString(parameter.documentation);
					else if (parameter.documentation) parameterInfo.documentation = new vscode.MarkdownString(parameter.documentation.value);
					return parameterInfo;
				});
				return info;
			});
			return help;
		} catch {
			return undefined;
		}
	}
}
