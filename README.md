# Neo Godot Tools

Godot development tools for Visual Studio Code with local-first GDScript intelligence, incremental project indexing, documentation, debugging, and Godot Language Server integration.

> **Independent project:** Neo Godot Tools is a substantially modified derivative of the original [Godot Tools VS Code extension](https://github.com/godotengine/godot-vscode-plugin). It is not an official Godot Engine project and is not affiliated with or endorsed by the Godot Foundation. See [Provenance and Notices](NOTICE.md) for details.

- [Features](#features)
- [Compatibility](#compatibility)
- [Installation](#installation)
- [Release channels](#release-channels)
- [Commands](#commands)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Support](#support)
- [Issues and contributions](#issues-and-contributions)
- [License and provenance](#license-and-provenance)
- [FAQ](#faq)
  - [Why does it fail to connect to the language server?](#why-does-it-fail-to-connect-to-the-language-server)
  - [Why isn't IntelliSense displaying script members?](#why-isnt-intellisense-displaying-script-members)
  - [Can Godot reload external script changes automatically?](#can-godot-reload-external-script-changes-automatically)
  - [Why isn't drag and shift-drop working on Linux?](#why-isnt-drag-and-shift-drop-working-on-linux)

## Features

- **GDScript (`.gd`) language features**
  - syntax highlighting
  - project-symbol definition lookup
  - Godot native class and member documentation lookup
  - `res://` resource links and hover previews
  - builtin code formatter
  - autocompletion
  - local semantic analysis for project symbols
  - incremental indexing for responsive project-wide language features
  - typed GDScript support
  - optional Smart Mode for dynamically typed scripts
  - function and variable hover information, including doc-comments
  - scene/script switching (`Alt+O` by default)
  - script warnings and errors
- **GDScript Debugger**
  - breakpoints, exceptions, and stepping
  - variable watch and call stack
  - current project/current file/pinned file launch targets
  - active scene tree and inspector
  - editable primitive values in the inspector
- **GDResource (`.tscn`, `.tres`, and related resources)**
  - syntax highlighting
  - symbol and resource definition lookup
  - hover previews for external and sub-resources
  - inlay hints
  - in-editor Scene Preview
- **GDShader (`.gdshader`)** syntax highlighting

## Compatibility

| Component | Release validation |
| --- | --- |
| Godot 3 | **3.6.2** smoke-tested in CI |
| Godot 4 | **4.5.1** and **4.7** smoke-tested in CI |
| Visual Studio Code | `^1.96.0` |
| CI platforms | Ubuntu and Windows |

Godot 3 releases older than 3.6 are outside the automated release-validation matrix. Other Godot 4 releases may work, but are not individually covered by the CI matrix.

## Installation

### Visual Studio Marketplace

The Marketplace is the recommended installation channel because it provides normal extension update handling.

- [Neo Godot Tools on Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=CYoJkoY.neo-godot-tools)

### GitHub Releases

Stable VSIX packages are also attached to [GitHub Releases](https://github.com/CYoJkoY/Neo-Godot-Tools/releases). This is useful when installing a specific version or testing a package outside the Marketplace.

### Development builds

Development builds are produced by [GitHub Actions](https://github.com/CYoJkoY/Neo-Godot-Tools/actions). They are intended for development and validation rather than normal production use.

To install a VSIX manually, use VS Code's **Extensions → ... → Install from VSIX...** command.

## Release channels

Neo Godot Tools deliberately separates its release channels:

- **GitHub Release** — the canonical repository release artifact. Stable tags use `vX.Y.Z`; development tags use `vX.Y.Z.devN` and are published as GitHub pre-releases.
- **Visual Studio Marketplace** — stable releases only. Marketplace publication is performed by a dedicated GitHub Actions workflow using VS Code Marketplace OIDC trusted publishing; it does not use a long-lived Azure DevOps PAT.

GitHub Releases and Marketplace publication are therefore independently automated and can be diagnosed independently.

## Commands

Commands are grouped under **Neo Godot Tools** in the VS Code Command Palette.

- Open workspace with Godot editor
- Open EditorSettings
- Start or stop the GDScript Language Server
- List Godot native classes
- Inspect and refresh debugger views
- Debug the current or pinned scene/script
- Pin and unpin scene files
- Open Scene Preview and related resources
- Switch between a scene and its script
- Copy resource paths

## Configuration

### Godot editor integration

To use VS Code as the external script editor in Godot:

1. Open **Editor Settings**.
2. Select **Text Editor → External**.
3. Enable **Use External Editor**.
4. Set the VS Code executable as **Exec Path**.
5. Use `{project} --goto {file}:{line}:{col}` as **Exec Flags**.

For automatic reloads, also review Godot's external-change and focus-loss settings.

### VS Code settings

Extension settings use the `neoGodotTools.*` namespace:

- `neoGodotTools.editorPath.godot3`
- `neoGodotTools.editorPath.godot4`
- `neoGodotTools.editor.verbose`
- `neoGodotTools.editor.revealTerminal`
- `neoGodotTools.lsp.serverHost`
- `neoGodotTools.lsp.serverPort`
- `neoGodotTools.lsp.headless`
- `neoGodotTools.lsp.autoReconnect.*`
- `neoGodotTools.documentation.*`
- `neoGodotTools.formatter.*`
- `neoGodotTools.scenePreview.*`
- `neoGodotTools.inlayHints.*`

When the selected Godot version supports headless LSP operation, Neo Godot Tools can launch a windowless Godot process for the language server.

## Architecture

Neo Godot Tools is no longer a thin wrapper around the upstream Godot Tools architecture. The current implementation is organized around a local-first language intelligence pipeline:

```text
VS Code extension
       │
       ├── Local GDScript semantic analysis
       │        └── Incremental project index
       │
       ├── Godot resource / scene / shader tooling
       │
       ├── Debugger and editor integration
       │
       └── Godot LSP
              └── advanced semantic fallback / engine integration
```

Detailed design and development documents are available in [`docs/`](docs/):

- [Development roadmap](docs/development-roadmap.md)
- [Semantic architecture](docs/semantic-architecture.md)
- [LSP architecture](docs/lsp-architecture.md)
- [Semantic benchmarking](docs/semantic-benchmarking.md)
- [Performance profiling](docs/performance-profiling.md)
- [LSP call audit](docs/lsp-call-audit.md)

## Support

See [SUPPORT.md](SUPPORT.md) for the supported-version matrix, troubleshooting guidance, and issue-reporting requirements.

## Issues and contributions

Neo Godot Tools is an open-source community project derived from the Godot VS Code tooling ecosystem. Bug reports, feature requests, documentation fixes, and focused pull requests are welcome.

Before opening an issue, check the [FAQ](#faq), [SUPPORT.md](SUPPORT.md), and [changelog](CHANGELOG.md).

For development workflow details, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License and provenance

Neo Godot Tools is distributed under the **MIT License**. The project preserves the upstream Godot Tools copyright and license terms while adding copyright to original Neo Godot Tools modifications and contributions.

- [LICENSE](LICENSE)
- [NOTICE.md](NOTICE.md)
- Upstream: [godotengine/godot-vscode-plugin](https://github.com/godotengine/godot-vscode-plugin)

## FAQ

### Why does it fail to connect to the language server?

- Verify that the installed Godot version is supported by the project; Godot 3.6.2 and current CI-covered Godot 4 versions are the release-validation targets.
- Open the project in the Godot editor before opening it in VS Code.
- If the editor was started after VS Code, retry the language-server connection.
- Verify that the LSP host and port match between Godot and VS Code.

### Why isn't IntelliSense displaying script members?

GDScript is gradually typed, so some dynamic code cannot be resolved statically. Neo Godot Tools resolves many project-level symbols locally, while ambiguous or engine-dependent cases can still fall back to Godot's Language Server. Static typing generally improves result quality.

### Can Godot reload external script changes automatically?

Review these Godot Editor Settings:

- **Text Editor → Behavior → Files → Auto Reload Scripts on External Change**
- **Interface → Editor → Save on Focus Loss**
- **Interface → Editor → Import Resources When Unfocused**

### Why isn't drag and shift-drop working on Linux?

This can occur when VS Code is running under Wayland. If necessary, add `--ozone-platform=x11` to the VS Code launch flags so it runs through XWayland.
