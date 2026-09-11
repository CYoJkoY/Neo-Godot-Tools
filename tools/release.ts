#!/usr/bin/env ts-node
import * as fs from "node:fs";
import * as path from "node:path";

const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:\.dev(\d+))?$/;

export type ReleaseInfo = {
	tag: string;
	version: string;
	isDevelopment: boolean;
	developmentNumber?: number;
};

export function parse_release_tag(tag: string): ReleaseInfo {
	const match = TAG_PATTERN.exec(tag);
	if (!match) {
		throw new Error(`Unsupported release tag: ${tag}. Expected vX.Y.Z or vX.Y.Z.devN.`);
	}

	const version = `${match[1]}.${match[2]}.${match[3]}`;
	const developmentNumber = match[4] ? Number(match[4]) : undefined;

	return {
		tag,
		version,
		isDevelopment: developmentNumber !== undefined,
		developmentNumber,
	};
}

function set_package_version(version: string): void {
	const packagePath = path.resolve(process.cwd(), "package.json");
	const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, unknown>;
	packageJson.version = version;
	fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, "\t")}\n`);
}

function write_output(name: string, value: string): void {
	const outputPath = process.env.GITHUB_OUTPUT;
	if (!outputPath) {
		return;
	}
	fs.appendFileSync(outputPath, `${name}=${value}\n`);
}

function main(): void {
	const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
	if (!tag) {
		throw new Error("A release tag is required.");
	}

	const release = parse_release_tag(tag);
	set_package_version(release.version);

	write_output("version", release.version);
	write_output("development", String(release.isDevelopment));
	write_output("development_number", String(release.developmentNumber ?? ""));
	write_output("asset", `godot-tools-${release.tag}.vsix`);

	console.log(JSON.stringify(release, null, 2));
}

main();