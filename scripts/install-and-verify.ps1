# install-and-verify - put the freshly built exe where the TASKBAR actually points,
# then prove it landed. Run this, never a bare copy.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THIS IS NOT JUST A COPY
#
# A Claude/agent session runs inside Claude's MSIX container, so its view of
# %LOCALAPPDATA%\Praxis is copy-on-write redirected into the app sandbox. Measured
# 2026-09-09, three different binaries answered to "the installed Praxis":
#
#   UNC     2026-08-02  23,730,176   <- the real file the taskbar launches
#   DIRECT  2026-06-28  20,961,280   <- what a session sees (the sandbox copy)
#   BUILT   2026-09-09  23,810,560   <- what was just compiled
#
# So a session that copies to $env:LOCALAPPDATA\Praxis writes into the sandbox, reads it back,
# sees its own bytes, and reports a successful install - while the app the owner opens is untouched.
# That is how five weeks of shipped work stayed invisible: each install reported success and
# none of the changes reached the app.
#
# THE FIX: do everything over UNC (\\localhost\C$\...). UNC is not redirected, for
# reads OR writes, so it is both the only way to install from a session and the
# only view of the installed file a session can trust.
#
# LAUNCHING is still redirected - `Start-Process praxis.exe` from a session runs
# the sandbox copy and even reports the canonical path while doing it - so the
# launch goes through a scheduled task, which executes outside the container.
# ─────────────────────────────────────────────────────────────────────────────

param(
  # Open a WebView2 debug port on this launch so a session can attach and VERIFY
  # the installed build. Off by default - the owner's everyday app should not listen.
  # Port 9334 specifically: 9222 is TradingView and 9223 is Windows Widgets on
  # this machine, both WebView2, both happy to hand back a plausible wrong target.
  [switch]$WithDebugPort,
  # Relaunch to the tray (--hidden) instead of popping the window open. Use it when
  # The owner is in the middle of something: a surprise window in front of a timed game
  # or a half-typed sentence is an interruption, and verification over CDP works on
  # a hidden window just the same.
  [switch]$Hidden
)

$ErrorActionPreference = 'Stop'
$built = 'C:\Users\dev\Desktop\praxis\src-tauri\target\release\praxis.exe'
$real  = 'C:\Users\dev\AppData\Local\Praxis\praxis.exe'
$unc   = '\\localhost\C$\Users\dev\AppData\Local\Praxis\praxis.exe'

function Report($label, $p) {
  $i = Get-Item $p -ErrorAction SilentlyContinue
  if ($i) { Write-Host ("  {0,-8} {1}  size {2}" -f $label, $i.LastWriteTime, $i.Length) }
  else    { Write-Host ("  {0,-8} MISSING" -f $label) }
}

if (-not (Test-Path $built)) { Write-Host "ABORT: nothing built at $built"; exit 1 }
$src = Get-Item $built

Write-Host "BEFORE:"
Report 'BUILT'  $built
Report 'UNC'    $unc
Report 'DIRECT' $real   # shown only to make the redirect visible; never trusted

# ─────────────────────────────────────────────────────────────────────────────
# IDENTITY IS THE HASH, NOT THE SIZE.
#
# 2026-09-11: this script printed "INSTALLED (verified over UNC)" immediately after
# a copy that had failed with "The process cannot access the file ... being used by
# another process", and the app ran yesterday's build for another hour.
#
# The check was `$after.Length -eq $src.Length`. Two consecutive Praxis builds were
# BOTH exactly 23,761,408 bytes - a frontend-only change relinking to the same
# length is not a coincidence, it is the common case. So the old file matched on
# size, the loop broke on the first pass, and a failed install reported success.
#
# A verifier that passes when the thing it verifies did not happen is worse than no
# verifier: it is the reason "none of the changes are there" kept being true while
# every log said otherwise. Compare content.
# ─────────────────────────────────────────────────────────────────────────────
# WAIT FOR THE BUILD TO STOP MOVING FIRST.
#
# `npx tauri build` prints "Built application at: …praxis.exe" and then KEEPS WRITING
# that exe - it patches bundle-type information into it and produces the installers.
# Hashing at the first line and copying mid-patch produced five "still the OLD binary"
# attempts with the hash CHANGING between them (20:27 on 2026-09-15), and the script
# aborted with the app already killed. The file is the source of truth, so wait until
# two reads a second apart agree before trusting either.
function Stable-Hash($path) {
  # THREE consecutive equal reads, not two. `tauri build` keeps touching praxis.exe while
  # it produces the MSI/NSIS bundles, and it goes quiet for over a second between writes -
  # so a two-read check caught a lull, hashed, and then the file changed underneath the
  # copy. That produced five "still the OLD binary" attempts with a MOVING hash and an
  # abort with the app already stopped (twice on 2026-09-15). ~5s of genuine quiet is
  # cheap next to a failed install.
  for ($i = 0; $i -lt 40; $i++) {
    $a = (Get-FileHash $path -Algorithm SHA256).Hash
    Start-Sleep -Milliseconds 1700
    $b = (Get-FileHash $path -Algorithm SHA256).Hash
    Start-Sleep -Milliseconds 1700
    $c = (Get-FileHash $path -Algorithm SHA256).Hash
    if ($a -eq $b -and $b -eq $c) { return $c }
    Write-Host "  waiting for the build to finish writing praxis.exe..."
  }
  throw "praxis.exe never stopped changing - is a build still running?"
}
$srcHash = Stable-Hash $built

function Installed-Hash {
  $i = Get-Item $unc -ErrorAction SilentlyContinue
  if (-not $i) { return $null }
  try { return (Get-FileHash $unc -Algorithm SHA256).Hash } catch { return $null }
}

# Stop the app from outside the container - a taskkill from in here can miss the
# real process the same way a direct copy misses the real file.
function Stop-Praxis {
  $tnKill = "PraxisKill_$(Get-Random)"
  schtasks /create /tn $tnKill /tr "taskkill /F /IM praxis.exe" /sc once /st 23:59 /f | Out-Null
  schtasks /run /tn $tnKill | Out-Null
  Start-Sleep -Seconds 4
  schtasks /delete /tn $tnKill /f | Out-Null
  # Task Scheduler can stall with every new task stuck "Queued" (seen 2026-09-24 16:33:
  # the kill never ran, the copy hit a locked file and the install aborted). If praxis.exe
  # is still alive, stop it directly - from here that reaches the real process too.
  $still = Get-Process praxis -ErrorAction SilentlyContinue
  if ($still) {
    Write-Host "  kill task did not run (Task Scheduler queued?) - stopping praxis.exe directly"
    $still | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }
}

$before = Get-Item $unc -ErrorAction SilentlyContinue
if ($before -and (Installed-Hash) -eq $srcHash) {
  # The file is current, but the RUNNING app still has to be replaced: Praxis is
  # single-instance, so launching beside it only hands off to the old process and
  # the requested flags (the debug port above all) never take effect. 2026-10-04 this
  # branch skipped the stop, the new launch exited into the old instance, and the
  # script still printed "LAUNCHED" because it found the OLD pid.
  Write-Host "ALREADY CURRENT (hash match) - restarting the running app"
  Stop-Praxis
} else {
  Stop-Praxis

  # Retry: a just-killed praxis.exe can hold its file lock for a few seconds, and a
  # failed copy here must never be mistaken for a successful one.
  $ok = $false
  for ($try = 1; $try -le 5; $try++) {
    try { Copy-Item -Path $built -Destination $unc -Force -ErrorAction Stop } catch {
      Write-Host ("  copy attempt {0}: {1}" -f $try, $_.Exception.Message)
    }
    $afterHash = Installed-Hash
    if ($afterHash -eq $srcHash) { $ok = $true; break }
    if ($afterHash) {
      Write-Host ("  attempt {0}: still the OLD binary (hash {1} != {2})" -f $try, $afterHash.Substring(0,12), $srcHash.Substring(0,12))
    }
    Start-Sleep -Seconds 3
  }
  if (-not $ok) {
    Write-Host "ABORT: install did NOT verify over UNC - the app is still running the OLD build"
    Report 'UNC' $unc
    exit 1
  }
  Write-Host ("INSTALLED (SHA256 verified over UNC: {0})" -f $srcHash.Substring(0,16))
}

Write-Host "AFTER:"
Report 'UNC' $unc
$finalHash = Installed-Hash
if ($finalHash -ne $srcHash) {
  Write-Host "ABORT: the installed file does not match the built file. NOT launching a stale build."
  exit 1
}
Write-Host ("VERIFIED: installed == built ({0})" -f $srcHash.Substring(0,16))

# Launch from outside the container, or the OS hands us the sandbox copy.
#
# Via a generated .cmd rather than an inline /tr string: schtasks re-parses /tr and
# chokes on the embedded quotes a path with spaces needs, which silently produced
# "ERROR: Invalid argument" and no app. A file has no quoting to get wrong.
# NOT $env:TEMP: that is under AppData, and a shell running inside an MSIX container
# (Claude's) writes AppData into its private LocalCache - the scheduled task runs
# outside the container, finds no file, and the app silently never starts
# ("WARN: praxis.exe did not start", 2026-09-16). tools\ is a real, shared path.
$launchDir = Join-Path $env:USERPROFILE "tools\praxis-launch"
New-Item -ItemType Directory -Force -Path $launchDir | Out-Null
$cmdFile = Join-Path $launchDir "praxis-launch-$(Get-Random).cmd"
$lines = @('@echo off')
if ($WithDebugPort) {
  $lines += 'set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334'
  $lines += 'set PRAXIS_CDP_PORT=9334'
}
$launchArgs = if ($Hidden) { ' --hidden' } else { '' }
$lines += ('start "" "' + $real + '"' + $launchArgs)
Set-Content -Path $cmdFile -Value $lines -Encoding ascii

# Only a process that was NOT already running counts as the launch: finding a survivor
# of the stop above is not proof the new build started.
$preIds = @(Get-Process praxis -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
function New-Praxis { Get-Process praxis -ErrorAction SilentlyContinue | Where-Object { $preIds -notcontains $_.Id } }
$tn = "PraxisShow_$(Get-Random)"
schtasks /create /tn $tn /tr $cmdFile /sc once /st 23:59 /f | Out-Null
schtasks /run /tn $tn | Out-Null
# Poll instead of a fixed wait: Task Scheduler sometimes starts the action well after
# /run returns, and a fixed 12 s check reported "did not start" for an app that came
# up seconds later (2026-09-16). The .cmd must still exist when the task fires.
$p = $null
for ($i = 0; $i -lt 45 -and -not $p; $i++) {
  Start-Sleep -Seconds 1
  $p = New-Praxis
}
schtasks /delete /tn $tn /f | Out-Null
if (-not $p) {
  # Scheduled task never ran (queued). Explorer runs the launcher OUTSIDE the MSIX container
  # too (a Start-Process from here would run inside it and redirect the app's AppData).
  Write-Host "  launch task did not run (Task Scheduler queued?) - launching through Explorer"
  & explorer.exe $cmdFile
  for ($i = 0; $i -lt 30 -and -not $p; $i++) {
    Start-Sleep -Seconds 1
    $p = New-Praxis
  }
  Start-Sleep -Seconds 2
}
Remove-Item $cmdFile -Force -ErrorAction SilentlyContinue
if ($p) {
  Write-Host ("LAUNCHED pid " + ($p.Id -join ','))
  # Task Scheduler starts tasks BELOW_NORMAL; the app raises itself at startup
  # (lib.rs ensure_normal_priority). Anything else here means that fix did not run,
  # and the app will starve under load again.
  foreach ($proc in $p) {
    try { Write-Host ("PRIORITY pid {0}: {1}" -f $proc.Id, $proc.PriorityClass) } catch { Write-Host "PRIORITY unreadable" }
  }
} else { Write-Host "WARN: praxis.exe did not start" }
