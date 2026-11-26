#!/usr/bin/env bash
# PowerShell: & 'C:\Program Files\Git\bin\bash.exe' scripts/test-release-provenance.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=release-provenance.sh
. "$SCRIPT_DIR/release-provenance.sh"

TMP_ROOT="$(mktemp -d)" || exit 1
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/src" "$TMP_ROOT/src-tauri/src"

printf '{"name":"praxis-test","version":"0.18.10"}\n' >"$TMP_ROOT/package.json"
printf '{"productName":"Praxis","version":"0.18.10"}\n' >"$TMP_ROOT/src-tauri/tauri.conf.json"
cat >"$TMP_ROOT/src-tauri/Cargo.toml" <<'TOML'
[package]
name = "praxis"
version = "0.18.10"

[dependencies]
TOML
printf 'console.log("fixture");\n' >"$TMP_ROOT/src/main.ts"
printf 'release fixture\n' >"$TMP_ROOT/praxis.exe"

failures=0
checks=0

expect_pass() {
  local name="$1"
  shift
  checks=$((checks + 1))
  if "$@" >/dev/null 2>&1; then
    printf 'PASS: %s\n' "$name"
  else
    printf 'FAIL: %s (unexpected rejection)\n' "$name" >&2
    failures=$((failures + 1))
  fi
}

expect_fail() {
  local name="$1"
  shift
  checks=$((checks + 1))
  if "$@" >/dev/null 2>&1; then
    printf 'FAIL: %s (unexpected acceptance)\n' "$name" >&2
    failures=$((failures + 1))
  else
    printf 'PASS: %s\n' "$name"
  fi
}

expect_pass "aligned manifests" release_expected_version "$TMP_ROOT"

cp "$TMP_ROOT/src-tauri/tauri.conf.json" "$TMP_ROOT/tauri.conf.good"
printf '{"productName":"Praxis","version":"0.18.9"}\n' >"$TMP_ROOT/src-tauri/tauri.conf.json"
expect_fail "manifest mismatch rejected" release_expected_version "$TMP_ROOT"
cp "$TMP_ROOT/tauri.conf.good" "$TMP_ROOT/src-tauri/tauri.conf.json"

# The fixture supplies a deterministic binary-version reader so this test does
# not need to construct or execute a Windows PE file.
FAKE_BINARY_VERSION="0.18.10"
release_binary_version() { printf '%s\n' "$FAKE_BINARY_VERSION"; }
expect_pass "matching embedded version" release_assert_binary_version "$TMP_ROOT/praxis.exe" "0.18.10"
FAKE_BINARY_VERSION="0.18.9"
expect_fail "stale embedded version rejected" release_assert_binary_version "$TMP_ROOT/praxis.exe" "0.18.10"

find "$TMP_ROOT/src" "$TMP_ROOT/src-tauri" -type f -exec touch -t 202601010000 {} +
touch -t 202601010000 "$TMP_ROOT/package.json"
touch -t 202601010001 "$TMP_ROOT/praxis.exe"
expect_pass "release newer than build inputs" release_assert_fresh "$TMP_ROOT" "$TMP_ROOT/praxis.exe"
touch -t 202601010002 "$TMP_ROOT/src/main.ts"
expect_fail "newer source rejects stale release" release_assert_fresh "$TMP_ROOT" "$TMP_ROOT/praxis.exe"

cp "$TMP_ROOT/praxis.exe" "$TMP_ROOT/installed.exe"
expect_pass "identical SHA-256" release_assert_hash_match "$TMP_ROOT/praxis.exe" "$TMP_ROOT/installed.exe"
printf 'tampered\n' >>"$TMP_ROOT/installed.exe"
expect_fail "different SHA-256 rejected" release_assert_hash_match "$TMP_ROOT/praxis.exe" "$TMP_ROOT/installed.exe"

if [ "$failures" -ne 0 ]; then
  printf 'FAIL: %d of %d release-provenance checks failed\n' "$failures" "$checks" >&2
  exit 1
fi
printf 'PASS: all %d release-provenance checks\n' "$checks"
