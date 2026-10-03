/**
 * The part of a language client that the resource inspector and the scene
 * preview need: a way to send a request to the Godot language server.
 *
 * Keeping the dependency structural (instead of importing the client class)
 * keeps those modules testable with a tiny stub, and it documents exactly what
 * a provider may do with the client.
 */
export interface LspClientLike {
	sendRequest(method: string, params?: unknown, token?: unknown): Promise<unknown>;
}
