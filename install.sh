#!/bin/sh
# Installs opencode-goal-plugin into the global OpenCode plugins directory.
#
# Works on macOS, Linux, WSL, and Git Bash on Windows.
#
# Why a directory and not a loader file
# -------------------------------------
# OpenCode resolves a plugin package's `exports` targets relative to the package
# root and does not look inside subdirectories for them. A single loader file
# works for the server half, but there is no package next to it, so the host has
# no exports map to resolve the ./tui entrypoint from and the terminal half never
# loads. Installing the package as a directory is what makes both halves register.
#
# Re-running refreshes the copy. Removing the directory uninstalls.
#
# Pass -f to overwrite an installation that is not this folder.

set -eu

force=0
for arg in "$@"; do
  case "$arg" in
    -f | --force) force=1 ;;
    -h | --help)
      echo "usage: sh install.sh [-f]"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

script="$0"
while [ -L "$script" ]; do
  link=$(readlink "$script")
  case "$link" in
    /*) script="$link" ;;
    *) script="$(dirname "$script")/$link" ;;
  esac
done
plugin_root=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd -P)

# The server entrypoint is the compiled dist/index.js, so the build has to be
# current. Copying a stale bundle is how a source fix silently fails to take
# effect, which cost an afternoon once already.
if command -v bun >/dev/null 2>&1; then
  (cd "$plugin_root" && bun run build) >/dev/null 2>&1 || echo "warning: build failed, installing the existing dist" >&2
else
  echo "warning: bun not found, installing the existing dist; run the build if your source is newer" >&2
fi

[ -f "$plugin_root/index.js" ] || { echo "Plugin entry not found: $plugin_root/index.js" >&2; exit 1; }
[ -f "$plugin_root/dist/index.js" ] || { echo "Compiled entrypoint not found: $plugin_root/dist/index.js" >&2; exit 1; }

if [ -n "${XDG_CONFIG_HOME:-}" ]; then config_home="$XDG_CONFIG_HOME"; else config_home="$HOME/.config"; fi
plugins_dir="$config_home/opencode/plugins"
dest="$plugins_dir/opencode-goal-plugin"
# A leftover single-file loader would register a second, UI-less copy.
legacy="$plugins_dir/goal.ts"

if [ -e "$legacy" ] && [ "$force" -eq 0 ]; then
  echo "Found a previous loader file at $legacy" >&2
  echo "Re-run with -f to remove it and install the package directory." >&2
  exit 1
fi

mkdir -p "$plugins_dir"
rm -rf "$dest"
mkdir -p "$dest"

for item in package.json index.js tui.tsx rpc.ts goal.config.json README.md LICENSE CHANGELOG.md; do
  [ -e "$plugin_root/$item" ] && cp -R "$plugin_root/$item" "$dest/"
done
cp -R "$plugin_root/dist" "$dest/"
cp -R "$plugin_root/src" "$dest/"

# The terminal half needs solid-js and the OpenTUI packages at runtime. The
# config directory's node_modules is the tree the host resolves from, so the
# declared dependencies are vendored there.
cfg_nm="$config_home/opencode/node_modules"
if [ -d "$plugin_root/node_modules" ]; then
  mkdir -p "$cfg_nm"
  for dep in solid-js; do
    [ -d "$plugin_root/node_modules/$dep" ] && rm -rf "$cfg_nm/$dep" && cp -R "$plugin_root/node_modules/$dep" "$cfg_nm/"
  done
  if [ -d "$plugin_root/node_modules/@opentui" ]; then
    mkdir -p "$cfg_nm/@opentui"
    for dep in core solid; do
      [ -d "$plugin_root/node_modules/@opentui/$dep" ] && rm -rf "$cfg_nm/@opentui/$dep" && cp -R "$plugin_root/node_modules/@opentui/$dep" "$cfg_nm/@opentui/"
    done
  fi
fi

[ -e "$legacy" ] && rm -f "$legacy"

echo "Installed: $dest"
echo "Run 'opencode reload', restart the TUI, then /goal help in a session."
