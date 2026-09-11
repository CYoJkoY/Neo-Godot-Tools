# Roadmap Stage — 2026-09-12: Semantic production hardening

This stage continues the local-first semantic architecture after the control-flow and LSP hardening work. The goal is to increase useful local inference while keeping unsupported or ambiguous constructs on Godot's native LSP fallback path.

## Implemented in this stage

### Inferred local declarations

The range-aware local statement collector now recognizes GDScript's `:=` initializer form in addition to explicit `=` assignments. This makes common inferred declarations participate in the same incremental type-resolution path as ordinary assignments.

### Member-value type propagation

Member resolution now propagates declared member types as well as function return types. A local expression such as `local_player.health` can therefore resolve through:

```text
local_player
    ↓
Player
    ↓
health: int
    ↓
int
```

The resolver remains conservative when a receiver or member cannot be resolved uniquely.

### Scale benchmark refinement

The synthetic 100 / 500 / 1,000 / 5,000-file benchmark now exercises the semantic query boundary rather than only the underlying type index. It measures warm-cache type, definition, hover, and completion queries alongside incremental edit latency and cold indexing.

The benchmark is still synthetic evidence. It must not be presented as representative of a real user workspace until a real project dataset is measured.

## Architectural boundary

The current local path is now:

```text
VS Code provider
    ↓
LanguageService
    ↓
SemanticQueryEngine
    ↓
File/Symbol/Binding/Reference/Type indexes
    ↓
lexer/range-aware local analysis
```

Godot LSP remains authoritative for:

- engine-native API semantics;
- dynamic or unsupported expressions;
- ambiguous local inference;
- semantic states that do not meet the local confidence policy.

## Next evidence-driven work

The next large batch should use real Godot projects to measure:

1. cold workspace indexing;
2. document open and incremental edits;
3. rapid-typing completion latency;
4. definition, hover, references, rename, and signature help;
5. provider-to-LSP fallback frequency;
6. extension-host CPU and memory;
7. performance across Godot 3.x and 4.x projects where compatibility is required.

Only those measurements should determine whether persistent disk caching, worker threads, or a larger AST/expression model are justified.

## Deliberately not implemented

This stage does not introduce a compiler-equivalent GDScript AST, whole-program control-flow analysis, generic/union type inference, or worker-thread infrastructure merely to increase feature count. Those changes remain conditional on measured demand and correctness requirements.
