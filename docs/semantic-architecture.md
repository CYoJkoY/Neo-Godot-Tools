# Semantic Architecture

This document describes the semantic layer specifically. For the broader provider/LSP lifecycle, see `lsp-architecture.md`.

## Semantic pipeline

```text
GDScript source
      ↓
 Parser / AST
      ↓
   FileIndex
      ↓
 ┌────┼───────────┬────────────┐
 ▼    ▼           ▼            ▼
Symbol Binding Reference   Dependency
Index  Index    Index         Graph
 └─────┴───────────┬────────────┘
                   ▼
          TypeResolutionIndex
                   │
                   ▼
         SemanticQueryEngine
                   │
                   ▼
          VS Code semantic APIs
```

The semantic layer is deliberately independent of VS Code presentation types. `LanguageService` adapts semantic results into VS Code provider results and decides when a feature-specific fallback is required.

## File snapshots

An indexed GDScript file is the unit of incremental semantic state. Its snapshot includes source/version information, parsed declarations, extracted symbols, and semantic fingerprints.

Two fingerprints are particularly important:

```text
sourceFingerprint
      ↓
exact source identity

apiFingerprint
      ↓
public semantic shape
```

A document version is useful for editor freshness, but it is not the dependency identity used to decide whether another file's semantics changed.

## API fingerprint

The API fingerprint represents public semantic shape such as symbol signatures and inheritance.

```text
function body changes
        ↓
API fingerprint unchanged
        ↓
dependents remain valid
```

```text
public signature / inheritance changes
        ↓
API fingerprint changes
        ↓
DependencyGraph finds affected dependents
        ↓
semantic/type state invalidated selectively
```

This is the key distinction between textual edits and semantic edits.

## Dependency graph

Dependencies are tracked incrementally from constructs such as `extends` and `preload()`.

The graph maintains:

- outgoing dependency edges;
- incoming dependent sets;
- unresolved target candidates.

When a target appears or disappears, only candidate/direct dependents are refreshed rather than rebuilding the entire workspace graph.

## Query engine

`SemanticQueryEngine` is the semantic read boundary. Providers should not independently traverse all indexes to reproduce lookup policy.

The query engine is responsible for:

1. resolving symbols;
2. resolving definitions;
3. resolving references;
4. resolving hover information;
5. producing completion candidates;
6. tracking query dependencies;
7. exposing confidence;
8. preserving the local-first/LSP-fallback boundary.

## Query dependency snapshots

A semantic query can depend on more than its current document. For example, resolving an identifier can depend on the workspace symbol set, while member completion can depend on the receiver's script and inherited API.

Each cache entry therefore records a dependency snapshot:

```text
Query cache entry
 ├── current file snapshot
 ├── symbol query signatures
 ├── workspace completion signatures
 └── resolved receiver file snapshots
```

Validation is local to the query:

```text
all dependencies unchanged
        ↓
      reuse

any dependency changed
        ↓
    recompute
```

This avoids both stale results and unnecessary workspace-wide cache eviction.

## Type resolution

`TypeResolutionIndex` maps declarations, bindings, and expressions to a conservative `ResolvedType` representation.

Current foundations include:

- declared types;
- built-in Godot types;
- local binding types;
- function return types when available;
- inheritance-aware member lookup;
- script-path resolution;
- member resolution.

The next expansion is expression-level type inference for common GDScript patterns. It should remain conservative and avoid pretending to model dynamic semantics it cannot prove.

## Confidence

The semantic layer distinguishes:

```text
exact       — directly established by indexed semantic data
inferred    — established by safe local inference
partial     — some semantic information exists, but resolution is incomplete
unknown     — the local model cannot establish a trustworthy result
```

Provider routing should use this information instead of treating every non-empty local result as equally authoritative.

```text
exact / safe inferred
        ↓
     local result

partial / unknown
        ↓
   Godot LSP fallback
```

## Provider boundary

The intended dependency direction is:

```text
VS Code Provider
      ↓
LanguageService
      ↓
SemanticQueryEngine
      ↓
semantic indexes
```

Never reverse this dependency by making the parser, indexes, or query engine depend on VS Code provider objects.

## Invalidation rules

The semantic update policy is derived from `SemanticChangeKind`:

| Change | Local file | Dependents |
| --- | --- | --- |
| `unchanged` | no semantic work | no |
| `body_changed` | update affected local semantics | no |
| `dependency_changed` | refresh dependency state | only if semantic topology requires it |
| `api_changed` | update API/index state | transitive affected dependents |
| `file_added` | add indexes/topology | newly resolved dependents |
| `file_removed` | remove indexes | affected dependents |

The exact implementation may invalidate caches more aggressively than the table in special cases, but it must not fall back to workspace-wide re-indexing for ordinary edits.

## Semantic coverage strategy

The project should increase local coverage in this order:

```text
syntax / declarations
      ↓
symbols / bindings / references
      ↓
type resolution
      ↓
expression inference
      ↓
Godot API semantic database
      ↓
richer confidence-aware resolution
```

Do not solve missing engine semantics by embedding increasingly complex heuristics into the provider layer. Add the missing semantic model at the appropriate index/analyzer boundary.

## Non-goals

The semantic layer is not intended to become a second GDScript compiler. In particular, the current architecture does not require:

- whole-program control-flow analysis;
- a complete type lattice;
- generic/union types without concrete requirements;
- speculative dynamic dispatch resolution;
- persistent semantic storage before profiling justifies it.
