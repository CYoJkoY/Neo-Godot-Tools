# LSP Architecture

Neo-Godot-Tools is moving from a Godot-LSP-first client to a local-first language service. The goal is to make common editor operations independent of a running Godot editor while retaining Godot LSP as the high-fidelity semantic fallback.

## Boundaries

```text
VS Code providers / LSP facade
            |
            v
        Provider layer
            |
            v
        Analyzer facade
        /           \
       /             \
  Local analysis   Godot LSP fallback
       |
       v
  Incremental index
       |
       v
     Parser
```

### `analyzer/`

Owns GDScript syntax and language-model construction. It must not import `vscode`, open files, manage sockets, or call Godot. Phase 1 establishes a parser and a stable AST with source ranges and diagnostics.

### `index/`

Owns workspace state derived from parsed documents: file records, symbols, references, and dependencies. The index is incremental and receives already-parsed documents from the analyzer. It must not know about LSP transport.

### `providers/`

Owns LSP/editor-facing behavior. Providers ask the analyzer/index for local answers first and do not encode parser details. VS Code types remain at this boundary.

### `fallback/`

Owns the Godot LSP adapter. It is the compatibility path for semantic information that the local analyzer cannot confidently provide, including native engine classes, complex dynamic typing, GDExtension data, autoload/project state, and other engine-specific semantics.

## Request policy

| Operation | Initial target |
| --- | --- |
| document symbols | Local |
| workspace symbols | Local index |
| definition | Local first, fallback |
| references | Local index, fallback |
| rename | Local index, fallback when confidence is low |
| hover | Local first, fallback |
| completion | Local first, fallback |
| signature help | Local first, fallback |
| native/engine semantics | Godot LSP |

The router should prefer a local result only when the local model has enough information. It should not manufacture an answer from incomplete type information merely to avoid a Godot request.

## Incremental model

A document change invalidates one file first. The future index layer will update that file's symbols and references, then use a dependency graph to invalidate only affected dependents. The extension host should remain responsive; parser/index work can later move to a `worker_threads` worker once the synchronous model is stable.

## Phase 1

Phase 1 deliberately does **not** replace existing LSP providers. It establishes the parser boundary first:

- lexical tokens with source positions and indentation;
- AST nodes for script/class declarations, `class_name`, `extends`, signals, enums, constants, variables, and functions;
- typed function parameters and return types where explicitly written;
- function body ranges without attempting to semantically analyze statements;
- recoverable syntax diagnostics;
- parser unit tests independent of VS Code and Godot.

This keeps the migration reversible. Later phases can build the index on top of the AST without coupling the new subsystem to the current `GDScriptLanguageClient`.

## Phase 2

Phase 2 adds the first persistent-in-memory workspace model without introducing filesystem or VS Code dependencies into the index:

- `FileIndex` owns parsed file records keyed by URI;
- each update replaces only the affected file record;
- `collectSymbols()` converts analyzer declarations into index symbols, including nested class members;
- `SymbolIndex` maintains both per-file symbols and a workspace name index;
- symbol updates are incremental: remove the old file contribution, then add the new one;
- workspace queries are case-insensitive substring searches over indexed symbols;
- file deletion removes its symbols from the workspace index;
- index tests verify replacement, removal, duplicate symbol names, nested declarations, and workspace queries.

The index intentionally does not read the workspace itself. A later workspace scanner/document manager will own filesystem and `TextDocument` integration and feed parsed results into `FileIndex`. This keeps indexing deterministic and makes the same core usable for open documents, disk files, and future worker-thread execution.

Phase 2 also deliberately does **not** wire providers to the new index yet. The next stage can therefore introduce local `documentSymbol`, `workspaceSymbol`, and definition resolution behind a small facade while preserving the existing Godot LSP behavior until each operation has a confidence-aware fallback path.

## Compatibility

The existing extension already targets Godot 4 in CI. The parser therefore avoids embedding engine-specific APIs and keeps grammar constructs represented as syntax rather than hard-coded engine types. Version-specific semantic rules belong above the parser so that Godot 3.x compatibility can be evaluated without rewriting the core syntax pipeline.
