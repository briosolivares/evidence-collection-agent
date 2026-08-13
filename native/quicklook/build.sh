#!/usr/bin/env bash
# Rebuild bin/sherlock-ql as a universal (arm64 + x86_64) binary.
#
# The compiled binary is COMMITTED to the repo so users never need a
# Swift toolchain — rerun this (npm run build:quicklook) and commit the
# result whenever native/quicklook/main.swift changes. Requires the
# Xcode Command Line Tools (swiftc, lipo).
set -euo pipefail
cd "$(dirname "$0")/../.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

swiftc -O -target arm64-apple-macos12 -o "$tmp/sherlock-ql-arm64" native/quicklook/main.swift
swiftc -O -target x86_64-apple-macos12 -o "$tmp/sherlock-ql-x86_64" native/quicklook/main.swift
lipo -create -output "$tmp/sherlock-ql" "$tmp/sherlock-ql-arm64" "$tmp/sherlock-ql-x86_64"
# Atomic swap: nobody ever observes a half-written binary.
mv -f "$tmp/sherlock-ql" bin/sherlock-ql
lipo -archs bin/sherlock-ql
