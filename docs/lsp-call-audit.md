# LSP Call Audit

## Purpose

This document records the current language-feature routing after the Semantic Query Engine and provider migration work. It is no longer a pre-migration audit: the main GDScript semantic path is already local-first.

The remaining audit goal is to measure how often Godot LSP is still needed and whether those calls are caused by legitimate semantic gaps or by incomplete local routing.

## Current provider routing

| Feature | Local path | Godot LSP fallback | State |
| --- | --- | --- | --- |
| Definition | `SemanticQueryEngine` → `LanguageService` | `DefinitionFallback` | **Local-first** |
| Hover | `SemanticQueryEngine` → `LanguageService` | `HoverFallback` | **Local-first** |
| Completion | `SemanticQueryEngine` → `LanguageService` | `CompletionFallback` | **Local-first** |
| References | `SemanticQueryEngine` → `LanguageService` | `ReferencesFallback` | **Local-first** |
| Rename | `BindingIndex` / local semantic path | `RenameFallback` | **Local-first** |
| Signature Help | local binding/symbol resolution | `SignatureHelpFallback` | **Local-first** |
| Document Symbols | `FileIndex` | not required for the current path | **Local** |
| Workspace Symbols | `SymbolIndex.workspaceSymbols()` | intentionally filtered from LSP | **Local** |
| Semantic Tokens | existing provider path | requires dedicated audit | **Separate** |
| Inlay Hints | existing provider path | requires dedicated audit | **Separate** |
| Resource/document features | resource-specific providers | outside GDScript semantic path | **Separate domain** |

The key architectural change is that ordinary project-code semantic operations no longer need provider-specific LSP lookup logic.

## Current local semantic stack

```text
VS Code Provider
      ↓
LanguageService
      ↓
SemanticQueryEngine
      ├── SymbolIndex
      ├── BindingIndex
      ├── ReferenceIndex
      └── TypeResolutionIndex
              ↓
        DependencyGraph
              ↓
          FileIndex / AST
```

`UpdateScheduler` sits before `FileIndex` and coalesces text, save, and filesystem events. Semantic cache entries additionally record their external query dependencies.

## Godot LSP boundary

`GDScriptLanguageClient` is the transport boundary. LSP request instrumentation records `lsp.request.<method>` latency for requests that are actually sent.

The local architecture intentionally keeps Godot LSP outside the hot path whenever local semantics are sufficiently certain.

Known intentional filtering includes:

- `workspace/didChangeWatchedFiles`: the extension owns its own file/update path;
- `workspace/symbol`: workspace symbols are served locally by `SymbolIndex`.

Remaining LSP requests should be classified as one of:

```text
engine-native semantics
unsupported local construct
ambiguous / dynamic semantics
local model unavailable
transport / lifecycle operation
```

A request that falls into none of these categories is a candidate for further local migration.

## Confidence-aware routing

The semantic query layer distinguishes:

```text
exact
inferred
partial
unknown
```

The intended policy is:

```text
exact / safe inferred
        ↓
   local result

partial / unknown
        ↓
 Godot LSP fallback
```

This distinction matters because the goal is not to maximize local hit rate by returning speculative results. Incorrect semantic results are more damaging than a fallback request.

## Cache and invalidation behavior

The semantic query cache records:

- current file source/API snapshot;
- symbol lookup signatures;
- workspace completion signatures;
- resolved receiver file snapshots.

Therefore a cached result can be invalidated even when the queried document itself is unchanged if the external symbol set or receiver semantic state changed.

Cross-file API changes are also propagated through the dependency graph. Function-body-only edits do not invalidate transitive dependents when the API fingerprint remains unchanged.

## What is now implemented

The following migration steps are complete in `master`:

1. semantic query boundary established;
2. definition migrated;
3. hover migrated;
4. references migrated;
5. completion migrated;
6. API-aware invalidation added;
7. semantic change classification added;
8. precise secondary-index invalidation added;
9. incremental dependency topology refresh added;
10. semantic cache snapshot identity added;
11. query dependency snapshots added.

The original audit statement that these providers are still waiting for the query-engine migration is obsolete and should not be reintroduced.

## Remaining audit work

### 1. Measure real fallback usage

Record Godot LSP request counts for representative editor actions:

- completion while typing;
- hover;
- definition;
- references;
- rename;
- signature help.

The primary derived metric is:

```text
Godot LSP requests / editor action
```

For common project symbols, the desired value approaches zero.

### 2. Classify fallback causes

For each fallback request, determine whether it was caused by:

- missing type inference;
- dynamic dispatch;
- unresolved inheritance/dependency;
- engine-native type/API;
- unsupported syntax;
- ambiguous workspace symbol;
- transport failure.

This classification directly informs the next semantic implementation instead of adding speculative infrastructure.

### 3. Audit separate provider domains

Semantic tokens and inlay hints are not covered by the main GDScript semantic migration. Their current routing should be inspected independently before changing them.

## Performance measurements

The project already exposes runtime measurements for:

- `parse`;
- `collectSymbols`;
- `scheduledUpdate`;
- `lsp.request.<method>`.

The remaining Phase A work is to collect reproducible measurements on realistic projects and compare local work against fallback latency.

Required metrics:

| Metric | Purpose |
| --- | --- |
| p50 / p95 / p99 | interactive responsiveness |
| parser time | syntax processing cost |
| symbol collection | AST-to-index cost |
| scheduled update | event-to-index cost |
| semantic recomputation | invalidation efficiency |
| LSP requests/action | local-first effectiveness |
| memory | project-scale behavior |
| initial indexing | startup cost |

## Next semantic boundary

The next major gain should come from expanding local semantic coverage, not from another generic cache layer.

Priority:

```text
Type inference
    ↓
Godot API semantic database
    ↓
confidence-aware provider routing
    ↓
completion latency / cancellation
    ↓
LSP transport hardening
    ↓
large-project benchmarks
```

The local analyzer should remain conservative. Unsupported or ambiguous expressions should continue to use Godot LSP rather than forcing an unsafe approximation.

## Non-goals

- Do not remove Godot LSP.
- Do not treat every LSP request as a bug.
- Do not add worker threads before CPU profiling proves they are necessary.
- Do not introduce persistent disk caching before startup profiling justifies it.
- Do not fold resource-language providers into the GDScript semantic engine without a concrete shared requirement.
