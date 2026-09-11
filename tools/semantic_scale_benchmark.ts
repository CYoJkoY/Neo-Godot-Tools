import { performance } from "node:perf_hooks";
import { BindingIndex, FileIndex, SymbolIndex, TypeResolutionIndex } from "../src/index/index.js";
import { SemanticQueryEngine } from "../src/language/semantic/query_engine.js";

const SCALES = [100, 500, 1_000, 5_000];

function percentile(values: number[], percentileValue: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

function sourceFor(index: number): string {
	return `class_name Synthetic${index}\nextends Node\n\nfunc get_value() -> int:\n\treturn ${index}\n\nfunc use():\n\tvar value = get_value()\n\treturn value\n`;
}

function uriFor(index: number): string {
	return `file:///synthetic/project/script_${index}.gd`;
}

for (const count of SCALES) {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const bindings = new BindingIndex(files);
	const types = new TypeResolutionIndex(files, symbols, bindings);
	const semantic = new SemanticQueryEngine(files, symbols, bindings, types);

	const coldStart = performance.now();
	for (let index = 0; index < count; index++) {
		const uri = uriFor(index);
		files.update(uri, sourceFor(index), 1);
		symbols.update(uri);
		bindings.update(uri);
	}
	const cold = performance.now() - coldStart;

	const targetUri = uriFor(Math.floor(count / 2));
	const target = files.get(targetUri);
	if (!target) throw new Error(`missing benchmark target: ${targetUri}`);
	const valueOffset = target.source.lastIndexOf("value") + 2;

	const editSamples: number[] = [];
	for (let iteration = 0; iteration < 10; iteration++) {
		const start = performance.now();
		files.update(targetUri, `${target.source}\n# edit ${iteration}\n`, iteration + 2);
		symbols.update(targetUri);
		bindings.update(targetUri);
		types.invalidate([targetUri]);
		semantic.invalidate([targetUri]);
		editSamples.push(performance.now() - start);
	}

	const querySamples: number[] = [];
	for (let iteration = 0; iteration < 30; iteration++) {
		const start = performance.now();
		semantic.getType(targetUri, { offset: valueOffset });
		querySamples.push(performance.now() - start);
	}

	console.log(JSON.stringify({
		files: count,
		coldIndexMs: Number(cold.toFixed(2)),
		singleEditMs: {
			p50: Number(percentile(editSamples, 50).toFixed(2)),
			p95: Number(percentile(editSamples, 95).toFixed(2)),
			p99: Number(percentile(editSamples, 99).toFixed(2)),
		},
		semanticTypeQueryMs: {
			p50: Number(percentile(querySamples, 50).toFixed(2)),
			p95: Number(percentile(querySamples, 95).toFixed(2)),
			p99: Number(percentile(querySamples, 99).toFixed(2)),
		},
	}));
}
