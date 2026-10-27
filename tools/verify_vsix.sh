#!/usr/bin/env bash
# Verifies that a packaged VSIX carries both native sidecar binaries and no
# build intermediates. Usage: bash tools/verify_vsix.sh <path to vsix>
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: bash tools/verify_vsix.sh <path to vsix>" >&2
  exit 2
fi

vsix_path="$1"
if [ ! -f "$vsix_path" ]; then
  echo "VSIX not found: $vsix_path" >&2
  exit 1
fi

unzip -t "$vsix_path" > /dev/null

listing="$(unzip -Z1 "$vsix_path")"

require_entry() {
  local entry="$1"
  if ! printf '%s\n' "$listing" | grep -Fxq "$entry"; then
    echo "Missing required entry: $entry" >&2
    exit 1
  fi
}

reject_entry() {
  local description="$1"
  local pattern="$2"
  local matches
  matches="$(printf '%s\n' "$listing" | grep -E "$pattern" || true)"
  if [ -n "$matches" ]; then
    echo "Unexpected $description inside the VSIX:" >&2
    printf '%s\n' "$matches" >&2
    exit 1
  fi
}

require_entry "extension/backend/zig-out/bin/neo-godot-backend"
require_entry "extension/backend/zig-out/bin/neo-godot-backend.exe"

reject_entry "debug symbols" '\.pdb$'
reject_entry "compiler caches" '\.zig-cache/'
reject_entry "backend sources" '^extension/backend/src/'
reject_entry "backend build files" '^extension/backend/build\.zig'
reject_entry "backend package metadata" '^extension/backend/build\.zig\.zon$'

# vsce stores the file mode the binary has on the packaging host. A Windows
# checkout has no executable bit, so a VSIX packaged there carries mode 0666 and
# the Linux binary fails to start after install. Releases are packaged on Linux.
python3 - "$vsix_path" <<'PY'
import sys
import zipfile

vsix_path = sys.argv[1]
target = "extension/backend/zig-out/bin/neo-godot-backend"

with zipfile.ZipFile(vsix_path) as archive:
    try:
        info = archive.getinfo(target)
    except KeyError:
        print(f"Missing required entry: {target}", file=sys.stderr)
        raise SystemExit(1)

mode = info.external_attr >> 16
if mode & 0o111 == 0:
    print(f"{target} is not executable inside the VSIX (unix mode {oct(mode)}).", file=sys.stderr)
    print("Package the VSIX on Linux; chmod +x the binary before packaging.", file=sys.stderr)
    raise SystemExit(1)
print(f"{target} unix mode {oct(mode)}")
PY

echo "VSIX verification passed: $vsix_path"
