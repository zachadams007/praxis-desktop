# rpraxis - restart Praxis cleanly, then launch the dev build.
#
#   • frees the Vite dev port (1430) - kills whatever is listening
#   • kills any stray Praxis process (single-instance would otherwise SWALLOW the new
#     launch, leaving you staring at the old/dead window)
#   • kills orphaned vite / tauri node watchers
#   • then `npm run tauri dev` from the repo
#
# Run it any of these ways:
#   rpraxis                                  (after the profile function is installed)
#   powershell -ExecutionPolicy Bypass -File C:\Users\dev\Desktop\praxis\scripts\rpraxis.ps1
#   npm run praxis                           (from the repo)
$ErrorActionPreference = 'SilentlyContinue'

Write-Host "rpraxis: clearing port 1430 + stray Praxis..." -ForegroundColor Cyan
Get-NetTCPConnection -LocalPort 1430 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-Process praxis | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*vite*' -or $_.CommandLine -like '*tauri*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 2026-07-05: no longer wipes EBWebView here - that deleted Local Storage (tasks, trust,
# fleet picks, galaxy tuning). The app self-heals the corruptible cache dirs on startup
# (lib.rs clear_webview_caches) and keeps storage intact.
Start-Sleep -Milliseconds 700

# Default = restart the INSTALLED release app (what "r praxis" means to the owner).
# Pass -dev to get the old npm-run-tauri-dev loop instead.
if ($args -notcontains '-dev') {
  $installed = Join-Path $env:LOCALAPPDATA 'Praxis\praxis.exe'
  if (Test-Path $installed) {
    Write-Host "rpraxis: launching installed app $installed" -ForegroundColor Cyan
    Start-Process -FilePath $installed
    exit 0
  }
  Write-Host "rpraxis: installed exe missing - falling back to dev build" -ForegroundColor Yellow
}

Set-Location 'C:\Users\dev\Desktop\praxis'

# Load the Groq voice key into the env so STT/TTS always resolve it (env is the documented
# primary source; this also covers any flaky on-disk path read). Reads the existing key file -
# does NOT create a new copy of the secret.
$keyFile = Join-Path $env:LOCALAPPDATA 'Praxis\groq.key'
if (Test-Path $keyFile) {
  $env:GROQ_API_KEY = (Get-Content $keyFile -Raw).Trim()
  Write-Host "rpraxis: GROQ_API_KEY loaded ($($env:GROQ_API_KEY.Length) chars)" -ForegroundColor Cyan
} else {
  Write-Host "rpraxis: WARNING no groq.key found - voice will be disabled" -ForegroundColor Yellow
}

# Load the Hume key (Octave "Jarvis" voice - primary TTS; Groq is the fallback).
$humeFile = Join-Path $env:LOCALAPPDATA 'Praxis\hume.key'
if (Test-Path $humeFile) {
  $env:HUME_API_KEY = (Get-Content $humeFile -Raw).Trim()
  Write-Host "rpraxis: HUME_API_KEY loaded ($($env:HUME_API_KEY.Length) chars)" -ForegroundColor Cyan
}

Write-Host "rpraxis: npm run tauri dev" -ForegroundColor Cyan
npm run tauri dev
