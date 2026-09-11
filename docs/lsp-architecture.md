# GDScript local-first language architecture

Neo-Godot-Tools keeps common GDScript editor intelligence local and uses Godot LSP only when the local model cannot answer safely.

```text
VS Code Providers
        │
        ▼
  LanguageService
   /     |      \
Hover Completion SignatureHelp
   \     |      /
    Symbol + Binding + Reference
              │
           Analyzer
              │
            Parser
              │
      Godot LSP fallback
```

## Phase 6 — Local-first Hover / Completion / Signature Help

Phase 6 extends the local-first boundary to three interactive editor features. The implementation does not perform global string matching as its primary mechanism.

### Hover

Hover first resolves the identifier through `BindingIndex`. Binding metadata supplies scope-aware identity and local type information; `SymbolIndex` supplies declaration kind, container, return type, and function parameters. An unresolved or ambiguous symbol falls through to `textDocument/hover` through `HoverFallback`.

### Completion

Completion starts with `BindingIndex.getVisibleBindings()` so parameters, locals, members, functions, and script-level declarations respect lexical shadowing. `SymbolIndex.workspaceSymbols()` supplements visible bindings with workspace declarations. `self.<member>` is handled locally because the receiver identity is explicit. Arbitrary `object.<member>` expressions remain fallback territory because resolving them safely requires type information that the current analyzer does not yet provide.

### Signature help

Function declarations now retain parameter metadata in `IndexedSymbol`: parameter names, types, default values, and return type. For an unambiguous local function call, signature help is generated locally and the active parameter is derived from the current argument list. Native, dynamic, or ambiguous calls fall through to Godot LSP.

### Fallback boundary

The fallback adapters own LSP transport details. Providers and `LanguageService` only decide whether local confidence is sufficient. This preserves the architecture's main performance goal: normal project-local interactions do not need to synchronously ask Godot's language server to analyze the workspace again.

## Deliberate limits

Phase 6 is not a complete GDScript type checker. It deliberately does not infer arbitrary receiver types, resolve engine classes, inspect GDExtension APIs, or model every dynamic language construct. Those cases continue to use Godot LSP.

The next semantic layer should improve dependency/type information rather than replacing the local model with broader text matching.
