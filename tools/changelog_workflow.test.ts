import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

/**
 * Exercises `tools/publish_changelog.sh`, the step that publishes the generated
 * changelog. The previous implementation relied on a pull-request action, which
 * fails with "GitHub Actions is not permitted to create or approve pull
 * requests" and left tag-driven changelog updates unpublished.
 */

const SCRIPT = path.resolve(__dirname, "publish_changelog.sh");

function run(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
	const result = run("git", args, cwd);
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

interface Fixture {
	work: string;
	origin: string;
	bin: string;
	dispose: () => void;
}

/** A repository with a bare `origin`, a `master` branch and a fake `gh` CLI. */
function fixture(ghBehavior: "policy-error" | "creates-pr" | "unexpected-error"): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-changelog-publish-"));
	const origin = path.join(root, "origin.git");
	const work = path.join(root, "work");
	const bin = path.join(root, "bin");

	git(root, "init", "--bare", "--initial-branch=master", origin);
	git(root, "clone", origin, work);
	git(work, "config", "user.name", "Test");
	git(work, "config", "user.email", "test@example.invalid");
	fs.writeFileSync(
		path.join(work, "CHANGELOG.md"),
		"# Changelog\n\n<!-- generated-release-notes:start -->\nold\n<!-- generated-release-notes:end -->\n",
	);
	git(work, "add", "CHANGELOG.md");
	git(work, "commit", "-m", "chore: initial changelog");
	git(work, "push", "origin", "master");
	git(work, "fetch", "origin");

	fs.mkdirSync(bin, { recursive: true });
	const createFailure =
		ghBehavior === "policy-error"
			? 'echo "pull request create failed: GitHub Actions is not permitted to create or approve pull requests." >&2; exit 1'
			: ghBehavior === "creates-pr"
				? 'echo "https://github.com/example/repo/pull/42"; exit 0'
				: 'echo "network unreachable" >&2; exit 1';
	const listOutput = ghBehavior === "creates-pr" ? "echo ''" : "true";
	const gh = [
		"#!/usr/bin/env bash",
		"set -u",
		'case "$1 $2" in',
		`  "pr list") ${listOutput}; exit 0 ;;`,
		'  "pr create")',
		`    ${createFailure}`,
		"    ;;",
		"  *) exit 0 ;;",
		"esac",
		"",
	].join("\n");
	fs.writeFileSync(path.join(bin, "gh"), gh, { mode: 0o755 });

	return {
		work,
		origin,
		bin,
		dispose: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

/** The publish script resolves the repository from its own location. */
function installScript(repo: string): void {
	fs.mkdirSync(path.join(repo, "tools"), { recursive: true });
	fs.copyFileSync(SCRIPT, path.join(repo, "tools", "publish_changelog.sh"));
}

function publish(
	repo: string,
	bin: string,
	env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string; output: string } {
	const outputFile = path.join(repo, "step-output.txt");
	const result = run("bash", ["tools/publish_changelog.sh"], repo, {
		PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
		DEFAULT_BRANCH: "master",
		GITHUB_OUTPUT: outputFile,
		...env,
	});
	return { ...result, output: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "" };
}

const enabled = process.platform !== "win32";

describe("changelog publishing", { skip: enabled ? false : "requires bash" }, () => {
	it("commits the changelog directly when Actions may not open pull requests", () => {
		const test = fixture("policy-error");
		try {
			installScript(test.work);
			fs.writeFileSync(
				path.join(test.work, "CHANGELOG.md"),
				"# Changelog\n\n<!-- generated-release-notes:start -->\nnew\n<!-- generated-release-notes:end -->\n",
			);
			const result = publish(test.work, test.bin);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.output, /pull-request-operation=direct/);

			git(test.work, "fetch", "origin");
			assert.match(git(test.work, "show", "origin/master:CHANGELOG.md"), /new/);
			const branch = git(test.work, "branch", "--list", "--remote", "origin/automation/changelog");
			assert.notEqual(branch, "", "the reviewable bot branch is still published");
		} finally {
			test.dispose();
		}
	});

	it("keeps using a pull request when Actions is allowed to create one", () => {
		const test = fixture("creates-pr");
		try {
			installScript(test.work);
			fs.writeFileSync(
				path.join(test.work, "CHANGELOG.md"),
				"# Changelog\n\n<!-- generated-release-notes:start -->\nnew\n<!-- generated-release-notes:end -->\n",
			);
			const result = publish(test.work, test.bin);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.output, /pull-request-operation=created/);

			git(test.work, "fetch", "origin");
			assert.match(
				git(test.work, "show", "origin/master:CHANGELOG.md"),
				/old/,
				"the default branch must not be written directly",
			);
			assert.match(git(test.work, "show", "origin/automation/changelog:CHANGELOG.md"), /new/);
		} finally {
			test.dispose();
		}
	});

	it("does nothing when the changelog is already current", () => {
		const test = fixture("creates-pr");
		try {
			installScript(test.work);
			const result = publish(test.work, test.bin);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.output, /pull-request-operation=none/);
			git(test.work, "fetch", "origin");
			assert.equal(git(test.work, "branch", "--list", "--remote", "origin/automation/changelog"), "");
		} finally {
			test.dispose();
		}
	});

	it("honours CHANGELOG_DIRECT_PUSH without calling gh", () => {
		const test = fixture("unexpected-error");
		try {
			installScript(test.work);
			fs.writeFileSync(
				path.join(test.work, "CHANGELOG.md"),
				"# Changelog\n\n<!-- generated-release-notes:start -->\nnew\n<!-- generated-release-notes:end -->\n",
			);
			const result = publish(test.work, test.bin, { CHANGELOG_DIRECT_PUSH: "true" });
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.output, /pull-request-operation=direct/);
			git(test.work, "fetch", "origin");
			assert.match(git(test.work, "show", "origin/master:CHANGELOG.md"), /new/);
		} finally {
			test.dispose();
		}
	});

	it("fails loudly when pull requests fail for a reason other than the policy", () => {
		const test = fixture("unexpected-error");
		try {
			installScript(test.work);
			fs.writeFileSync(
				path.join(test.work, "CHANGELOG.md"),
				"# Changelog\n\n<!-- generated-release-notes:start -->\nnew\n<!-- generated-release-notes:end -->\n",
			);
			const result = publish(test.work, test.bin);
			assert.notEqual(result.status, 0, "unexpected failures must not silently rewrite the default branch");
			assert.match(result.stderr, /network unreachable/);
		} finally {
			test.dispose();
		}
	});
});
