# Git Workflow and Commit Convention

This document defines the repository's development and Git history policy. The goal is to keep the public history readable, make architectural changes reviewable, and prevent temporary debugging work from becoming permanent project history.

## 1. Branch policy

`master` is the stable integration branch. Do not develop directly on `master`.

Use one short-lived branch per logical change:

```text
feat/<scope>-<topic>
fix/<scope>-<topic>
perf/<scope>-<topic>
refactor/<scope>-<topic>
test/<scope>-<topic>
docs/<topic>
ci/<topic>
```

Examples:

```text
feat/lsp-semantic-query
perf/lsp-request-routing
fix/lsp-stale-response
refactor/parser-ast-model
ci/release-validation
```

A branch should have one clear objective. Do not combine unrelated cleanup, feature work, and release work merely because they happen to be convenient to edit together.

## 2. Commit granularity

A GitHub commit represents a **logical, reviewable change**, not an individual editing action.

The default rule is:

> One feature, fix, refactor, performance phase, test change, documentation change, or CI change should normally become one public commit.

Local development may contain any number of temporary commits. Before opening a pull request, squash or otherwise reorganize them so the branch contains the smallest useful set of logical commits.

For a single coherent change, prefer **one commit**.

### Good

```text
feat(lsp): make local analyzer the primary language service
```

### Too fragmented

```text
feat(lsp): add analyzer
fix(lsp): fix analyzer lookup
perf(lsp): cache analyzer result
test(lsp): add analyzer test
docs(lsp): document analyzer
fix(lsp): correct analyzer race
```

If all of the above are parts of one architectural change, they should normally be consolidated before the PR is merged.

### When multiple commits are justified

Use multiple public commits only when each commit is independently meaningful and reviewable, for example:

1. a prerequisite refactor;
2. the feature built on that refactor;
3. an independent test or migration that is useful on its own.

Do not create separate commits merely because the work was performed in separate sessions.

## 3. Commit message format

Use Conventional Commits:

```text
<type>(<scope>): <imperative description>
```

Allowed primary types:

| Type | Purpose |
| --- | --- |
| `feat` | New user-visible or architectural capability |
| `fix` | Correctness or reliability fix |
| `perf` | Performance improvement without changing intended behavior |
| `refactor` | Internal restructuring without intended behavior change |
| `test` | Test-only changes |
| `docs` | Documentation-only changes |
| `ci` | Continuous integration/release automation |
| `build` | Build/package/toolchain changes |
| `chore` | Repository maintenance that does not fit the above |

Preferred scopes include:

```text
lsp
parser
analyzer
index
debugger
formatter
performance
release
ci
test
docs
```

Keep the subject short and specific. Describe the resulting change, not the debugging process.

Bad:

```text
fix stuff
update things
try another solution
final final fix
```

Good:

```text
fix(lsp): reject stale semantic responses
perf(lsp): coalesce incremental document updates
refactor(parser): separate syntax tree from symbol extraction
```

## 4. Pull request policy

Every non-trivial change should go through a pull request.

A PR should contain:

- a clear problem statement;
- the intended solution;
- important architectural decisions;
- tests and verification performed;
- known limitations or follow-up work;
- no unrelated changes.

For a single logical change, the preferred PR shape is:

```text
1 branch
1 logical change
1 consolidated commit
1 PR
```

Use draft PRs when the architecture or implementation is still being explored. Before merge, the final branch history must satisfy this document.

## 5. Development workflow

Use this sequence for normal development:

```text
1. Define the objective
2. Inspect the current architecture
3. Create a feature/fix branch
4. Implement the complete logical change
5. Run focused tests
6. Run the full relevant validation suite
7. Review the diff for unrelated changes
8. Consolidate temporary commits
9. Open/update the PR
10. Merge only after CI is green
```

Do not repeatedly push tiny commits to a PR just to record every debugging step.

## 6. LSP-specific rule

LSP work is particularly sensitive to commit fragmentation because parser, indexing, scheduling, semantic resolution, provider routing, and fallback behavior are coupled.

A change spanning several of these layers should normally be delivered as one architectural phase rather than a sequence of tiny implementation commits.

For example:

```text
feat(lsp): adopt local-first semantic query architecture
```

may legitimately contain parser integration, index changes, provider routing, cache invalidation, tests, and documentation when they form one inseparable feature.

## 7. Performance changes

Never label a change `perf` merely because it looks faster.

A performance commit should identify:

- the measured bottleneck;
- the workload or benchmark;
- the relevant metric;
- the observed result when practical;
- any behavior or memory trade-off.

For LSP work, prefer p50/p95/p99 latency, parser/index time, memory usage, and Godot LSP request counts over anecdotal editor responsiveness.

## 8. Release policy

Git tags publish releases; they do not define source-tree development versions.

`package.json` must always contain a clean SemVer version:

```text
2.8.0
```

Stable releases use:

```text
v2.8.0
```

Development releases use:

```text
v2.8.0.dev1
v2.8.0.dev2
```

The development number belongs only to the tag/release. Release validation must reject mismatches and must never mutate `package.json`.

## 9. What should never enter public history

Do not commit:

- generated JavaScript that belongs in the build output;
- local workspace files;
- personal editor configuration;
- temporary benchmark output;
- debug logs or dumps;
- experimental code that is not part of the final change;
- unrelated formatting churn;
- credentials, tokens, or local paths containing private information.

If temporary commits already exist locally, clean them up before pushing rather than preserving them for historical completeness.

## 10. Definition of done for a commit

A commit is ready for the public history when:

- its purpose can be understood from the subject;
- its diff is internally coherent;
- it builds successfully when applicable;
- relevant tests pass;
- no unrelated files are changed;
- the implementation and documentation agree;
- the commit can be reviewed without reconstructing the author's debugging session.
