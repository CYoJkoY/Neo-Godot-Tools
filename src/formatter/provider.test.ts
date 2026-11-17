import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { FormattingProvider, formatterEnabled } from "./formatter.js";

interface StubSurface {
	__configuration: Record<string, unknown>;
	__fireConfigurationChange: (section: string) => void;
	__formattingProviders: Array<{ selector: unknown; provider: unknown }>;
}

const stub = vscode as unknown as StubSurface;
const SETTING = "neoGodotTools.formatter.enabled";

/**
 * Runs `run` against a fresh provider with the setting in `enabled`, then
 * releases the context subscriptions so registrations do not leak between
 * cases. `undefined` leaves the setting unset, which is the default.
 */
function withFormatter(enabled: boolean | undefined, run: (provider: FormattingProvider) => void): void {
	const previous = stub.__configuration[SETTING];
	if (enabled === undefined) delete stub.__configuration[SETTING];
	else stub.__configuration[SETTING] = enabled;

	const context = {
		subscriptions: [],
		extensionUri: vscode.Uri.file("."),
	} as unknown as vscode.ExtensionContext;
	const provider = new FormattingProvider(context);

	try {
		run(provider);
	} finally {
		for (const subscription of context.subscriptions) subscription.dispose();
		if (previous === undefined) delete stub.__configuration[SETTING];
		else stub.__configuration[SETTING] = previous;
	}
}

/** Registrations seen by the stub, which drops them when they are disposed. */
function registrationCount(): number {
	return stub.__formattingProviders.length;
}

describe("GDScript formatter registration", () => {
	it("registers for GDScript when the setting is unset", () => {
		withFormatter(undefined, (provider) => {
			assert.equal(formatterEnabled(), true);
			assert.equal(provider.registered, true);
			assert.equal(registrationCount(), 1);
		});
		assert.equal(registrationCount(), 0);
	});

	it("stays unregistered when the formatter is disabled", () => {
		withFormatter(false, (provider) => {
			assert.equal(formatterEnabled(), false);
			assert.equal(provider.registered, false);
			assert.equal(registrationCount(), 0);
		});
	});

	it("follows the setting without a window reload", () => {
		withFormatter(true, (provider) => {
			assert.equal(provider.registered, true);

			stub.__configuration[SETTING] = false;
			stub.__fireConfigurationChange(SETTING);
			assert.equal(provider.registered, false);
			assert.equal(registrationCount(), 0);

			stub.__configuration[SETTING] = true;
			stub.__fireConfigurationChange(SETTING);
			assert.equal(provider.registered, true);
			assert.equal(registrationCount(), 1);
		});
		assert.equal(registrationCount(), 0);
	});

	it("ignores changes to unrelated formatter settings", () => {
		withFormatter(true, (provider) => {
			stub.__fireConfigurationChange("neoGodotTools.formatter.maxLineLength");
			assert.equal(provider.registered, true);
			assert.equal(registrationCount(), 1);
		});
	});
});
