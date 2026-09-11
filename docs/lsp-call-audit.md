# LSP Call Audit

## Purpose

This document records the current language-feature routing before the Semantic Query Engine migration. The goal is to establish an evidence-based baseline: local analysis and indexes should answer ordinary project-code queries first, while Godot LSP remains the fallback for engine-native, dynamic, ambiguous, or unsupported semantics.

This audit is intentionally descriptive. It does not change provider behavior.

## Current architecture

```text
VS Code Provider
      |
      v
LanguageService
      |
      +--> FileIndex
      +--> SymbolIndex
      +--> BindingIndex
      +--> ReferenceIndex
      +--> TypeResolutionIndex
      +--> DependencyGraph
      |
      v
Local semantic result
      |
      +---- resolved ----> VS Code result
      |
      +---- unresolved --> feature-specific Godot LSP fallback
```

The current `LanguageService` already owns the central local-first path for GDScript definition, references, rename, hover, completion, and signature help. Providers should remain thin adapters around this service.

## Provider routing matrix

| Feature | Provider entry point | Local path | Godot LSP fallback | Local-first status |
| --- | --- | --- | --- | --- |
| Definition | `GDDefinitionProvider` | `LanguageService.getDefinition()` for GDScript | `DefinitionFallback` | **Active** |
| Hover | `GDHoverProvider` | `LanguageService.getHover()` for GDScript | `HoverFallback` | **Active** |
| Completion | `GDCompletionItemProvider` | `LanguageService.getCompletions()` for GDScript | `CompletionFallback` | **Active** |
| References | `GDReferenceProvider` | `LanguageService.getReferences()` | `ReferencesFallback` | **Active** |
| Rename | `GDRenameProvider` | `LanguageService.getRenameEdits()` | `RenameFallback` | **Active** |
| Signature help | `GDSignatureHelpProvider` | `LanguageService.getSignatureHelp()` | `SignatureHelpFallback` | **Active** |
| Document symbols | `DocumentSymbolProvider` | Local indexed symbols | No equivalent local fallback required for the current path | **Local** |
| Workspace symbols | `WorkspaceSymbolProvider` | `SymbolIndex.workspaceSymbols()` | Current LSP client filters `workspace/symbol` | **Local** |
| Semantic tokens | `SemanticTokenProvider` | Existing provider path; requires separate audit | Not classified by this phase | **Audit required** |
| Inlay hints | `InlayHintsProvider` | Existing provider path; requires separate audit | Not classified by this phase | **Audit required** |
| Resource/document features | Resource-specific providers | Parser/resource utilities | Not part of GDScript semantic fallback | **Separate domain** |

The first six rows are the critical migration surface for the local-first language service. The provider registry exports these providers from `src/providers/index.ts`.

## Godot LSP boundary

`GDScriptLanguageClient` is the transport boundary. It currently filters unsupported outgoing requests and records request round-trip latency as `lsp.request.<method>` performance samples.

Known request filtering:

- `workspace/didChangeWatchedFiles` is discarded because the extension maintains its own file/update path.
- `workspace/symbol` is discarded because workspace symbols are served locally and the Godot-side implementation is unnecessary for the current architecture.

The client also contains compatibility/result normalization for selected Godot responses, including hover markdown and document-link handling. These transformations belong to the transport boundary and should not be mixed into the local semantic engine.

## Current local semantic capabilities

`LanguageService` currently has direct access to:

- `FileIndex`
- `SymbolIndex`
- `BindingIndex`
- `ReferenceIndex`
- `TypeResolutionIndex`
- `DependencyGraph`
- `UpdateScheduler`

Current query behavior is already local-first in the following order:

### Definition

1. Resolve member expression through `TypeResolutionIndex`.
2. Resolve the word through `BindingIndex`.
3. Resolve a unique file-local symbol.
4. Resolve a unique workspace symbol.
5. Call `DefinitionFallback`.

### References

1. Resolve the word through `BindingIndex`.
2. Query binding references locally.
3. Use `ReferencesFallback` only when the local binding/reference path cannot provide a result.

### Rename

1. Validate the new identifier.
2. Resolve the local binding.
3. Collect binding references locally.
4. Build the workspace edit locally.
5. Use `RenameFallback` when local binding/reference resolution is unavailable.

### Hover

1. Resolve member receiver/type locally.
2. Resolve member symbol locally.
3. Resolve a local binding.
4. Resolve a unique workspace symbol.
5. Use `HoverFallback` when local semantic information is insufficient.

### Completion

1. Resolve member receiver/type locally.
2. Return locally indexed members.
3. Otherwise return visible bindings and workspace symbols.
4. Use `CompletionFallback` when local completion cannot answer the request.

### Signature help

1. Parse the active call expression locally.
2. Resolve the function binding or workspace symbol.
3. Build the signature from indexed parameters.
4. Use `SignatureHelpFallback` when local resolution is insufficient.

## Findings

### 1. The project has already crossed the architectural boundary

The main providers do not directly issue Godot LSP requests. They delegate GDScript semantic work to `LanguageService`, which contains the local indexes and feature-specific fallbacks. This is the correct direction and should be preserved.

### 2. `LanguageService` is currently the semantic aggregation point

It combines symbol, binding, reference, type, and dependency indexes in one class. This is functional, but it is also the next architectural pressure point: feature providers should eventually query a dedicated `SemanticQueryEngine` rather than accumulating semantic policy inside `LanguageService`.

### 3. Fallback decisions are boolean rather than confidence-aware

The current contract is effectively:

```text
local result exists -> return local result
otherwise -> LSP fallback
```

There is no explicit distinction between `exact`, `inferred`, `partial`, and `unknown` results. This is the primary prerequisite for the next semantic-engine phase.

### 4. Completion is the highest-risk interactive path

Completion executes local type/member resolution on every provider request and falls back when it cannot produce a result. Before optimizing completion further, the semantic query boundary must make cacheability, document-version validity, and fallback reasons explicit.

### 5. Workspace symbols are already intentionally local

The LSP client filters `workspace/symbol`, while `LanguageService.getWorkspaceSymbols()` delegates to `SymbolIndex`. This is a concrete example of the desired end state: ordinary project-wide symbol lookup does not depend on Godot LSP.

### 6. Resource-language features should not be forced into the GDScript semantic engine

`gdresource` and `gdscene` currently have dedicated parser/document behavior. Their resource navigation and hover behavior should remain a separate domain unless an actual shared semantic requirement appears.

## Phase A.2 baseline

The audit establishes these current classifications:

```text
LOCAL-FIRST AND CENTRALIZED
  Definition
  Hover
  Completion
  References
  Rename
  Signature Help
  Document Symbols
  Workspace Symbols

SEPARATE AUDIT REQUIRED
  Semantic Tokens
  Inlay Hints
  Other engine-facing features

TRANSPORT / COMPATIBILITY BOUNDARY
  Godot LSP client
```

The remaining work in Phase A is therefore not to redesign every provider. It is to measure and formalize the local semantic boundary before introducing a new query abstraction.

## Required measurements before Semantic Query Engine

For representative GDScript workspaces, measure:

- initial local indexing time
- incremental update latency after a single edit
- local parser time
- symbol collection time
- binding/reference/index update time
- semantic recomputation count
- Godot LSP requests per editor action
- LSP request p50/p95/p99 latency by method
- completion latency p50/p95/p99
- definition latency p50/p95/p99
- hover latency p50/p95/p99
- references latency p50/p95/p99
- rename latency p50/p95/p99
- extension-host CPU and memory during active editing

The most important derived metric is:

```text
Godot LSP requests / editor action
```

The target for ordinary project-code editing is approximately zero LSP requests for queries that the local semantic model can answer confidently.

## Next implementation boundary

The next code phase should introduce a narrow `SemanticQueryEngine` around the existing indexes without moving provider behavior all at once.

Initial query surface:

```text
getSymbol(uri, position)
getDefinition(symbol)
getType(expression)
getMembers(type)
```

The query layer should then return a confidence-aware result:

```text
exact
inferred
partial
unknown
```

Only after these primitives are stable should Definition, Hover, References, Completion, and Rename be migrated incrementally to the new abstraction.

## Non-goals for this phase

- Do not remove Godot LSP.
- Do not add worker threads before profiling proves they are necessary.
- Do not introduce a persistent disk cache.
- Do not implement a complete GDScript compiler/type lattice.
- Do not redesign resource/document providers merely for architectural symmetry.
- Do not add LSP calls simply to improve coverage before measuring the local gap.
