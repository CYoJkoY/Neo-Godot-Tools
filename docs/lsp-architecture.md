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

Owns GDScript syntax and language-model construction. It must not import `vscode`, open files, manage sockets, or call Godot. Phase 1 establishes a parser and a stable AST with source ranges and diagnostics.

### `index/`

Owns workspace state derived from parsed documents: file records, symbols, references, and dependencies. The index is incremental and receives parsed documents from the analyzer. It must not know about LSP transport or VS Code.

### `language/`

Owns the application-level language service that coordinates the index and fallback. `LanguageService` also owns the VS Code document/file-system integration needed to feed the pure index. It decides whether a local answer is sufficiently confident before asking Godot LSP.

### `providers/`

Owns VS Code editor-facing behavior. Providers convert indexed results into VS Code types and do not call `globals.lsp` directly for migrated operations.

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

A document change reparses only that document and replaces its `FileIndex` record. `SymbolIndex` removes the old contribution and adds the new one. The workspace scanner runs incrementally and yields between files so large projects do not monopolize the extension-host event loop. A future dependency graph will invalidate only affected dependents; parser/index work can later move to `worker_threads` once profiling proves it is CPU-bound.

## Phase 1

Phase 1 deliberately did **not** replace existing LSP providers. It established the parser boundary first:

- lexical tokens with source positions and indentation;
- AST nodes for script/class declarations, `class_name`, `extends`, signals, enums, constants, variables, and functions;
- typed function parameters and return types where explicitly written;
- function body ranges without attempting to semantically analyze statements;
- recoverable syntax diagnostics;
- parser unit tests independent of VS Code and Godot.

## Phase 2

Phase 2 added the first persistent-in-memory workspace model without introducing filesystem or VS Code dependencies into the index:

- `FileIndex` owns parsed file records keyed by URI;
- each update replaces only the affected file record;
- `collectSymbols()` converts analyzer declarations into index symbols, including nested class members;
- `SymbolIndex` maintains both per-file symbols and a workspace name index;
- symbol updates are incremental: remove the old file contribution, then add the new one;
- workspace queries are case-insensitive substring searches;
- file deletion removes its symbols from the workspace index.

## Phase 3

Phase 3 connects the local model to real editor features while keeping Godot LSP as a fallback instead of the primary path.

### Local document symbols

`GDDocumentSymbolProvider` reads only the local `FileIndex`. It converts indexed declarations to VS Code `SymbolInformation`, including nested-class `containerName` metadata.

### Local workspace symbols

`GDWorkspaceSymbolProvider` queries `SymbolIndex` directly. The workspace scan indexes `.gd` files from the current workspace, while open documents always take precedence so unsaved edits are represented immediately.

### Local-first definition

`LanguageService.getDefinition()` resolves a symbol locally only when the result is unambiguous:

1. exactly one matching declaration exists in the current file;
2. otherwise exactly one matching declaration exists in the workspace;
3. otherwise the request is delegated to `DefinitionFallback`.

This deliberately avoids guessing when duplicate names or incomplete semantic information make the local result unsafe.

### Godot LSP fallback

`DefinitionFallback` is the only new definition path that talks to the Godot language client. It sends the standard `textDocument/definition` request and converts both `Location` and `LocationLink` responses into VS Code locations. Provider code therefore no longer needs to know the LSP transport details.

### Incremental workspace synchronization

`LanguageService` listens to opened/changed/saved documents and a `.gd` file-system watcher. Existing open documents are parsed from their in-memory text; closed files are read from disk. Deletion removes only the affected file and its symbol contribution.

## Compatibility

The existing extension targets Godot 4 in CI and retains Godot 3.x-oriented configuration paths. The local parser remains engine-agnostic. Engine-specific semantics continue to belong to the fallback layer rather than being hard-coded into the analyzer or index.
