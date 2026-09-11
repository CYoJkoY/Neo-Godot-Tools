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
	return `class_name Synthetic${index}\nextends Node\n\nvar value: int = ${index}\n\nfunc get_value() -> int:\n\treturn value\n\nfunc use():\n\tvar local_value := get_value()\n\treturn local_value\n`;
}

function uriFor(index: number): string {
	return `file:///synthetic/project/script_${index}.gd`;
}

function report(values: number[]): { p50: number; p95: number; p99: number } {
	return {
		p50: Number(percentile(values, 50).toFixed(2)),
		p95: Number(percentile(values, 95).toFixed(2)),
		p99: Number(percentile(values, 99).toFixed(2)),
	};
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
	const valueOffset = target.source.indexOf("local_value :=") + "local_value".length;
	const completionOffset = target.source.length;

	const editSamples: number[] = [];
	for (let iteration = 0; iteration < 20; iteration++) {
		const start = performance.now();
		const edited = `${target.source}\n# edit ${iteration}\n`;
		files.update(targetUri, edited, iteration + 2);
		symbols.update(targetUri);
		bindings.update(targetUri);
		types.invalidate([targetUri]);
		semantic.invalidate([targetUri]);
		editSamples.push(performance.now() - start);
	}

	const querySamples = {
		type: [] as number[],
		definition: [] as number[],
		hover: [] as number[],
		completion: [] as number[],
	};
	semantic.getType(targetUri, { offset: valueOffset });
	semantic.getDefinition(targetUri, { offset: valueOffset });
	semantic.getHover(targetUri, { offset: valueOffset });
	semantic.getCompletions(targetUri, { offset: completionOffset });
	for (let iteration = 0; iteration < 50; iteration++) {
		let start = performance.now();
		semantic.getType(targetUri, { offset: valueOffset });
		querySamples.type.push(performance.now() - start);
		start = performance.now();
		semantic.getDefinition(targetUri, { offset: valueOffset });
		querySamples.definition.push(performance.now() - start);
		start = performance.now();
		semantic.getHover(targetUri, { offset: valueOffset });
		querySamples.hover.push(performance.now() - start);
		start = performance.now();
		semantic.getCompletions(targetUri, { offset: completionOffset });
		querySamples.completion.push(performance.now() - start);
	}

	console.log(JSON.stringify({
		files: count,
		coldIndexMs: Number(cold.toFixed(2)),
		singleEditMs: report(editSamples),
		semanticMs: {
			type: report(querySamples.type),
			definition: report(querySamples.definition),
			hover: report(querySamples.hover),
			completion: report(querySamples.completion),
		},
	}));
}
