#!/bin/sh
# Publishes dist/ as the release for $TAG, and never overwrites one that is already published.
#
# A re-run for the same tag is expected (a failed run, a dispatch for an existing tag). If
# the release is already there with the same SHA256SUMS the work is done; if the sums differ,
# the rebuild is not what was published and replacing it would break anyone who pinned a hash.
set -eu

: "${TAG:?TAG is required}"

if gh release create "$TAG" --target "$(git rev-parse HEAD)" --title "$TAG" --generate-notes \
  dist/9router-cli-* dist/SHA256SUMS; then
  exit 0
fi

echo "release ${TAG} was not created; checking whether it is already published" >&2
gh release view "$TAG" >/dev/null \
  || { echo "could not read release ${TAG}, so the failure above is the real one" >&2; exit 1; }

published="$(mktemp -d)"
trap 'rm -rf "$published"' EXIT
gh release download "$TAG" --pattern SHA256SUMS --dir "$published" \
  || { echo "release ${TAG} exists without SHA256SUMS; fix or delete it by hand" >&2; exit 1; }

if cmp -s dist/SHA256SUMS "${published}/SHA256SUMS"; then
  echo "release ${TAG} is already published with the same SHA256SUMS; nothing to do"
  exit 0
fi

echo "release ${TAG} is published with different SHA256SUMS; not overwriting it:" >&2
diff "${published}/SHA256SUMS" dist/SHA256SUMS >&2 || true
exit 1
