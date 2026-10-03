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

31,581 lines of TypeScript in 149 `src` files and 15 `tools` files.

| Construct | Count | Where the load sits |
| --- | --- | --- |
| `class` declarations | 167 | debugger 62, index 35, tools 22, providers 14 |
| `let` / `var` declarations | 516 | debugger 110, resource inspector 106, index 67, providers 66 |
| `for` loops | 350 | index 78, resource inspector 74, debugger 66 |
| `while` / `do` loops | 81 | protocol and settle-wait loops |
| `} else` branches | 211 | debugger 119, resource inspector 40 |
| `throw new ...` | 51 | parameter validation and protocol errors |
| `as` assertions | 59 | narrowing the compiler cannot express |
| `readonly` annotations | 158 | present, not yet uniform |

## 5. Exceptions (deliberate, with reasons)

1. **Classes.** The VS Code host contract is class-based (`TreeDataProvider`,
   `WebviewViewProvider`, `DebugAdapterDescriptorFactory`, `EventEmitter`, the language client).
   Stateful protocol machines (debugger sessions, LSP client) also earn their classes: they own
   sockets, buffers and disposable timers. The standard's "composition over inheritance" applies —
   `extends` is allowed only where the API demands it — and a class that only groups pure helpers
   must become functions. Rewriting all 167 declarations would change the extension's contracts
   without improving correctness.
2. **Loops and `let` in measured hot paths.** The lexer/parser, variant encode/decode and index
   queries use indexed loops on purpose; `map`/`filter` allocate intermediate arrays and closure
   objects per element. The maintainer's efficiency requirement (fewer allocations, lower CPU) takes
   precedence there. Such a loop carries a `// perf:` comment explaining what was measured. Everywhere
   else the functional form is required.
3. **`throw` at the VS Code boundary.** Failures that must reach the user are surfaced through the
   extension API (`window.showErrorMessage`, rejected promises of `debug.startDebugging`). `Result`
   is required for pure logic — parsing, resolution, index queries, resource edits.
4. **`as` assertions** are allowed only where a runtime guard has already established the shape or
   the compiler cannot model a correlated union; each one needs a one-line justification.

## 6. Migration order (ratchet)

1. **Prevent regressions now.** The census in §4 is the baseline; a checker verifies that no count
   grows. New code must be clean regardless of its file's history.
2. **Small, hot, already-typed modules** (`src/utils`, `src/performance`, `src/analyzer`).
3. **Index and query layers** (`src/index`), then providers and the resource inspector.
4. **Debugger protocol modules** — functional cores, classes only for the sockets/sessions.
5. **`noUncheckedIndexedAccess`** enabled last, when it reports zero errors.

## 7. Verification

```bash
npx tsc -p tsconfig.json --noEmit        # product sources
npx tsc -p tsconfig.test.json --noEmit   # tests and tools
npm run test:unit                        # 256 unit tests
npm run lint                             # biome, 0 errors required
npm run compile                          # extension build
```

Census commands:

```bash
grep -rnE '\b(let|var)[[:space:]]+[A-Za-z_$]' src tools --include=*.ts | wc -l
grep -rnE '\bfor[[:space:]]*\(' src tools --include=*.ts | wc -l
grep -rnE '^[[:space:]]*(export[[:space:]]+)?(abstract[[:space:]]+)?class[[:space:]]' src tools --include=*.ts | wc -l
npx biome lint --max-diagnostics=400 src | grep -c 'noExplicitAny'
```
