# Semantic Architecture

This document defines the local semantic architecture of Neo-Godot-Tools. The design goal is to provide fast, incremental GDScript intelligence without duplicating Godot's complete semantic compiler.

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
        ┌──────────┴──────────┐
        ▼                     ▼
 Project Scope          Godot API Scope
        │                     │
        └──────────┬──────────┘
                   ▼
             LanguageService
                   │
                   ▼
              VS Code APIs
```

Godot LSP is outside the normal local hot path. It remains the authoritative fallback for semantics that the local model cannot establish safely.

## Semantic scopes

The semantic model is moving toward three explicit scopes:

### 1. GDScript built-in scope

Language-level functions and values such as:

- `abs()`
- `clamp()`
- `lerp()`
- `load()` / `preload()`
- `print()`
- `typeof()`

These are represented by the local builtin catalog and can participate in completion, hover, and signature help.

### 2. Godot Engine API scope

Native Godot classes and their members:

```text
Node
 ├── add_child()
 ├── get_child()
 ├── process_mode
 └── PROCESS_MODE_INHERIT

Vector2
 ├── length()
 ├── normalized()
 └── ZERO
```

Native documentation is exposed through the `.gddoc` documentation viewer. Native symbol lookup is currently obtained through a bounded Godot LSP query and normalized into a documentation target.

The long-term direction is to make this scope a first-class local API model rather than relying on LSP for every native member query.

### 3. Project scope

User-defined scripts, `class_name` declarations, functions, variables, members, inheritance, references, and resource paths are indexed locally.

## Query engine

`SemanticQueryEngine` is the single semantic read boundary. Providers should not independently traverse indexes or implement competing resolution rules.

Core responsibilities:

1. resolve symbols;
2. resolve definitions;
3. resolve references;
4. resolve hover information;
5. produce completion candidates;
6. resolve type/member relationships;
7. expose confidence;
8. track query dependencies;
9. determine whether explicit LSP fallback is required.

## Confidence model

```text
exact       — directly established by semantic data
inferred    — established by safe local inference
partial     — some information exists but resolution is incomplete
unknown     — no trustworthy local result
```

Routing is conservative:

```text
exact / safe inferred
        ↓
   local result

partial / unknown
        ↓
 explicit Godot LSP fallback
```

An empty result must not automatically be interpreted as an authoritative `exact` result. This distinction is important for native members and dynamic receivers.

## Definition resolution

Definition navigation has three principal paths.

```text
Ctrl+Click
    │
    ▼
Local semantic query
    │
    ├── project symbol → source location
    │
    └── unresolved
           ↓
Native symbol query
           ↓
Godot class/member
           ↓
.gddoc + member anchor
```

Resource links such as `res://foo/bar.gd` use the dedicated resource-navigation path.

Native class navigation and native member navigation must remain distinct from project-source definition lookup. A native method such as `Node.add_child()` should open the corresponding member section of the `Node` documentation, not produce an empty source definition.

## Type resolution

`TypeResolutionIndex` provides conservative `ResolvedType` information for local semantic operations.

Current foundations include:

- explicit and inferred declarations;
- literal types;
- built-in constructors such as `Vector2(...)`;
- `Type.new()` construction;
- `preload(...).new()` script construction;
- conservative `load(...)` resource inference;
- conditional expressions when both branches agree;
- assignment propagation;
- simple branch propagation;
- local function return inference;
- member call return propagation;
- declared member types;
- inheritance-aware member lookup.

The analyzer should prefer `unknown` over an unjustified type assertion.

## File snapshots and fingerprints

An indexed file contains source state, declarations, symbols, and semantic fingerprints.

```text
sourceFingerprint
      ↓
exact source identity

apiFingerprint
      ↓
public semantic shape
```

A body-only edit can preserve the API fingerprint and avoid unnecessary dependent invalidation. When an inferred public return type changes, the relevant source/API dependency signature must change so dependent member and return-type queries cannot reuse stale state.

## Dependency graph

Dependencies are extracted from constructs such as `extends` and `preload()`.

The graph tracks:

- outgoing edges;
- incoming dependent sets;
- unresolved target candidates.

When a previously unresolved target appears, only candidate dependents are refreshed.

## Query cache

A cache entry records the semantic state it actually depends on:

```text
Query cache entry
 ├── current file source/API snapshot
 ├── symbol lookup signatures
 ├── workspace completion signatures
 └── resolved receiver snapshots
```

```text
all dependencies unchanged → cache hit
any dependency changed     → recompute
```

This prevents both stale cross-file results and unnecessary workspace-wide invalidation.

## Incremental invalidation

| Change | Local file | Dependents |
| --- | --- | --- |
| `unchanged` | none | none |
| `body_changed` | refresh local semantic state | normally none |
| `dependency_changed` | refresh dependency state | affected topology |
| `api_changed` | refresh API state | transitive dependents |
| `file_added` | add indexes/topology | newly resolved dependents |
| `file_removed` | remove indexes | affected dependents |

The implementation may invalidate a small additional set when necessary for correctness, but ordinary edits must not trigger workspace-wide semantic rebuilding.

## Provider boundary

```text
VS Code Provider
      ↓
LanguageService
      ↓
SemanticQueryEngine
      ↓
Indexes / Analyzer
```

The parser, indexes, and query engine must not depend on VS Code provider objects.

## Non-goals

The local semantic layer is not intended to become a second GDScript compiler. It does not currently require:

- complete whole-program control-flow analysis;
- a compiler-equivalent type lattice;
- speculative dynamic dispatch;
- generic/union types without concrete requirements;
- persistent semantic storage without measured startup benefit.
