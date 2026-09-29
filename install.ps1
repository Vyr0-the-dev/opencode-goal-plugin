<#
.SYNOPSIS
  Installs opencode-goal-plugin into the global OpenCode plugins directory.

.DESCRIPTION
  Why a directory and not a loader file
  -------------------------------------
  OpenCode resolves a plugin package's `exports` targets relative to the package
  root and does not look inside subdirectories for them. A single loader file
  works for the server half, but there is no package next to it, so the host has
  no exports map to resolve the ./tui entrypoint from and the terminal half never
  loads. Installing the package as a directory is what makes both halves register.

  Installing as a directory also makes the ./rpc surface resolvable by other
  clients, which a loader file cannot do.

  Re-running refreshes the copy. Removing the directory uninstalls.

.PARAMETER Force
  Remove a previous single-file loader before installing.
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# The server entrypoint is the compiled dist/index.js, so the build has to be
# current. Copying a stale bundle is how a source fix silently fails to take
# effect, which cost an afternoon once already.
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCmd) {
  Push-Location $pluginRoot
  try {
    & bun run build | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "bun run build failed; installing the existing dist anyway."
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Warning "bun was not found on PATH; installing the existing dist. Run 'bun run build' first if your source is newer."
}

$entry = Join-Path $pluginRoot "index.js"
if (-not (Test-Path $entry)) {
  throw "Plugin entry not found: $entry"
}
$distEntry = Join-Path $pluginRoot "dist\index.js"
if (-not (Test-Path $distEntry)) {
  throw "Compiled entrypoint not found: $distEntry"
}

$configHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $env:USERPROFILE ".config" }
$pluginsDir = Join-Path $configHome "opencode\plugins"
$dest = Join-Path $pluginsDir "opencode-goal-plugin"
$legacy = Join-Path $pluginsDir "goal.ts"

if ((Test-Path $legacy) -and -not $Force) {
  Write-Host "Found a previous loader file at $legacy" -ForegroundColor Yellow
  Write-Host "Re-run with -Force to remove it and install the package directory."
  exit 1
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($item in @("package.json", "index.js", "tui.tsx", "rpc.ts", "goal.config.json", "README.md", "LICENSE", "CHANGELOG.md")) {
  $from = Join-Path $pluginRoot $item
  if (Test-Path $from) { Copy-Item $from $dest -Recurse -Force }
}
foreach ($dir in @("dist", "src")) {
  $from = Join-Path $pluginRoot $dir
  if (Test-Path $from) {
    $to = Join-Path $dest $dir
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    Copy-Item $from $to -Recurse -Force
  }
}

# The terminal half needs solid-js and the OpenTUI packages at runtime. The
# config directory's node_modules is the tree the host resolves from.
$cfgNm = Join-Path $configHome "opencode\node_modules"
$devNm = Join-Path $pluginRoot "node_modules"
if (Test-Path $devNm) {
  New-Item -ItemType Directory -Force -Path $cfgNm | Out-Null
  foreach ($dep in @("solid-js")) {
    $from = Join-Path $devNm $dep
    if (Test-Path $from) {
      $to = Join-Path $cfgNm $dep
      if (Test-Path $to) { Remove-Item $to -Recurse -Force }
      Copy-Item $from $to -Recurse -Force
    }
  }
  $opentui = Join-Path $devNm "@opentui"
  if (Test-Path $opentui) {
    New-Item -ItemType Directory -Force -Path (Join-Path $cfgNm "@opentui") | Out-Null
    foreach ($dep in @("core", "solid")) {
      $from = Join-Path $opentui $dep
      if (Test-Path $from) {
        $to = Join-Path $cfgNm "@opentui\$dep"
        if (Test-Path $to) { Remove-Item $to -Recurse -Force }
        Copy-Item $from $to -Recurse -Force
      }
    }
  }
}

if (Test-Path $legacy) { Remove-Item $legacy -Force }

Write-Host "Installed: $dest"
Write-Host "Run 'opencode reload', restart the TUI, then /goal help in a session."
