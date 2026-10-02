# Tag-based release notes

`CHANGELOG.md` has two kinds of content:

- **Manual notes**: the `Unreleased` section and the historical archive. These are never overwritten by the generator.
- **Generated notes**: the block between `generated-release-notes:start` and `generated-release-notes:end`. Do not edit this block by hand; it is rebuilt from live release tags.

## How ranges are chosen

Supported tags are `vX.Y.Z` and `vX.Y.Z.devN` (including existing zero-padded development numbers).

- A stable tag compares with the highest lower-version **stable ancestor** tag. Development tags do not shorten a stable release's notes.
- A development tag can compare with an earlier reachable stable or development tag.
- Every non-merge commit in that range is included, not only the latest commit or pull request. Version-bump bookkeeping and the changelog bot's own commits are omitted.
- A tag on a sibling branch is not used as the comparison base. Versions and development numbers are sorted numerically, not lexically or by tag creation time.
- If there is no earlier reachable tag, notes include the history up to the target tag. No release sections are invented for versions without a live tag.
- The latest manually documented stable version is the generated archive's lower boundary. Older hand-written release notes remain intact, even if an old tag is removed.

Deleting a generated tag removes its section and recomputes later ranges, so the commits are not lost. Force-moving a tag also recomputes its notes. Always synchronize/prune local tags before regenerating after a remote deletion or retag.

Conventional Commit subjects make the notes more useful: `feat`, `fix`, `perf`, `docs` and maintenance changes are grouped, and PR/commit links are included. Unconventional or empty commit subjects have a fallback instead of silently losing a commit.

## Automation

`.github/workflows/changelog.yml` runs after a `v*` tag push, a tag deletion, on manual dispatch and daily as a recovery sweep. It checks out the current default branch with full history, synchronizes the live tags, tests the generator, and opens/updates one `automation/changelog` PR containing only `CHANGELOG.md`.

This is deliberately a PR rather than a direct push to the protected default branch. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** for the repository. No personal token is required. CI is explicitly dispatched for created/updated bot PRs because GitHub does not automatically trigger another workflow from a `GITHUB_TOKEN` PR event.

A release workflow separately regenerates the changelog **before packaging the VSIX**, and uses the same range-based notes as the GitHub release body. It restricts generated entries to tags reachable from the release being built and no higher than its version, so rebuilding an older tag cannot accidentally include a later release (even if that later tag reuses an older commit). A deleted/moved tag that no longer matches the checkout aborts publication. Rerunning a release updates its notes and replaces the VSIX asset rather than creating duplicate releases.

The sync workflow preserves manual `Unreleased` notes; maintainers may curate or clear that draft when appropriate. Routine release entries themselves require no manual changelog edits.

## Local commands

```bash
# Full history and authoritative remote tags are required.
git fetch --unshallow origin                 # only if the checkout is shallow
git fetch --force --prune --prune-tags origin '+refs/tags/*:refs/tags/*'
npm install
npm run changelog
npm run changelog -- --check
npm run test:release
```

To generate a specific release body and package-time changelog:

```bash
npm run changelog -- --ref v2.12.3 --tag v2.12.3 --notes-file out/release-notes.md
```

`package.json` remains a clean `X.Y.Z` version. Note generation does not change it, create tags or publish anything. The existing release-tag/package-version validation still runs before packaging.
