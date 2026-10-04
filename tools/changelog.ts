#!/usr/bin/env ts-node
/** Rebuilds tag-based notes from live Git refs; does not depend on GitHub releases. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse_release_tag, ReleaseInfo } from "./release";

export const GENERATED_START = "<!-- generated-release-notes:start -->";
export const GENERATED_END = "<!-- generated-release-notes:end -->";
const REPOSITORY_URL = "https://github.com/CYoJkoY/Neo-Godot-Tools";
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:\.dev\d+)?$/;

interface GitTag extends ReleaseInfo {
	hash: string;
	date: string;
	pending?: boolean;
}

export interface ChangelogOptions {
	cwd?: string;
	/** Restrict packaged notes to tags reachable from this release, not future tags. */
	ref?: string;
	/** Generate a standalone release body even for a manually documented old tag. */
	notesTag?: string;
	/** Add draft notes for a package version before its release tag is pushed. */
	pendingVersion?: string;
	/** Commit to use as the draft release target; defaults to HEAD. */
	pendingRef?: string;
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error?.message}`);
	return result.stdout.replace(/\r?\n$/, "");
}

function isAncestor(cwd: string, ancestor: string, target: string): boolean {
	const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, target], { cwd, encoding: "utf8" });
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(`Cannot compare tag ancestry: ${result.stderr || result.error?.message}`);
}

/** Development tags sort numerically, before the stable tag of the same version. */
export function compareReleases(left: ReleaseInfo, right: ReleaseInfo): number {
	const a = left.version.split(".").map(Number);
	const b = right.version.split(".").map(Number);
	for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
	if (left.isDevelopment !== right.isDevelopment) return left.isDevelopment ? -1 : 1;
	return (left.developmentNumber ?? 0) - (right.developmentNumber ?? 0);
}

function readTags(cwd: string): GitTag[] {
	if (git(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") {
		throw new Error("Changelog generation requires full Git history. Fetch with --unshallow and --tags first.");
	}
	return git(cwd, ["for-each-ref", "--format=%(refname:strip=2)%09%(creatordate:short)", "refs/tags"])
		.split("\n")
		.filter((line) => RELEASE_TAG.test(line.split("\t")[0]))
		.map((line) => {
			const [tag, date] = line.split("\t");
			return { ...parse_release_tag(tag), date, hash: git(cwd, ["rev-parse", "--verify", `${tag}^{commit}`]) };
		})
		.sort(compareReleases);
}

function previousTag(cwd: string, target: GitTag, tags: GitTag[]): GitTag | undefined {
	return tags
		.slice()
		.reverse()
		.find(
			(candidate) =>
				compareReleases(candidate, target) < 0 &&
				(target.isDevelopment || !candidate.isDevelopment) &&
				isAncestor(cwd, candidate.hash, target.hash),
		);
}

/**
 * Builds the draft entry for the version currently declared in package.json.
 * This lets the changelog land with the version bump, before release tagging
 * triggers VSIX packaging. Once the tag exists, the real tag replaces it.
 */
function pendingRelease(cwd: string, version: string, tags: GitTag[], ref?: string): GitTag | undefined {
	const release = parse_release_tag(`v${version}`);
	const matchingTag = tags.find((tag) => tag.tag === release.tag);
	if (matchingTag) return undefined;

	const hash = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref ?? "HEAD"}^{commit}`]);
	const prior = tags
		.filter((tag) => !tag.isDevelopment && isAncestor(cwd, tag.hash, hash))
		.sort(compareReleases)
		.at(-1);
	if (prior && compareReleases(release, prior) <= 0) return undefined;

	return { ...release, hash, date: git(cwd, ["show", "-s", "--format=%cs", hash]), pending: true };
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_\[\]<>|]/g, "\\$&");
}

function releaseBody(cwd: string, target: GitTag, tags: GitTag[]): string {
	// Stable releases compare with a stable ancestor, including every intervening
	// development commit. A dev release may compare with an earlier reachable dev.
	// Version ordering alone is insufficient: sibling branch tags are not a base.
	const previous = previousTag(cwd, target, tags);
	const range = previous ? `${previous.hash}..${target.hash}` : target.hash;
	const commits = git(cwd, ["log", "--reverse", "--no-merges", "--format=%H%x09%s", range, "--"]);
	const groups = new Map<string, string[]>();
	for (const line of commits ? commits.split("\n") : []) {
		const separator = line.indexOf("\t");
		const hash = line.slice(0, separator);
		const subject = line.slice(separator + 1).trim();
		// Source-version bookkeeping and this bot's own commits are not release features.
		if (
			/^(?:chore|build)(?:\([^)]*\))?:\s*bump\b.*\bversion\b/i.test(subject) ||
			subject === "docs(changelog): refresh tag-based release notes" ||
			subject === "docs(changelog): update changelog [skip ci]"
		)
			continue;
		const conventional = subject.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/);
		const type = conventional?.[1]?.toLowerCase();
		const category =
			type === "feat"
				? "Added"
				: type === "fix" || /^fix\b/i.test(subject)
					? "Fixed"
					: type === "perf"
						? "Performance"
						: type === "docs"
							? "Documentation"
							: ["chore", "ci", "build", "test", "refactor"].includes(type ?? "")
								? "Maintenance"
								: "Changed";
		const description =
			(conventional?.[4] ?? subject) ||
			`Update ${git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", hash]).split("\n").filter(Boolean).join(", ") || "files"}`;
		const pr = description.match(/\s*\(#(\d+)\)\s*$/);
		const label = escapeMarkdown(pr ? description.slice(0, pr.index).trim() : description);
		const link = pr
			? `[#${pr[1]}](${REPOSITORY_URL}/pull/${pr[1]})`
			: `[${hash.slice(0, 7)}](${REPOSITORY_URL}/commit/${hash})`;
		const scope = conventional?.[2] ? `**${escapeMarkdown(conventional[2])}:** ` : "";
		const breaking = conventional?.[3] ? "**Breaking:** " : "";
		const items = groups.get(category) ?? [];
		items.push(`- ${breaking}${scope}${label} (${link})`);
		groups.set(category, items);
	}
	const parts = [
		previous
			? `Changes since [${previous.tag}](${REPOSITORY_URL}/compare/${previous.tag}...${target.tag}).`
			: "Initial tagged release (no earlier reachable release tag).",
	];
	for (const category of ["Added", "Fixed", "Performance", "Changed", "Documentation", "Maintenance"]) {
		const items = groups.get(category);
		if (items?.length) parts.push(`#### ${category}\n\n${items.join("\n")}`);
	}
	if (!groups.size) parts.push("- No user-visible changes in this tag range.");
	return parts.join("\n\n");
}

/** Only replace the marked block. Unreleased notes and the manual archive survive. */
export function buildChangelog(
	existing: string,
	options: ChangelogOptions = {},
): { content: string; notes: Map<string, string> } {
	const cwd = options.cwd ?? process.cwd();
	const start = existing.indexOf(GENERATED_START);
	const end = existing.indexOf(GENERATED_END);
	if (
		start !== existing.lastIndexOf(GENERATED_START) ||
		end !== existing.lastIndexOf(GENERATED_END) ||
		start < 0 !== end < 0 ||
		(start >= 0 && end < start)
	)
		throw new Error("Invalid generated changelog markers; refusing to overwrite manual notes.");
	const manual = start < 0 ? existing : existing.slice(0, start) + existing.slice(end + GENERATED_END.length);
	const manualVersions = [...manual.matchAll(/^###\s+v?(\d+\.\d+\.\d+)(?:\s|$)/gm)]
		.map((match) => parse_release_tag(`v${match[1]}`))
		.sort(compareReleases);
	const cutoff = manualVersions.at(-1);
	const tags = readTags(cwd);
	const pending = options.pendingVersion
		? pendingRelease(cwd, options.pendingVersion, tags, options.pendingRef)
		: undefined;
	const targets = (pending ? [...tags, pending] : tags).sort(compareReleases);
	const refHash = options.ref
		? git(cwd, ["rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`])
		: undefined;
	// A later version can reuse an older commit, so reachability alone does not
	// keep future releases out of a package built for a specific version tag.
	const refTag = tags.find((tag) => tag.tag === options.ref?.replace(/^refs\/tags\//, ""));
	const notes = new Map<string, string>();
	const sections: string[] = [];
	for (const tag of targets.slice().reverse()) {
		if (refTag && compareReleases(tag, refTag) > 0) continue;
		if (refHash && !isAncestor(cwd, tag.hash, refHash)) continue;
		const generated = !cutoff || compareReleases(tag, cutoff) > 0;
		if (!generated && tag.tag !== options.notesTag) continue;
		const body = releaseBody(cwd, tag, tags);
		notes.set(tag.tag, body);
		if (generated) {
			const note = tag.pending ? " (pending)" : tag.isDevelopment ? " (development)" : "";
			sections.push(`### ${tag.tag.slice(1)} — ${tag.date}${note}\n\n${body}`);
		}
	}
	if (options.notesTag && !notes.has(options.notesTag))
		throw new Error(
			`Release tag ${options.notesTag} is missing, not reachable from ${options.ref ?? "the repository"}, or outside the requested release version.`,
		);
	const block = `${GENERATED_START}\n\n${sections.join("\n\n") || "No newer tagged releases yet."}\n\n${GENERATED_END}`;
	let content: string;
	if (start >= 0) content = existing.slice(0, start) + block + existing.slice(end + GENERATED_END.length);
	else {
		const insertAt = existing.search(/^###\s+v?\d+\.\d+\.\d+\b/m);
		const index = insertAt < 0 ? existing.length : insertAt;
		content = `${existing.slice(0, index).trimEnd()}\n\n${block}\n\n${existing.slice(index)}`;
	}
	return { content, notes };
}

function main(): void {
	const args = process.argv.slice(2);
	const options: ChangelogOptions = {};
	let notesFile: string | undefined;
	let check = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		switch (argument) {
			case "--check":
				check = true;
				break;
			case "--pending-version": {
				const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as Record<
					string,
					unknown
				>;
				options.pendingVersion = parse_release_tag(`v${String(packageJson["version"])}`).version;
				break;
			}
			case "--ref":
			case "--tag":
			case "--notes-file":
			case "--pending-ref": {
				const value = args[++index];
				if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
				switch (argument) {
					case "--ref":
						options.ref = value;
						break;
					case "--pending-ref":
						options.pendingRef = value;
						break;
					case "--tag":
						parse_release_tag(value);
						options.notesTag = value;
						break;
					default:
						notesFile = value;
						break;
				}
				break;
			}
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
	}
	if (notesFile && !options.notesTag) throw new Error("--notes-file requires --tag.");
	const changelogPath = path.resolve("CHANGELOG.md");
	const existing = fs.readFileSync(changelogPath, "utf8");
	const result = buildChangelog(existing, options);
	if (check) {
		if (result.content !== existing) {
			console.error("CHANGELOG.md is out of date. Run npm run changelog.");
			process.exitCode = 1;
		}
	} else if (result.content !== existing) fs.writeFileSync(changelogPath, result.content);
	if (notesFile) {
		fs.mkdirSync(path.dirname(path.resolve(notesFile)), { recursive: true });
		fs.writeFileSync(notesFile, `${result.notes.get(options.notesTag!)}\n`);
	}
	console.log(`Changelog ${check ? "checked" : "rebuilt"} from live release tags.`);
}

if (require.main === module) main();
