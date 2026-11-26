#!/usr/bin/env bash
# install-praxis.sh — the ONLY sanctioned way to ship a new build to the author's machine.
# Guarantees the new version is the one on screen: gates -> install -> relaunch -> PROOF.
#
# Why each step exists:
#  - Sessions run under MSIX virtualization: %LOCALAPPDATA%\Praxis seen by this shell is
#    STALE. All install-target reads/writes go through UNC //localhost/C$/... and the
#    relaunch goes through schtasks (never Start-Process — the child would inherit the
#    virtualized view).
#  - tsc/cargo green does NOT mean the app boots (2026-07-09: a ctor allocation-order
#    bug passed every static gate and blanked every window). Proof = the app itself
#    writing boot-ok.json after React mounts, polled here.
#
# Usage: bash scripts/install-praxis.sh [--skip-gates] [--verify-only]

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXE_SRC="$REPO/src-tauri/target/release/praxis.exe"
UNC_DIR='//localhost/C$/Users/dev/AppData/Local/Praxis'
EXE_DST="$UNC_DIR/Praxis.exe"
BOOT_OK="$UNC_DIR/boot-ok.json"
EXE_WIN='C:\Users\dev\AppData\Local\Praxis\Praxis.exe'
UNINSTALL_KEY='HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Praxis'

fail() { echo "INSTALL FAIL: $*" >&2; exit 1; }
note() { echo "— $*"; }

# shellcheck source=release-provenance.sh
. "$REPO/scripts/release-provenance.sh" || fail "could not load release provenance checks"

skip_gates=0
verify_only=0
for arg in "$@"; do
  case "$arg" in
    --skip-gates) skip_gates=1 ;;
    --verify-only) verify_only=1 ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

[ -f "$EXE_SRC" ] || fail "no release exe at $EXE_SRC — run: npx tauri build"
expected_version="$(release_expected_version "$REPO")" || fail "version manifests are not release-ready"
release_assert_binary_version "$EXE_SRC" "$expected_version" || fail "release EXE version is stale"
release_assert_fresh "$REPO" "$EXE_SRC" || fail "release EXE predates a build input"
note "release provenance: v$expected_version and build inputs are current"

# ── Gate 0: static + smoke ────────────────────────────────────────────────────
if [ "$skip_gates" -ne 1 ]; then
  note "gate: tsc --noEmit"
  (cd "$REPO" && npx tsc --noEmit) || fail "tsc red"
  if [ -f "$REPO/package.json" ] && grep -q '"check:nowindow"' "$REPO/package.json"; then
    note "gate: check:nowindow"
    (cd "$REPO" && npm run --silent check:nowindow) || fail "check:nowindow red"
  fi
  if [ -f "$REPO/scripts/smoke-dist.cjs" ]; then
    note "gate: smoke-dist (plain-browser mount of dist/)"
    (cd "$REPO" && node scripts/smoke-dist.cjs) || fail "smoke-dist red — the bundle crashes at boot; do NOT install"
  fi
fi

# Gates can take long enough for an input to change concurrently. Recheck the
# complete pre-install contract immediately before any process or file mutation.
release_assert_binary_version "$EXE_SRC" "$expected_version" || fail "release EXE version changed during gates"
release_assert_fresh "$REPO" "$EXE_SRC" || fail "a build input changed during gates; rebuild before install"
if [ "$verify_only" -eq 1 ]; then
  echo "VERIFY PASS: raw Praxis v$expected_version is current and ready to install."
  exit 0
fi

# ── Install: kill -> copy via UNC (retry: 'Device or resource busy' = old proc) ──
note "killing praxis.exe"
taskkill //IM praxis.exe //F >/dev/null 2>&1
sleep 2
copied=0
for i in 1 2 3 4 5 6; do
  if cp "$EXE_SRC" "$EXE_DST" 2>/dev/null; then copied=1; note "copy OK (attempt $i)"; break; fi
  sleep 3
done
[ "$copied" = 1 ] || fail "could not copy exe after 6 attempts (file still locked?)"

src_size=$(stat -c %s "$EXE_SRC"); dst_size=$(stat -c %s "$EXE_DST" 2>/dev/null || echo 0)
[ "$src_size" = "$dst_size" ] || fail "size mismatch after copy ($src_size vs $dst_size)"
release_assert_hash_match "$EXE_SRC" "$EXE_DST" || fail "installed executable differs from raw release"
installed_hash="$(release_sha256 "$EXE_DST")" || fail "could not read installed executable hash"
note "SHA-256 verified (${installed_hash:0:12}...)"

# Keep Windows' installed-app metadata aligned with the binary we just proved.
# The original per-user installer owns the rest of this record; raw release
# installs update only its stale DisplayVersion and verify the write.
if reg.exe QUERY "$UNINSTALL_KEY" >/dev/null 2>&1; then
  reg.exe ADD "$UNINSTALL_KEY" //v DisplayVersion //t REG_SZ //d "$expected_version" //f \
    >/dev/null 2>&1 || fail "could not update Windows installed-app version metadata"
  registry_version="$(
    reg.exe QUERY "$UNINSTALL_KEY" //v DisplayVersion 2>/dev/null \
      | tr -d '\r' \
      | awk '$1 == "DisplayVersion" { print $3 }'
  )"
  [ "$registry_version" = "$expected_version" ] || \
    fail "Windows installed-app version metadata mismatch ($registry_version vs $expected_version)"
  note "Windows installed-app metadata: v$registry_version"
fi

# ── Relaunch via schtasks (never Start-Process from a session) ───────────────
launch() {
  schtasks //create //tn PraxisShow //tr "$EXE_WIN" //sc once //st 00:00 //f >/dev/null 2>&1
  schtasks //run //tn PraxisShow >/dev/null 2>&1
  schtasks //delete //tn PraxisShow //f >/dev/null 2>&1
}
epoch_ms() { echo $(( $(date +%s) * 1000 )); }

launched_at=$(epoch_ms)
note "relaunching via schtasks"
launch

# ── Proof: poll boot-ok.json for a timestamp AFTER our launch ────────────────
wait_boot() {
  local deadline=$(( $(date +%s) + 45 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$BOOT_OK" ]; then
      ts=$(grep -o '"ts":[0-9]*' "$BOOT_OK" 2>/dev/null | cut -d: -f2)
      if [ -n "${ts:-}" ] && [ "$ts" -gt "$launched_at" ]; then
        ver=$(grep -o '"version":"[^"]*"' "$BOOT_OK" | cut -d'"' -f4)
        echo "$ver"
        return 0
      fi
    fi
    sleep 3
  done
  return 1
}

if ver=$(wait_boot); then
  [ "$ver" = "$expected_version" ] || fail "booted v$ver after installing v$expected_version"
  echo "INSTALL PASS: v$ver mounted and painted ($(tasklist | grep -ci praxis.exe) praxis process)."
  exit 0
fi

# Old build without boot_ok? Fall back to process check + one retry.
if ! tasklist 2>/dev/null | grep -qi praxis.exe; then
  note "process not running — retrying launch once"
  launched_at=$(epoch_ms); launch
  if ver=$(wait_boot); then
    [ "$ver" = "$expected_version" ] || fail "booted v$ver after installing v$expected_version"
    echo "INSTALL PASS (after retry): v$ver mounted."
    exit 0
  fi
fi

if tasklist 2>/dev/null | grep -qi praxis.exe; then
  echo "INSTALL WARN: praxis.exe is running but no fresh boot-ok.json — either this build predates boot_ok, or the window is BLANK. Verify with: node praxis-browser/diag-grey.cjs (needs WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223)."
  exit 2
fi
fail "praxis.exe not running after retry"
