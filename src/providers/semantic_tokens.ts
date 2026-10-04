import * as vscode from "vscode";
import type {
	CancellationToken,
	DocumentSemanticTokensProvider,
	ExtensionContext,
	Range,
	SemanticTokens,
	TextDocument,
} from "vscode";
import { RESOURCE_SELECTOR } from "./selectors";

const LEGEND = ["nodePath", "%"];

/**
 * The string literal handed to a node lookup, e.g. the `"Player/Camera"` in
 * `get_node("Player/Camera")`. The lookbehind keeps the match on the literal.
 */
const NODE_PATH_PATTERN =
	/(?<=(?:get_node|has_node|find_node|get_node_or_null|has_node_and_resource)\(\s?)(("|')((?!\2).)*\2)(?=\s?\))/g;

export type GDSemanticTokensProvider = DocumentSemanticTokensProvider;

function makeRange(document: TextDocument, match: RegExpMatchArray): Range {
	const startIndex = match.index ?? 0;
	return new vscode.Range(document.positionAt(startIndex), document.positionAt(startIndex + match[0].length));
}

export function createSemanticTokensProvider(context: ExtensionContext): GDSemanticTokensProvider {
	const legend = new vscode.SemanticTokensLegend(LEGEND, ["test"]);
	const provider: GDSemanticTokensProvider = {
		provideDocumentSemanticTokens(document, _token: CancellationToken): SemanticTokens {
			const builder = new vscode.SemanticTokensBuilder(legend);
			Array.from(document.getText().matchAll(NODE_PATH_PATTERN), (match) =>
				builder.push(makeRange(document, match), "nodePath", []),
			);
			return builder.build();
		},
	};
	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider(RESOURCE_SELECTOR, provider, legend),
	);
	return provider;
}
