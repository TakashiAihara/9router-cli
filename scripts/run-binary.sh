#!/bin/sh
# Runs one of the binaries that is about to be released, on a runner that can run it, and checks
# that it names the tag being released.
#
#   sh scripts/run-binary.sh <file> <tag>
#
# Why a file is started instead of inspected: scripts/check-binaries.sh can only read the image of
# a binary made for another platform, and an image is not a run. What reaches a user is a process
# that starts, so the file the release is about to carry is started here, on the same bytes the
# release will publish, and the run decides.
#
# --version is compared against the tag with its leading v removed, because that is the form
# scripts/build.ts embeds and the form a binary answers with. A binary that starts but names
# another version would be published under a tag it is not, so the two values are both printed.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: sh $0 <file> <tag>" >&2
  exit 2
fi

file="$1"
tag="$2"
want="${tag#v}"

die() {
  echo "::error::$1" >&2
  exit 1
}

[ -f "$file" ] || die "$file does not exist"

# A file that came through an artifact store arrives without its mode, so a binary that is there
# and correct would still not start. Make it runnable here rather than read it as a broken build.
chmod +x "$file" || die "$file could not be made executable"

# --help first: it is the answer a user gets from a wrong install, and a binary that cannot print
# it is not usable whatever --version says. Nothing after it is asked when it fails.
if ! "$file" --help >/dev/null; then
  die "$file --help failed"
fi

got="$("$file" --version)" || die "$file --version failed"

[ "$got" = "$want" ] || die "$file says $got, tag is $tag"

echo "$file says $got"