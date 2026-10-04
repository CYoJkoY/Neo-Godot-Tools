# Coding Standards

Adopted 2026-10-04 at the maintainer's request: strictest practical type checking, a hard ban on
`any`, functional style with guard clauses, and no over-defensive code. This document is the
contract; the numbers in it are reproducible with the commands in §7.

The standard is **binding for new and modified code immediately**. Repo-wide adoption is a ratchet:
the census in §4 is the baseline, and every change may lower it, never raise it.

## 1. Language and toolchain

| Rule | Status | Evidence |
| --- | --- | --- |
| No JavaScript source files (`.js`, `.jsx`, `.mjs`, `.cjs`) | **Enforced** | `git ls-files` match count: 0. CI gate "Reject tracked JavaScript source" fails the build if one appears. |
| Config and scripts in TypeScript or static data only | **Enforced** | `tsconfig*.json`, `biome.json`, `package.json` + `tools/*.ts` (15 files). The legacy `.eslintrc.json`/`tslint.json` and their unused devDependencies were deleted on 2026-10-04; no hand-written build JS remains. |
| Every dependency typed | **Enforced** | `@types/*` in `devDependencies`; untyped modules are declared in `src/types/untyped_modules.d.ts` (`await-notify`, `prismjs/components/prism-csharp`). `allowJs: false`. |
| `skipLibCheck: true` | **Exception** | Third-party `.d.ts` are not our code to fix; this only suppresses errors inside `node_modules`. It does not weaken any check on `src`. |

Two deliberate exceptions belong to this section:

- **`.js` import specifiers (165 sites).** `module: NodeNext` requires ESM-style specifiers for
  relative imports. They name `.ts` files that compile to `.js`; no JavaScript file is added to the
  repository. Stripping the suffix is possible for the CJS output but is a mechanical change
  orthogonal to type safety and is not part of this standard.
- **The webview script in `src/resource_inspector/panel_html.ts`.** It is JavaScript text inside a
  TypeScript template literal, executed in a VS Code webview sandbox. An iframe cannot run
  TypeScript; the surrounding plumbing (message protocol, CSS, tests) is TypeScript.

## 2. Type soundness

**Already enforced by the compiler** (`tsconfig.json`): `strict`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`,
`useUnknownInCatchVariables`, `noPropertyAccessFromIndexSignature`, `isolatedModules`,
`moduleDetection: force`.

**`any` is forbidden and mechanically blocked.** Biome `suspicious.noExplicitAny: "error"` runs over
`src/**/*.ts` and `tools/**/*.ts`; the census is 0 and a literal audit (`: any`, `as any`, `<any>`,
`any[]`, `, any`) is empty. `unknown` plus a type guard is the only accepted way to consume external
data; the guards introduced for this (`GodotValue`, `is_gd_object`, `is_renderable`, `LspClientLike`,
`WebviewMessage`, `SectionAttributes`, `GodotDebugConfiguration`) are the reference implementations.

**Boundaries are explicit.** Public functions, exported interfaces and module-level helpers declare
their parameter and return types. Locals rely on inference.

**Not viable today, measured:**

| Flag | Errors when enabled | Reason |
| --- | --- | --- |
| `exactOptionalPropertyTypes` | 118 product / 122 test | Distinguishes `x?: T` from `x?: T \| undefined`; the VS Code API types and the debugger protocol shapes use the latter everywhere. |
| `noUncheckedIndexedAccess` | 375 product / 606 test | Every indexed read becomes `T \| undefined`; the parser, variant decoders and index structures read arrays in hot loops. |

`noUncheckedIndexedAccess` is required by the standard, so it is the final ratchet milestone:
enable it when its error count reaches zero (§5).

**Biome runs clean** over `src` and `tools`: no errors and no warnings. `noParameterAssign` — the
"never reassign an input" rule — is at `error`, and the twelve pre-existing sites were rewritten as
a parameter plus a local (the shared `to_wire_value` helper, `open_buffer`, and the `scoped_*` locals
of the Godot 3 variable resolver).

**Immutable-by-default** (`readonly`, `as const`, branded ids) is required for new code: 158
`readonly` annotations exist today. Branded types are expected for identifiers that can be confused
with each other; existing code migrates opportunistically.

## 3. Functional style and control flow

Required for new and modified code:

- guard clauses first, no `else`/`else if` in the main path, block nesting ≤ 2;
- `const` over `let`; no `var`, ever;
- declarative array pipelines (`map`/`filter`/`flatMap`/`reduce`) instead of imperative loops;
- composition over inheritance; a `class` needs a reason (§5);
- the `Result<T, E>` union for expected business failures instead of `throw`.

Violations found in code touched by a change must be fixed in the same change.

## 4. Current census (baseline for the ratchet)

Roughly 31,600 lines of TypeScript in 149 `src` files and 15 `tools` files; the census covers the 123 non-test ones.

Measured by `npm run check:standards`; strings and template literals are excluded, so
embedded GDScript and webview JavaScript do not inflate the numbers, and `*.test.ts` files are
outside the ratchet — fixtures legitimately collect into arrays and mutate locals.

| Construct | Count | Where the load sits |
| --- | --- | --- |
| `class` declarations | 115 | debugger, tools, the parser cursor (§5) |
| `let` / `var` declarations | 272 | debugger, resource inspector, and the lexer/parser cursors |
| `for` loops | 193 | debugger, resource inspector |
| `while` / `do` loops | 34 | protocol loops, the lexer/parser cursors (§5) |
| `} else` branches | 181 | debugger, resource inspector |
| `throw` statements | 40 | parameter validation and protocol errors |

Total tracked constructs: 835 in 124 source files; 32 loops are justified with `// perf:` (§5).

`as` assertions and `readonly` coverage are not ratcheted — they are reviewed per file during the §6
migration — and the census strips comments and strings, so prose such as "renders a value as text"
does not need a count.

The 2026-10-04 migration of §6 step 2 took the total from 1091 to 1025: `src/utils` and
`src/performance` (logger, profiler, LRU cache, scheduling, subspawn) are factory-based and
class-free, and `src/analyzer` lost the `else` chains and mutable declaration locals, with its
scanning loops recorded under `// perf:`.

Step 3 started from `src/index` (1025 -> 918) and finished `src/providers` (918 -> 835). The seven index classes
(`FileIndex`, `SymbolIndex`, `DependencyGraph`, `TypeResolutionIndex`, `BindingIndex`,
`ReferenceIndex`, `InheritedMemberResolver`) are now `create*` factories over module-local state,
so callers depend on an exported interface instead of a class. The query helpers followed:
`dependency_graph.ts` (16 loops -> 1, the breadth-first invalidation walk kept under `// perf:`),
`control_flow.ts` (16 constructs -> 0: line grouping, branch chains and post-branch values are
`map`/`filter`/`reduce` pipelines over the line list) and the cursor scans in `expression.ts`,
which keep their loops under `// perf:` because they are the semantic query primitives, and the
source hash in `semantic_snapshot.ts` (one pass per edit, `// perf:`). The resolver followed:
`type_resolution.ts` went from 31 constructs to 0 - the declaration walks are `reduce`/`flatMap`
pre-order traversals, line statements are grouped in a `Map`, and qualified names and access
chains are folds - differentially verified against the previous implementation (138 000 probes
over every `*.gd` fixture, zero differences, before and after `invalidate`). What remains in this
area was `bindings.ts` (23 constructs), which is now also at zero: scopes are built by
`addSymbols`/`visitDeclaration` pipelines, the scope chain and visible bindings are recursive walks
over `parent` links, reference collection is a `map`/`filter` pipeline, and cache eviction goes
through `dropFromGroup`. The five map helpers the three modules had grown (`addToGroup`,
`addToSet`, `dropFromSet`, `dropFromGroup`, `deleteMatching`) now live in `src/index/collections.ts`.
`bindings.ts` was differentially verified the same way (180 973 probes over the fixtures plus the
`update` → `remove` → `re-update` → `clear` lifecycle, zero differences); that harness caught an
infinite recursion in the first version of the scope chain, which the unit tests then confirmed.

All fourteen provider classes became factories this way. `definition.ts` (17 -> 0) is the largest:
the documentation index and the language client are injected as `docs`/`lsp` accessors (so it no
longer reads `globals`), `else` chains became the `receiverClassName`/`hierarchy` helpers, the
scene scan for the enclosing `type="..."` attribute is an upward `Array.from(...).map(...).find`,
and the base-class walks (`findMemberOwner`, `firstDeclaringClass`) are recursions that keep the
previous order and stop at the first declaration. `document_drops.ts` (7 -> 0) followed, including
the `DataTransferItem.value` boundary: the VS Code API types it as `any`, so the provider reads it
through `read_string`/`read_boolean` and nothing untyped enters the module. The seven one-class
adapters (completions, document symbols, references, rename, signature help, tasks, workspace
symbols) became factories too, and the two symbol providers now share
`src/providers/symbols.ts` for their byte-identical range/kind/`SymbolInformation` helpers.

The five providers behind `src/providers` that carry behaviour followed the same pattern: a
`create*Provider(context, options)` factory returns an object typed by the VS Code contract, the
selector list lives in `src/providers/selectors.ts`, and the state a provider needs (the
documentation index, the inlay refresh timer, the language fallbacks) lives in the factory closure
instead of on `this`. `documentation.ts` takes its language client as `{ lsp }` - the same
injection `ScenePreviewProvider` already used - so the provider can be driven from a unit test
without loading the extension module. Match loops became `Array.from(text.matchAll(...), ...)`
pipelines, and the scene/documentation caches are unchanged. Two dead paths went with the
rewrite: the documentation provider passed an `enableScripts` key that is not a
`WebviewPanelOptions` member (the panel's own `webview.options` enables scripts), and
`register_capabilities` appended to the class lists of the client's message in place.

`src/providers/documentation_builder.ts` (27 -> 0) followed: the class page groups members by
section through a record of two lists instead of eleven string accumulators, the documentation
builder is a pipeline of pattern steps, and the bbcode code-block conversion now uses
`replaceAll` with a replacer function - `replace(marker, string)` expanded `$$`, `` $` `` and `$&`
inside GDScript samples, which the differential harness showed by rendering 51 documents and
pages against the previous revision (`/tmp/docsdiff/diff.cjs`: 102 renders, the only differences
are that fix). A unit test pins the behaviour.

## 5. Exceptions (deliberate, with reasons)

1. **Classes.** The VS Code host contract is class-based (`TreeDataProvider`,
   `WebviewViewProvider`, `DebugAdapterDescriptorFactory`, `EventEmitter`, the language client).
   Stateful protocol machines (debugger sessions, LSP client) also earn their classes: they own
   sockets, buffers and disposable timers. The standard's "composition over inheritance" applies —
   `extends` is allowed only where the API demands it — and a class that only groups pure helpers
   must become functions. Rewriting all 134 declarations would change the extension's contracts
   without improving correctness. One measured exception sits here: `src/analyzer/parser.ts` keeps
   its cursor class because the closure factory that replaced it allocated ~30 closures per file and
   benchmarked 15–20% slower on the profile corpus; the logger, profiler and LRU cache became
   factories precisely because they paid no such cost.
2. **Loops and `let` in measured hot paths.** The lexer/parser, variant encode/decode and index
   queries use indexed loops on purpose; `map`/`filter` allocate intermediate arrays and closure
   objects per element. The maintainer's efficiency requirement (fewer allocations, lower CPU) takes
   precedence there. Such a loop carries a `// perf:` comment explaining what was measured. Everywhere
   else the functional form is required. The census records 25 such loops (`perf` in
   `tools/standards_baseline.json`); the parser header and the lexer header document the measurement
   (`npm run profile:language`, parse p50 ≈ 0.02 ms per file) behind each one.
3. **`throw` at the VS Code boundary.** Failures that must reach the user are surfaced through the
   extension API (`window.showErrorMessage`, rejected promises of `debug.startDebugging`). `Result`
   is required for pure logic — parsing, resolution, index queries, resource edits.
4. **`as` assertions** are allowed only where a runtime guard has already established the shape or
   the compiler cannot model a correlated union; each one needs a one-line justification.
5. **No fallback for a value the compiler proves present.** `workspace.textDocuments`,
   `window.visibleTextEditors`, `findFiles(...)` and `WebviewView.visible` are never `undefined`, so
   `?? []` / `?? true` after them is dead code that would hide an API change behind a silent default.
   A guard is warranted only where the type says `| undefined` (`workspaceFolders`,
   `activeTextEditor`, `Map.get`).

## 6. Migration order (ratchet)

1. **Prevent regressions now.** `tools/check_standards.ts` re-reads the census, compares it with
   `tools/standards_baseline.json` and fails the build when any count grows; `npm run check:standards`
   runs in CI. `--update` refreshes the baseline after a deliberate reduction, so progress is visible
   in the diff. New code must be clean regardless of its file's history.
2. **Small, hot, already-typed modules** (`src/utils`, `src/performance`, `src/analyzer`).
3. **Index and query layers** (`src/index`), then providers and the resource inspector. The
   index classes are converted (see §4); the resolution passes are next, then `src/providers` and
   `src/resource_inspector`.
4. **Debugger protocol modules** — functional cores, classes only for the sockets/sessions.
5. **`noUncheckedIndexedAccess`** enabled last, when it reports zero errors.
6. **Keep the tool scripts inside the checked surface** (done 2026-10-04): `npm run lint` lints `src`
   and `tools`, and `tsconfig.test.json` type-checks every file under `tools`.

## 7. Verification

```bash
npx tsc -p tsconfig.json --noEmit        # product sources
npx tsc -p tsconfig.test.json --noEmit   # tests and tools
npm run test:unit                        # 265 unit tests
npm run lint                             # biome over src and tools, 0 errors required
npm run compile                          # extension build
npm run check:standards                  # coding standard ratchet (CI)
```

Census commands:

```bash
grep -rnE '\b(let|var)[[:space:]]+[A-Za-z_$]' src tools --include=*.ts | wc -l
grep -rnE '\bfor[[:space:]]*\(' src tools --include=*.ts | wc -l
grep -rnE '^[[:space:]]*(export[[:space:]]+)?(abstract[[:space:]]+)?class[[:space:]]' src tools --include=*.ts | wc -l
npx biome lint --max-diagnostics=400 src | grep -c 'noExplicitAny'
```
