import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Resolves the path to a fgvm-managed Godot executable for a given version.
 *
 * fgvm may place installations directly under $FGVM_HOME/installations or,
 * depending on the installation layout, under $FGVM_HOME/fgvm/installations.
 * We probe both layouts so CI and local fgvm installations use the same resolver.
 */
function get_fgvm_installations_dirs(): string[] {
	const env = process.env.FGVM_HOME;
	if (env) {
		return [path.join(env, "installations"), path.join(env, "fgvm", "installations")];
	}

	return [path.join(os.homedir(), "fgvm", "installations")];
}

/**
 * The platform-specific subdirectory and executable glob pattern.
 * fgvm uses different directory names and executable patterns per OS.
 */
function get_platform_pattern(): { dir: string; glob: string } {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "win32" && arch === "x64") {
		return { dir: "win64.exe", glob: "Godot_v*_win64.exe" };
	}
	if (platform === "darwin" && arch === "arm64") {
		return { dir: "osx.arm64", glob: "Godot_v*osx.universal" };
	}
	if (platform === "darwin" && arch === "x64") {
		return { dir: "osx.x86_64", glob: "Godot_v*osx.universal" };
	}
	if (platform === "linux" && arch === "x64") {
		return { dir: "linux.x86_64", glob: "Godot_v*_linux.x86_64" };
	}
	if (platform === "linux" && arch === "arm64") {
		return { dir: "linux.arm64", glob: "Godot_v*_linux.arm64" };
	}

	throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Find a fgvm-managed Godot executable by version.
 *
 * @param version Version query, e.g. "4.7", "3.6.2"
 * @returns Absolute path to the Godot executable
 * @throws If no matching installation is found
 */
export function resolve_godot_binary(version: string): string {
	const installationsDirs = get_fgvm_installations_dirs();
	const installationsDir = installationsDirs.find((candidate) => fs.existsSync(candidate));

	if (!installationsDir) {
		throw new Error(`fgvm installations directory not found. Checked: ${installationsDirs.join(", ")}`);
	}

	const prefix = `${version}-stable-`;
	const candidates = fs
		.readdirSync(installationsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
		.map((entry) => entry.name);

	if (candidates.length === 0) {
		throw new Error(
			`No fgvm installation found for version "${version}". ` +
				`Run: fgvm install ${version}`,
		);
	}

	if (candidates.length > 1) {
		throw new Error(
			`Multiple installations found for version "${version}": ${candidates.join(", ")}`,
		);
	}

	const installDir = path.join(installationsDir, candidates[0]);
	const { dir: platformDir } = get_platform_pattern();
	const platformPath = path.join(installDir, platformDir);

	if (!fs.existsSync(platformPath)) {
		throw new Error(`Platform directory not found: ${platformPath}`);
	}

	const executables = fs
		.readdirSync(platformPath)
		.filter((file) => file.match(/^Godot_v.*(_win64\.exe|osx\.universal|linux\.x86_64|linux\.arm64)$/))
		.filter((file) => !file.includes("_console."));

	if (executables.length === 0) {
		throw new Error(`No Godot executable found in ${platformPath}`);
	}

	return path.join(platformPath, executables[0]);
}
