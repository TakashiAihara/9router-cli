#!/bin/sh
# Checks every binary that is about to be released, not only the one this runner can run.
#
# scripts/build.ts compiles all four release targets on one ubuntu-x64 runner, so only
# linux-x64 can be executed here. The other three are checked as files instead: each has to be
# an image for the platform its name claims (a build that quietly produced a host binary four
# times would pass --version on linux-x64 and ship three downloads that cannot start), and
# each has to carry the tag at the one spot --define writes it to.
set -eu

: "${TAG:?TAG is required}"

want="${TAG#v}"

die() {
  echo "::error::$1" >&2
  exit 1
}

# file(1) is how the image of a binary this runner cannot run is read. Without it there is
# nothing left to check the other three with, so stop rather than pass them on unchecked.
command -v file >/dev/null 2>&1 || die "file(1) is required to check the built binaries"

# The tag has to be found where --define put it, not anywhere in tens of megabytes of bytes. Every
# binary Bun compiles carries its own bundled `bun create` template, and that template has
# "version": "0.1.0" in it, so any search for the bare version -- even one that insists the digits
# are not glued to other version characters -- answers for a binary built for v0.1.0-rc.2 and would
# ship it as v0.1.0. There is no boundary that separates a version from the rest of a template, so
# look for the whole assignment instead: Bun 1.4.3 emits `var VERSION = "<tag>";` for src/version.ts
# and nothing else in the binary carries that name, so the tag reaches the binary exactly as built.
# Fixed string, because the tag is data (1.2.3 must not match 1a2b3). If a Bun upgrade changes the
# shape it emits, this stops matching and fails the release instead of shipping it unchecked.
needle="var VERSION = \"$want\";"

# target, then the two words `file -b` has to report for it to be that platform's image
check_image() {
  target="$1"
  kind="$2"
  arch="$3"
  path="dist/9router-cli-${target}"

  [ -f "$path" ] || die "$path was not built"
  [ -x "$path" ] || die "$path is not executable"

  desc="$(file -b "$path")"
  case "$desc" in
    *"$kind"*) ;;
    *) die "$path is not a $kind image: $desc" ;;
  esac
  case "$desc" in
    *"$arch"*) ;;
    *) die "$path is not a $arch image: $desc" ;;
  esac
  LC_ALL=C grep -qF -- "$needle" "$path" ||
    die "$path does not carry the tag: no '$needle' in it"
}

check_image linux-x64 "ELF 64-bit" "x86-64"
check_image linux-arm64 "ELF 64-bit" "aarch64"
check_image darwin-x64 "Mach-O 64-bit" "x86_64"
check_image darwin-arm64 "Mach-O 64-bit" "arm64"

# Only linux-x64 is this runner's own target, so it is the one run for real: --version is what
# install.sh users see, and a binary that cannot start here is a binary nobody can use.
./dist/9router-cli-linux-x64 --help >/dev/null || die "9router-cli-linux-x64 does not run"
got="$(./dist/9router-cli-linux-x64 --version)"
[ "$got" = "$want" ] || die "9router-cli-linux-x64 says $got, tag is $TAG"