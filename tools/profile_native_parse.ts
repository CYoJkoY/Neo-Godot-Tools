#!/usr/bin/env ts-node
import { deepStrictEqual } from "node:assert";
import { performance } from "node:perf_hooks";

import { parseGDScript } from "../src/analyzer/parser.js";
import { type ZigBackend, createZigBackend } from "../src/backend/zig_backend.js";

interface CorpusCase {
	readonly name: string;
	readonly source: string;
}

interface Measurement {
	readonly p50ms: number;
	readonly p95ms: number;
	readonly throughputPerSecond: number;
}

interface NativeSample {
	readonly times: readonly number[];
	readonly elapsedMs: number;
}

interface ProfiledCase {
	readonly startupAndFirstParseMs: number;
	readonly result: Readonly<Record<string, unknown>>;
}

interface ProfileState {
	readonly startupAndFirstParseMs: number | undefined;
	readonly results: readonly Readonly<Record<string, unknown>>[];
}

const buildTypicalSource = (index: number): string =>
	[
		`class_name Profile${index}`,
		"extends Node",
		"",
		"signal changed(value: int)",
		"const MAX_VALUE: int = 100",
		"var health: int = MAX_VALUE",
		`var label: String = "profile-${index}"`,
		"",
		"func update_value(value: int, amount: int = 1) -> int:",
		"\tvar next_value: int = value + amount",
		"\tif next_value > MAX_VALUE:",
		"\t\tnext_value = MAX_VALUE",
		"\treturn next_value",
		"",
		"func reset() -> void:",
		"\thealth = MAX_VALUE",
		"\tchanged.emit(health)",
		"",
	].join("\n");

const generatedVariables = (declarations: number): readonly string[] =>
	Array.from({ length: declarations }, (_unused, index) => `var field_${index}: int = ${index}`);

const generatedMethods = (declarations: number): readonly string[] =>
	Array.from({ length: declarations }, (_unused, index) =>
		[
			`func method_${index}(value: int, amount: int = ${index}) -> int:`,
			"\tvar next_value: int = value + amount",
			"\treturn next_value",
			"",
		].join("\n"),
	);

const buildGeneratedSource = (declarations: number): string =>
	[
		"class_name Generated",
		"extends Node",
		"",
		...generatedVariables(declarations),
		...generatedMethods(declarations),
	].join("\n");

const percentile = (values: readonly number[], fraction: number): number => {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

const summarize = (times: readonly number[], elapsedMs: number): Measurement => ({
	p50ms: Number(percentile(times, 0.5).toFixed(4)),
	p95ms: Number(percentile(times, 0.95).toFixed(4)),
	throughputPerSecond: Number((times.length / (elapsedMs / 1000)).toFixed(2)),
});

const measureTypeScript = (source: string, iterations: number, warmup: number): Measurement => {
	Array.from({ length: warmup }, () => parseGDScript(source));
	const started = performance.now();
	const times = Array.from({ length: iterations }, () => {
		const parseStarted = performance.now();
		parseGDScript(source);
		return performance.now() - parseStarted;
	});
	return summarize(times, performance.now() - started);
};

const repeatSequentially = async (times: number, action: () => Promise<unknown>): Promise<void> => {
	await Array.from({ length: times }).reduce<Promise<unknown>>(
		(pending) => pending.then(() => action()),
		Promise.resolve(undefined),
	);
};

const measureNative = async (
	backend: ZigBackend,
	source: string,
	iterations: number,
	warmup: number,
): Promise<NativeSample> => {
	await repeatSequentially(warmup, () => backend.parse(source));
	const started = performance.now();
	const times = await Array.from({ length: iterations }).reduce<Promise<readonly number[]>>(
		(pending) =>
			pending.then(async (collected) => {
				const parseStarted = performance.now();
				await backend.parse(source);
				return [...collected, performance.now() - parseStarted];
			}),
		Promise.resolve<readonly number[]>([]),
	);
	return { times, elapsedMs: performance.now() - started };
};

const profileCase = async (
	backend: ZigBackend,
	entry: CorpusCase,
	iterations: number,
	warmup: number,
): Promise<ProfiledCase> => {
	const expected = parseGDScript(entry.source);
	const firstParseStarted = performance.now();
	const firstNative = await backend.parse(entry.source);
	const startupAndFirstParseMs = performance.now() - firstParseStarted;
	deepStrictEqual(firstNative, expected, `${entry.name} native result must match parseGDScript`);

	const native = await measureNative(backend, entry.source, iterations, warmup);
	const typeScript = measureTypeScript(entry.source, iterations, warmup);
	const nativeSummary = summarize(native.times, native.elapsedMs);
	return {
		startupAndFirstParseMs,
		result: {
			case: entry.name,
			utf16CodeUnits: entry.source.length,
			iterations,
			warmup,
			typeScript,
			nativeEndToEnd: nativeSummary,
			nativeSpeedupP50: Number((typeScript.p50ms / nativeSummary.p50ms).toFixed(3)),
		},
	};
};

const fail = (message: string): Promise<void> => Promise.reject(new Error(message));

const profileCorpus = async (
	backend: ZigBackend,
	cases: readonly CorpusCase[],
	iterations: number,
	warmup: number,
): Promise<ProfileState> =>
	cases.reduce<Promise<ProfileState>>(
		(pending, entry) =>
			pending.then(async (state) => {
				const profiled = await profileCase(backend, entry, iterations, warmup);
				return {
					startupAndFirstParseMs: state.startupAndFirstParseMs ?? profiled.startupAndFirstParseMs,
					results: [...state.results, profiled.result],
				};
			}),
		Promise.resolve<ProfileState>({ startupAndFirstParseMs: undefined, results: [] }),
	);

const parseIterationSetting = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);

async function main(): Promise<void> {
	const iterations = parseIterationSetting("PROFILE_ITERATIONS", 40);
	const warmup = parseIterationSetting("PROFILE_WARMUP", 10);
	if (!Number.isInteger(iterations) || iterations < 1) {
		return fail("PROFILE_ITERATIONS must be a positive integer.");
	}
	if (!Number.isInteger(warmup) || warmup < 0) {
		return fail("PROFILE_WARMUP must be a non-negative integer.");
	}

	const cases: readonly CorpusCase[] = [
		{ name: "typical-script", source: buildTypicalSource(0) },
		{ name: "generated-64", source: buildGeneratedSource(64) },
		{ name: "generated-512", source: buildGeneratedSource(512) },
		{ name: "generated-2048", source: buildGeneratedSource(2048) },
	];

	const backend = createZigBackend();
	try {
		const profile = await profileCorpus(backend, cases, iterations, warmup);
		console.log(
			JSON.stringify(
				{
					node: process.version,
					platform: process.platform,
					startupAndFirstParseMs: Number((profile.startupAndFirstParseMs ?? 0).toFixed(4)),
					results: profile.results,
				},
				null,
				2,
			),
		);
	} finally {
		await backend.shutdown();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
