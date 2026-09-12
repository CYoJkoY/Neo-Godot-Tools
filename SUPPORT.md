# Support

Neo Godot Tools is an independent open-source project derived from the Godot Tools VS Code extension. This document describes the supported environments and the preferred support channels.

## Compatibility

| Component | CI / smoke-test coverage |
| --- | --- |
| Godot 3 | 3.6.2 |
| Godot 4 | 4.5.1 and 4.7 |
| Visual Studio Code | `^1.96.0` |
| Operating systems | Ubuntu and Windows in CI |

Godot 3.6.2 is the minimum Godot 3 release covered by the project's automated smoke tests. Older Godot 3 releases are not part of the release validation matrix.

Godot 4 compatibility is validated against the versions listed above; other Godot 4 releases may work but are not individually guaranteed by CI.

## Getting help

Before opening a new issue:

1. Check the [README](README.md) and the [FAQ](README.md#faq).
2. Check the [current changelog](CHANGELOG.md) for known changes or regressions.
3. Make sure the problem reproduces with a supported Godot and VS Code version.
4. Restart VS Code and the Godot editor before reporting language-server connection issues.

For a bug report, use the repository's [bug report template](https://github.com/CYoJkoY/Neo-Godot-Tools/issues/new?template=bug_report.yml) and include:

- Neo Godot Tools version
- VS Code version
- Godot version
- operating system
- whether the project uses Godot 3 or Godot 4
- minimal reproduction steps
- relevant logs or error messages

For feature requests, use the [feature request template](https://github.com/CYoJkoY/Neo-Godot-Tools/issues/new?template=feature_request.yml).

## Security issues

Do not disclose security-sensitive issues in a public issue. Report them privately through the repository's GitHub security reporting mechanism when available.

## Scope

Support is provided for Neo Godot Tools itself. Issues caused by unrelated VS Code extensions, Godot engine bugs, unsupported editor versions, or third-party tooling may require reporting to their respective upstream projects.
