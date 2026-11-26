#!/usr/bin/env bash
# Pure release-provenance checks shared by install-praxis.sh and its tests.
# This file intentionally performs no process, install, or launch mutations.

release_provenance_error() {
  echo "PROVENANCE FAIL: $*" >&2
  return 1
}

release_json_version() {
  local file="$1"
  command -v node >/dev/null 2>&1 || {
    release_provenance_error "node is required to read $file"
    return 1
  }
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const value = JSON.parse(fs.readFileSync(file, "utf8")).version;
    if (typeof value !== "string" || value.length === 0) process.exit(2);
    process.stdout.write(value);
  ' "$file" 2>/dev/null || release_provenance_error "could not read version from $file"
}

release_cargo_version() {
  local file="$1"
  awk '
    /^\[package\][[:space:]]*$/ { in_package = 1; next }
    in_package && /^\[/ { exit }
    in_package && /^[[:space:]]*version[[:space:]]*=/ {
      line = $0
      sub(/^[^"]*"/, "", line)
      sub(/".*$/, "", line)
      print line
      exit
    }
  ' "$file"
}

release_expected_version() {
  local repo="$1"
  local package_version cargo_version tauri_version

  package_version="$(release_json_version "$repo/package.json")" || return 1
  cargo_version="$(release_cargo_version "$repo/src-tauri/Cargo.toml")" || return 1
  tauri_version="$(release_json_version "$repo/src-tauri/tauri.conf.json")" || return 1

  if [ -z "$cargo_version" ]; then
    release_provenance_error "could not read [package] version from $repo/src-tauri/Cargo.toml"
    return 1
  fi
  if [ "$package_version" != "$cargo_version" ] || [ "$package_version" != "$tauri_version" ]; then
    release_provenance_error \
      "version manifests disagree (package=$package_version cargo=$cargo_version tauri=$tauri_version)"
    return 1
  fi

  printf '%s\n' "$package_version"
}

release_binary_version() {
  local file="$1"
  local native_path="$file"
  local version

  command -v powershell.exe >/dev/null 2>&1 || {
    release_provenance_error "powershell.exe is required to read the release EXE version"
    return 1
  }
  if command -v cygpath >/dev/null 2>&1; then
    native_path="$(cygpath -w "$file")" || return 1
  fi

  version="$(PRAXIS_RELEASE_EXE="$native_path" \
    powershell.exe -NoProfile -NonInteractive -Command \
    '$item = Get-Item -LiteralPath $env:PRAXIS_RELEASE_EXE -ErrorAction Stop; [Console]::Out.Write($item.VersionInfo.ProductVersion)' \
    2>/dev/null | tr -d '\r')" || {
      release_provenance_error "could not read embedded version from $file"
      return 1
    }
  [ -n "$version" ] || {
    release_provenance_error "release EXE has no embedded ProductVersion: $file"
    return 1
  }
  printf '%s\n' "$version"
}

release_assert_binary_version() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(release_binary_version "$file")" || return 1
  [ "$actual" = "$expected" ] || {
    release_provenance_error "release EXE is v$actual but manifests require v$expected"
    return 1
  }
}

release_assert_fresh() {
  local repo="$1"
  local exe="$2"
  local candidate stale
  local -a inputs=()

  [ -f "$exe" ] || {
    release_provenance_error "no release EXE at $exe"
    return 1
  }

  # Inputs that can change the raw executable or its embedded frontend.
  # Generated outputs (dist/, target/, node_modules/) are intentionally excluded.
  for candidate in \
    "$repo/src" \
    "$repo/public" \
    "$repo/src-tauri/src" \
    "$repo/src-tauri/capabilities" \
    "$repo/src-tauri/icons" \
    "$repo/src-tauri/resources" \
    "$repo/src-tauri/build.rs" \
    "$repo/src-tauri/Cargo.toml" \
    "$repo/src-tauri/Cargo.lock" \
    "$repo/src-tauri/tauri.conf.json" \
    "$repo/package.json" \
    "$repo/package-lock.json" \
    "$repo/vite.config.ts" \
    "$repo/tsconfig.json" \
    "$repo/tsconfig.node.json" \
    "$repo/index.html" \
    "$repo/flightdeck.html" \
    "$repo/knowledge.html" \
    "$repo/command.html"; do
    [ -e "$candidate" ] && inputs+=("$candidate")
  done

  [ "${#inputs[@]}" -gt 0 ] || {
    release_provenance_error "no build inputs found under $repo"
    return 1
  }

  stale="$(find "${inputs[@]}" -type f -newer "$exe" -print -quit 2>/dev/null)" || {
    release_provenance_error "could not compare build-input timestamps"
    return 1
  }
  [ -z "$stale" ] || {
    release_provenance_error "release EXE is stale; newer build input: $stale"
    return 1
  }
}

release_sha256() {
  local file="$1"
  local digest
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(sha256sum -- "$file" 2>/dev/null | awk '{print tolower($1)}')" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    digest="$(shasum -a 256 -- "$file" 2>/dev/null | awk '{print tolower($1)}')" || return 1
  else
    release_provenance_error "sha256sum or shasum is required"
    return 1
  fi
  [ "${#digest}" -eq 64 ] || {
    release_provenance_error "could not compute SHA-256 for $file"
    return 1
  }
  printf '%s\n' "$digest"
}

release_assert_hash_match() {
  local source="$1"
  local installed="$2"
  local source_hash installed_hash
  source_hash="$(release_sha256 "$source")" || return 1
  installed_hash="$(release_sha256 "$installed")" || return 1
  [ "$source_hash" = "$installed_hash" ] || {
    release_provenance_error \
      "SHA-256 mismatch after copy (release=$source_hash installed=$installed_hash)"
    return 1
  }
}
