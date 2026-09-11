# GDScript local-first language architecture

Neo-Godot-Tools keeps common GDScript editor intelligence local and uses Godot LSP only when the local model cannot answer safely.

```text
VS Code Providers
        │
        ▼
  LanguageService
   /      |       \
Local Index  Type Resolution  Dependency Graph
   \      |       /
 Symbol + Binding + Reference
              │
           Analyzer
              │
            Parser
              │
      Godot LSP fallback
```

## Phase 7 — Dependency Graph + Type Resolution Foundation

Phase 7 adds the semantic bridge between a binding and the script/class that provides its members. It is intentionally a conservative type-resolution layer, not a full GDScript type checker.

### Type resolution

`TypeResolutionIndex` resolves explicit annotation types against local `class_name` and inner-class symbols. Built-in Godot/GDScript types are recognized as terminal types without pretending that their engine members are locally known.

A receiver can now be resolved from a binding or script-level declaration. This enables local member lookup for patterns such as `player.health` when `player` is explicitly typed as a locally indexed class. `self.member` remains local because its receiver is the current script.

Ambiguous, dynamic, native-engine, and otherwise unresolved types continue to use Godot LSP.

### Dependency graph

`DependencyGraph` records local `extends` and `preload("res://...")` relationships. It maintains both outgoing dependencies and reverse dependents, so a changed script can identify the files whose semantic context may need invalidation.

The graph is deliberately separate from the symbol index. A dependency edge describes file-to-file semantic coupling; a symbol describes a declaration inside a file.

### Provider behavior

Definition, hover, and completion now recognize typed member receivers before falling back to Godot LSP:

```gdscript
class_name Player
var health: int
```

```gdscript
var player: Player
player.health
```

The local path is:

```text
receiver binding
      ↓
explicit type
      ↓
class_name / local class
      ↓
member symbol
```

### Invalidation boundary

Every file update refreshes its dependency edges. Reverse dependencies are retained so later semantic caches can invalidate only affected files rather than rebuilding the whole workspace. Phase 7 does not yet introduce a persistent cache or background worker; those should be added only after profiling demonstrates a need.

## Deliberate limits

Phase 7 does not attempt to infer arbitrary expressions, resolve every built-in engine member, evaluate control flow, or build a complete GDScript type lattice. `object.member` is local only when the receiver has a uniquely resolvable local type. Dynamic values and native engine APIs remain Godot LSP fallback cases.

The next layer should build on this type/dependency graph for safer cross-file definitions, member completion, and semantic invalidation rather than returning to workspace-wide text matching.
