import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildChangelog, compareReleases, GENERATED_END, GENERATED_START } from "./changelog";
import { parse_release_tag } from "./release";

const MANUAL = "# Changelog\n\n## Unreleased\n\n- Keep this draft.\n\n### 1.0.0\n\n- Hand-written historical notes.\n";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function fixture(run: (cwd: string, commit: (subject: string) => string) => void): void {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-changelog-"));
	try {
		git(cwd, "init", "--initial-branch=arena/01a0fe1a-neo-godot-tools");
		git(cwd, "config", "user.name", "Changelog Test");
		git(cwd, "config", "user.email", "changelog@example.invalid");
		let counter = 0;
		const commit = (subject: string) => {
			fs.writeFileSync(path.join(cwd, "file.txt"), String(++counter));
			git(cwd, "add", "file.txt");
			git(cwd, "commit", "--allow-empty-message", "-m", subject);
			return git(cwd, "rev-parse", "HEAD");
		};
		run(cwd, commit);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

describe("tag-based changelog", () => {
	it("orders stable and development tags numerically", () => {
		const compare = (a: string, b: string) => compareReleases(parse_release_tag(a), parse_release_tag(b));
		assert.ok(compare("v2.10.0", "v2.9.99") > 0);
		assert.ok(compare("v2.12.0.dev10", "v2.12.0.dev2") > 0);
		assert.ok(compare("v2.12.0", "v2.12.0.dev10") > 0);
		assert.equal(compare("v2.8.1.dev01", "v2.8.1.dev1"), 0);
	});

	it("covers a multi-commit tag range and preserves manual notes idempotently", () =>
		fixture((cwd, commit) => {
			commit("feat: original version");
			git(cwd, "tag", "v1.0.0");
			commit("feat(inspector): add image previews (#101)");
			commit("fix(inspector): fix overlapping controls");
			commit("perf(parser): reduce parse allocations");
			commit("chore(package): bump version to 1.1.0");
			git(cwd, "tag", "-a", "v1.1.0", "-m", "Release 1.1.0");
			const result = buildChangelog(MANUAL, { cwd });
			assert.ok(result.content.includes("add image previews"));
			assert.ok(result.content.includes("fix overlapping controls"));
			assert.ok(result.content.includes("reduce parse allocations"));
			assert.ok(result.content.includes("/pull/101"));
			assert.ok(!result.content.includes("bump version"));
			assert.ok(result.content.includes("- Keep this draft."));
			assert.ok(result.content.endsWith("### 1.0.0\n\n- Hand-written historical notes.\n"));
			assert.equal(buildChangelog(result.content, { cwd }).content, result.content);
		}));

	it("generates pending release notes on a package version bump before the tag exists", () =>
		fixture((cwd, commit) => {
			commit("feat: original release");
			git(cwd, "tag", "v1.0.0");
			commit("feat(resources): add resource arrays");
			commit("chore(package): bump version to 1.1.0");

			const pending = buildChangelog(MANUAL, { cwd, pendingVersion: "1.1.0" });
			assert.match(pending.content, /### 1\.1\.0 — .* \(pending\)/);
			assert.match(pending.content, /resource arrays/);
			assert.ok(!pending.content.includes("bump version"));
			assert.ok(!buildChangelog(MANUAL, { cwd }).content.includes("### 1.1.0"));
			assert.match(pending.notes.get("v1.1.0") ?? "", /resource arrays/);

			git(cwd, "tag", "v1.1.0");
			const released = buildChangelog(pending.content, { cwd, pendingVersion: "1.1.0" });
			assert.match(released.content, /### 1\.1\.0 —/);
			assert.ok(!released.content.includes("(pending)"));
			assert.equal((released.content.match(/### 1\.1\.0 —/g) ?? []).length, 1);
		}));

	it("uses changed files as a fallback for an empty commit subject", () =>
		fixture((cwd, commit) => {
			commit("feat: base");
			git(cwd, "tag", "v1.0.0");
			const hash = commit("");
			git(cwd, "tag", "v1.1.0");
			const body = buildChangelog(MANUAL, { cwd }).notes.get("v1.1.0") ?? "";
			assert.match(body, /Update file.txt/);
			assert.ok(body.includes(`/commit/${hash}`), "keep the complete hash, including its final digit");
		}));

	it("reassigns commits after deleted tags and recomputes moved tags", () =>
		fixture((cwd, commit) => {
			commit("feat: original");
			git(cwd, "tag", "v1.0.0");
			commit("feat: middle feature");
			git(cwd, "tag", "v1.1.0");
			commit("fix: latest fix");
			git(cwd, "tag", "v1.2.0");
			const original = buildChangelog(MANUAL, { cwd });
			assert.match(original.notes.get("v1.2.0") ?? "", /since \[v1.1.0\]/);
			git(cwd, "tag", "-d", "v1.1.0");
			const deleted = buildChangelog(original.content, { cwd });
			assert.ok(!deleted.content.includes("### 1.1.0"));
			assert.match(deleted.notes.get("v1.2.0") ?? "", /since \[v1.0.0\]/);
			assert.match(deleted.notes.get("v1.2.0") ?? "", /middle feature/);
			commit("fix: retagged change");
			git(cwd, "tag", "-f", "v1.2.0");
			assert.match(buildChangelog(deleted.content, { cwd }).notes.get("v1.2.0") ?? "", /retagged change/);
			git(cwd, "tag", "-d", "v1.2.0");
			const removed = buildChangelog(deleted.content, { cwd });
			assert.ok(!removed.content.includes("### 1.2.0"));
			assert.ok(removed.content.includes("Hand-written historical notes."));
		}));

	it("keeps stable notes cumulative across development tags", () =>
		fixture((cwd, commit) => {
			commit("feat: base");
			git(cwd, "tag", "v1.0.0");
			commit("feat: dev feature");
			git(cwd, "tag", "v1.1.0.dev2");
			commit("fix: dev fix");
			git(cwd, "tag", "v1.1.0.dev10");
			git(cwd, "tag", "v1.1.0");
			const result = buildChangelog(MANUAL, { cwd });
			const dev = result.notes.get("v1.1.0.dev10") ?? "";
			assert.match(dev, /since \[v1.1.0.dev2\]/);
			assert.ok(!dev.includes("dev feature"));
			assert.match(result.notes.get("v1.1.0") ?? "", /dev feature/);
			assert.match(result.notes.get("v1.1.0") ?? "", /dev fix/);
			assert.match(result.notes.get("v1.1.0") ?? "", /since \[v1.0.0\]/);
		}));

	it("does not use sibling branch tags as a previous release", () =>
		fixture((cwd, commit) => {
			const base = commit("feat: base");
			git(cwd, "tag", "v1.0.0");
			commit("fix: actual release change");
			git(cwd, "tag", "v1.1.0");
			// Construct a sibling commit without switching the working branch.
			const tree = git(cwd, "rev-parse", "HEAD^{tree}");
			const sibling = git(cwd, "commit-tree", tree, "-p", base, "-m", "fix: unrelated branch");
			git(cwd, "tag", "v1.0.9", sibling);
			const notes = buildChangelog(MANUAL, { cwd }).notes.get("v1.1.0") ?? "";
			assert.match(notes, /since \[v1.0.0\]/);
			assert.ok(!notes.includes("unrelated branch"));
			assert.ok(notes.includes("actual release change"));
		}));

	it("excludes future tags when building an older release artifact", () =>
		fixture((cwd, commit) => {
			commit("feat: base");
			git(cwd, "tag", "v1.0.0");
			commit("fix: old release");
			git(cwd, "tag", "v1.1.0");
			commit("feat: future release");
			git(cwd, "tag", "v2.0.0");
			git(cwd, "tag", "v1.2.0", "v1.0.0"); // A later version reusing an old commit.
			const result = buildChangelog(MANUAL, { cwd, ref: "v1.1.0", notesTag: "v1.1.0" });
			assert.ok(!result.content.includes("### 2.0.0"));
			assert.ok(!result.content.includes("### 1.2.0"));
			assert.ok(!buildChangelog(MANUAL, { cwd, ref: "refs/tags/v1.1.0" }).content.includes("### 1.2.0"));
			assert.throws(
				() => buildChangelog(MANUAL, { cwd, ref: "v1.1.0", notesTag: "v1.2.0" }),
				/requested release version/,
			);
			assert.ok(!result.content.includes("future release"));
			assert.throws(() => buildChangelog(MANUAL, { cwd, ref: "v1.1.0", notesTag: "v2.0.0" }), /not reachable/);
		}));

	it("handles a missing historical anchor without deleting the manual archive", () =>
		fixture((cwd, commit) => {
			commit("feat: untagged base");
			commit("fix: released fix");
			git(cwd, "tag", "v1.1.0");
			git(cwd, "tag", "not-a-release");
			const result = buildChangelog(MANUAL, { cwd });
			assert.match(result.notes.get("v1.1.0") ?? "", /no earlier reachable release tag/);
			assert.match(result.content, /Hand-written historical notes/);
			assert.ok(!result.content.includes("not-a-release"));
		}));

	it("fails safely on broken markers or shallow history", () =>
		fixture((cwd, commit) => {
			commit("feat: base");
			git(cwd, "tag", "v1.0.0");
			commit("fix: latest");
			git(cwd, "tag", "v1.1.0");
			assert.throws(() => buildChangelog(MANUAL + GENERATED_START, { cwd }), /refusing to overwrite/);
			assert.throws(
				() => buildChangelog(MANUAL + GENERATED_START + GENERATED_START + GENERATED_END, { cwd }),
				/refusing to overwrite/,
			);
			assert.throws(
				() => buildChangelog(MANUAL + GENERATED_START + GENERATED_END + GENERATED_END, { cwd }),
				/refusing to overwrite/,
			);
			assert.throws(
				() => buildChangelog(GENERATED_END + MANUAL + GENERATED_START, { cwd }),
				/refusing to overwrite/,
			);
			const shallow = path.join(cwd, "shallow");
			git(cwd, "clone", "--depth=1", `file://${cwd}`, shallow);
			assert.throws(() => buildChangelog(MANUAL, { cwd: shallow }), /full Git history/);
		}));

	it("writes a release body and makes --check detect stale output", () =>
		fixture((cwd, commit) => {
			commit("feat: base");
			git(cwd, "tag", "v1.0.0");
			commit("fix: published change");
			git(cwd, "tag", "v1.1.0");
			fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), MANUAL);
			const root = path.resolve(__dirname, "..");
			const cli = (...args: string[]) =>
				spawnSync(
					process.execPath,
					["-r", require.resolve("ts-node/register"), path.join(root, "tools/changelog.ts"), ...args],
					{
						cwd,
						encoding: "utf8",
						env: { ...process.env, TS_NODE_PROJECT: path.join(root, "tsconfig.json") },
					},
				);
			assert.equal(cli("--check").status, 1);
			const generated = cli("--tag", "v1.1.0", "--ref", "v1.1.0", "--notes-file", "notes.md");
			assert.equal(generated.status, 0, generated.stderr);
			assert.match(fs.readFileSync(path.join(cwd, "notes.md"), "utf8"), /published change/);
			assert.equal(cli("--check").status, 0);
			assert.equal(cli("--notes-file", "notes.md").status, 1);
		}));

	it("reads the pending release version from package.json in the CLI", () =>
		fixture((cwd, commit) => {
			commit("feat: current stable release");
			git(cwd, "tag", "v1.0.0");
			commit("feat: package-version feature");
			fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version: "1.1.0" }));
			fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), MANUAL);
			const root = path.resolve(__dirname, "..");
			const generated = spawnSync(
				process.execPath,
				["-r", require.resolve("ts-node/register"), path.join(root, "tools/changelog.ts"), "--pending-version"],
				{
					cwd,
					encoding: "utf8",
					env: { ...process.env, TS_NODE_PROJECT: path.join(root, "tsconfig.json") },
				},
			);
			assert.equal(generated.status, 0, generated.stderr);
			const changelog = fs.readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8");
			assert.ok(changelog.includes("### 1.1.0 —") && changelog.includes("(pending)"));
		}));

	it("triggers changelog synchronization on package version changes, not tags", () => {
		const root = path.resolve(__dirname, "..");
		const workflow = fs.readFileSync(path.join(root, ".github/workflows/changelog.yml"), "utf8");
		assert.match(workflow, /push:\n\s+paths:\n\s+- "package\.json"/);
		assert.match(workflow, /Check whether package version changed/);
		assert.match(workflow, /--pending-version/);
		assert.doesNotMatch(workflow, /tags:/);
		assert.doesNotMatch(workflow, /^\s+delete:\s*$/m);

		const releaseWorkflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
		assert.ok(
			releaseWorkflow.indexOf("npm run changelog") < releaseWorkflow.indexOf("- name: Package VSIX"),
			"the release workflow must refresh CHANGELOG.md before packaging the VSIX",
		);
		const packageIgnore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
		assert.ok(
			packageIgnore.split(/\r?\n/).includes("!CHANGELOG.md"),
			"the VSIX package must include the generated changelog",
		);
	});
});
