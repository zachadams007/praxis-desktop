# Creates a "Flight Deck" shortcut (own teal icon) that opens the Flight Deck
# window directly. Because Praxis runs single-instance, double-clicking this
# routes into the already-running Praxis (tray/autostart) instead of launching a
# duplicate; if Praxis isn't running, it starts it hidden and opens Flight Deck.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\make-flight-deck-shortcut.ps1
# Optional: -Exe <path to praxis.exe>   -Dest <folder for the .lnk (default: Desktop)>
param(
  [string]$Exe = "",
  [string]$Dest = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if (-not $Exe) {
  $candidates = @(
    (Join-Path $repo "src-tauri\target\release\praxis.exe"),
    (Join-Path $env:LOCALAPPDATA "Praxis\praxis.exe"),
    (Join-Path ${env:ProgramFiles} "Praxis\praxis.exe")
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $Exe = $c; break } }
}
if (-not $Exe -or -not (Test-Path $Exe)) {
  throw "Could not find praxis.exe. Build it first (npm run tauri build) or pass -Exe."
}

$icon = Join-Path $repo "src-tauri\icons\flightdeck.ico"
if (-not (Test-Path $icon)) { throw "Missing icon: $icon (run node scripts/gen-fd-icon.mjs)" }

if (-not $Dest) { $Dest = [Environment]::GetFolderPath("Desktop") }
$lnk = Join-Path $Dest "Flight Deck.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $Exe
$sc.Arguments = "--flight-deck"
$sc.IconLocation = "$icon,0"
$sc.WorkingDirectory = Split-Path -Parent $Exe
$sc.Description = "Flight Deck - mission control for your parallel Claude sessions"
$sc.Save()

Write-Host "Created shortcut: $lnk"
Write-Host "  target: $Exe --flight-deck"
Write-Host "  icon:   $icon"
