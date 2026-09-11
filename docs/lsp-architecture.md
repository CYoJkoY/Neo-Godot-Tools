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

## Phase 8 — Cross-file semantic resolution

Phase 8 turns the Phase 7 type/dependency foundation into a usable cross-file semantic path without attempting to become a complete GDScript type checker.

### Script type inference

Local types can now be recovered from several safe forms:

- explicit annotations such as `var player: Player`;
- `preload("res://player.gd").new()` initializers;
- explicitly typed function return values such as `func make_player() -> Player` followed by `var player = make_player()`;
- `self` for the current script.

The resolver maps a local script path to its unique `class_name` when available. Ambiguous paths or classes remain unresolved.

### Inheritance-aware members

A locally resolved script now exposes its own members plus members inherited from a locally resolvable `extends` target. Child declarations override inherited names. Cyclic inheritance is guarded by a visited set.

This makes patterns such as the following stay entirely local:

```gdscript
class_name Base
var base_health: int
```

```gdscript
class_name Player
extends Base
var health: int
```

A `Player` receiver can therefore resolve both `health` and `base_health` without asking Godot LSP.

### Cross-file receiver examples

```gdscript
var player: Player
player.health
```

```gdscript
var player = preload("res://player.gd").new()
player.take_damage(10)
```

```gdscript
func make_player() -> Player:
	return Player.new()

var player = make_player()
player.health
```

The resolver deliberately does not infer arbitrary expressions, control-flow-dependent types, or native engine APIs. Those cases continue to use Godot LSP.

### Dependency invalidation

`DependencyGraph` now exposes transitive reverse dependents. A change to a base script can identify the local scripts whose semantic caches may become stale without rebuilding the entire workspace.

Phase 8 still performs synchronous per-file index updates. The dependency graph is an invalidation boundary, not yet a background scheduler or persistent cache.

## Provider behavior

Definition, hover, and member completion continue to follow this order:

```text
local binding / expression
          ↓
     local script type
          ↓
   inherited local members
          ↓
      local symbol
          ↓
     Godot LSP fallback
```

Native engine classes, dynamic values, ambiguous class names, unsupported expressions, and unresolved dependencies intentionally fall through to Godot LSP.

## Deliberate limits

Phase 8 does not implement a complete GDScript type lattice, control-flow analysis, generic types, union types, lambda capture analysis, or engine API indexing. It also does not guess the type of an unannotated arbitrary expression.

The next optimization target should be semantic cache invalidation and parser/index scheduling, followed by profiling before introducing worker threads or considering a Rust implementation.
