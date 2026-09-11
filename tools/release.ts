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

function read_package_version(): string {
	const packagePath = path.resolve(process.cwd(), "package.json");
	const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, unknown>;
	const version = packageJson.version;

	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`package.json version must be a clean X.Y.Z version, got: ${String(version)}`);
	}

	return version;
}

function validate_package_version(release: ReleaseInfo, packageVersion: string): void {
	if (release.version !== packageVersion) {
		throw new Error(
			`Release tag ${release.tag} does not match package.json version ${packageVersion}. ` +
			`Expected ${release.version}.`,
		);
	}
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
	const packageVersion = read_package_version();
	validate_package_version(release, packageVersion);

	write_output("version", packageVersion);
	write_output("development", String(release.isDevelopment));
	write_output("development_number", String(release.developmentNumber ?? ""));
	write_output("asset", `godot-tools-${release.tag}.vsix`);

	console.log(JSON.stringify({ ...release, packageVersion }, null, 2));
}

main();
