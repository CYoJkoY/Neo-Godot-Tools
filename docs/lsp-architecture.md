# LSP Architecture

Neo-Godot-Tools is moving from a Godot-LSP-first client to a local-first language service. The goal is to make common editor operations independent of a running Godot editor while retaining Godot LSP as the high-fidelity semantic fallback.

## Boundaries

```text
VS Code providers
        |
        v
   LanguageService
      /       \
 Local index   Godot LSP fallback
      |
      v
 Incremental workspace state
      |
      v
    Analyzer
      |
      v
     Parser
```

### `analyzer/`

Owns GDScript syntax and language-model construction. It must not import `vscode`, open files, manage sockets, or call Godot.

### `index/`

Owns workspace state derived from parsed documents: files, symbols, references, and dependencies. It is incremental and must not know about LSP transport or VS Code.

### `language/`

Owns the application-level language service that coordinates the index and fallback. VS Code document/file-system integration lives here because this layer feeds the pure index and decides whether a local answer is sufficiently confident.

### `providers/`

Owns VS Code editor-facing behavior. Providers convert local results into VS Code types and do not call `globals.lsp` directly for migrated operations.

### `fallback/`

Owns the Godot LSP adapter. It is the compatibility path for native engine classes, dynamic typing, GDExtension data, autoload/project state, and other engine-specific semantics.

## Request policy

| Operation | Current target |
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

The router must not manufacture an answer from incomplete type information merely to avoid a Godot request.

## Incremental model

A document change reparses only that document and replaces its `FileIndex` record. `SymbolIndex` and `ReferenceIndex` remove the old contribution and add the new one. The workspace scanner yields between files so large projects do not monopolize the extension-host event loop. A future dependency graph will invalidate affected dependents; parser/index work can later move to `worker_threads` if profiling proves it is CPU-bound.

## Phase 1 — parser foundation

- lexical tokens with source positions and indentation;
- AST nodes for script/class declarations, `class_name`, `extends`, signals, enums, constants, variables, and functions;
- typed function parameters and return types where explicitly written;
- function body ranges without attempting to semantically analyze statements;
- recoverable syntax diagnostics.

## Phase 2 — incremental index

- `FileIndex` owns parsed file records keyed by URI;
- each update replaces only the affected file record;
- `collectSymbols()` converts analyzer declarations into index symbols, including nested class members;
- `SymbolIndex` maintains per-file symbols and a workspace name index;
- symbol updates remove the old file contribution before adding the new one;
- file deletion removes its symbols from the workspace index.

## Phase 3 — local-first language service

### Local document symbols

`GDDocumentSymbolProvider` reads only the local `FileIndex` and exposes indexed declarations to VS Code.

### Local workspace symbols

`GDWorkspaceSymbolProvider` queries `SymbolIndex` directly. Open documents are indexed from their in-memory contents so unsaved edits are visible immediately.

### Local-first definition

`LanguageService.getDefinition()` returns a local declaration only when the matching declaration is unambiguous. Otherwise it delegates to `DefinitionFallback`.

### Godot LSP fallback

`DefinitionFallback` is isolated from provider code and converts standard `textDocument/definition` responses into VS Code locations.

## Phase 4 — local reference index

Phase 4 extends the same local-first boundary to **Find All References**.

### Reference extraction

`ReferenceIndex` tokenizes each indexed GDScript file and records identifier occurrences. Comments and string literals are naturally excluded by the lexer. Language keywords are excluded from the reference set.

This is intentionally a conservative lexical reference model, not a full type resolver. A local result is returned only when the requested name maps to exactly one indexed declaration across the workspace. If multiple declarations share the name, or the local index has no usable declaration, the request falls through to Godot LSP.

### Incremental synchronization

When a document changes, its file, symbols, and references are replaced independently. When a file is deleted, all three contributions are removed. No workspace-wide rebuild is required for an ordinary edit.

### Fallback

`ReferencesFallback` owns the `textDocument/references` request. This keeps transport-specific code out of `LanguageService` and the VS Code provider.

### Why rename is not included yet

Rename requires an edit-safe binding model. A lexical occurrence index is not sufficient because the same identifier can legally refer to different declarations in different scopes. Phase 4 therefore does **not** expose local rename edits. The next semantic step should introduce scope-aware bindings before local rename is enabled.

## Compatibility

The existing extension targets Godot 4 in CI and retains Godot 3.x-oriented configuration paths. The local parser remains engine-agnostic. Engine-specific semantics continue to belong to the fallback layer rather than being hard-coded into the analyzer or index.
