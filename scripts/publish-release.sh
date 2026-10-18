#!/bin/sh
# Publishes dist/ as the release for $TAG, and never overwrites one that is already published.
#
# A re-run for the same tag is expected (a failed run, a dispatch for an existing tag). If
# the release is already there with the same SHA256SUMS the work is done; if the sums differ,
# the rebuild is not what was published and replacing it would break anyone who pinned a hash.
#
# Why equal sums mean the same release: SHA256SUMS covers all four binaries by name, so the
# sums change when any of them changes, is missing, or is swapped for another target's file.
# The build is a plain `bun build --compile` of one entry point with one --define (the tag)
# and one --outfile per target, all from the same checkout, so the same commit and tag give
# the same bytes and the same sums. Equal sums therefore mean nothing but "the same four
# files, unchanged", which is what "already published" has to mean; unequal sums mean
# different bytes, and those are never replaced.
set -eu

: "${TAG:?TAG is required}"
: "${MAIN_SHA:?MAIN_SHA is required}"

head="$(git rev-parse --verify HEAD)"

# gh release create only honours --target when it makes the tag itself. A tag that is already
# there (cut by hand for this rc, or left by a run that died after tagging) keeps its own
# commit, so binaries built from $head would ship under a tag pointing somewhere else. Stop
# before creating, so no such release is made and the operator picks the next tag.
if tagged="$(git rev-parse -q --verify "refs/tags/${TAG}^{commit}" 2>/dev/null)"; then
  if [ "$tagged" != "$head" ]; then
    echo "tag ${TAG} already points at ${tagged}, but these binaries are built from ${head};" >&2
    echo "not publishing them under it" >&2
    exit 1
  fi
fi

# Puts a version number into the fields version_gt compares: major, minor, patch, then a rank
# and the rc count. A final version has to sit above every rc of itself, so it carries a rank
# the rcs do not, and the counts are compared as numbers so rc.10 is above rc.9, not below it.
version_key() {
  rest="${1#v}"
  base="${rest%%-rc.*}"
  if [ "$rest" = "$base" ]; then
    rank=1
    rc=0
  else
    rank=0
    rc="${rest#*-rc.}"
  fi
  numbers="${base#*.}"
  printf '%s %s %s %s %s' "${base%%.*}" "${numbers%%.*}" "${numbers#*.}" "$rank" "$rc"
}

# Whether $1 is a higher semver than $2. Stops at the first field that differs, so that a bigger
# rc count cannot win over a smaller patch number.
version_gt() {
  left="$(version_key "$1")"
  right="$(version_key "$2")"
  fields=5
  while [ "$fields" -gt 0 ]; do
    a="${left%% *}"
    b="${right%% *}"
    left="${left#* }"
    right="${right#* }"
    if [ "$a" -gt "$b" ]; then return 0; fi
    if [ "$a" -lt "$b" ]; then return 1; fi
    fields=$((fields - 1))
  done
  return 1
}

# install.sh は Latest を配るので、main の先頭でない commit の release を Latest にしない
if [ "$head" = "$MAIN_SHA" ]; then latest=true; else latest=false; fi

# --latest=false keeps main out of GitHub's latest, but the number still reads as the newest
# version to whoever picks a release by the highest tag, and keeps reading that way until main
# ships something higher. Only for a release that does not exist yet: an already published tag
# is a fact from before this commit ran, and a version below the highest existing tag is a
# backport, which is what the number is there to say.
if [ "$head" != "$MAIN_SHA" ] && ! gh release view "$TAG" >/dev/null 2>&1; then
  tags="$(git tag --list 'v*')"
  # grep は一致 0 件で 1 を返す。それだけを空として受けて、tag のない最初の release も通す。
  # git が失敗した時は上の代入で止まるので、比較の相手不在を空と読ませない。
  # 手で push された tag は既に checkout に入っている。自分自身を比べる相手から外さないと
  # 「最も高いのは自分自身」で止まらないので、誰も負けていない版も毎回通ってしまう
  existing="$(printf '%s\n' "$tags" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' | grep -Fxv -- "$TAG")" || existing=""
  highest=""
  for other in $existing; do
    if [ -z "$highest" ] || version_gt "$other" "$highest"; then highest="$other"; fi
  done
  if [ -n "$highest" ] && version_gt "$TAG" "$highest"; then
    echo "tag ${TAG} is higher than ${highest}, the highest tag in this checkout;" >&2
    echo "not publishing it from ${head}, which is not main's head" >&2
    exit 1
  fi
fi

if gh release create "$TAG" --target "$head" --latest="$latest" --title "$TAG" --generate-notes \
  dist/9router-cli-* dist/SHA256SUMS; then
  exit 0
fi

echo "release ${TAG} was not created; checking whether it is already published" >&2
gh release view "$TAG" >/dev/null \
  || { echo "could not read release ${TAG}, so the failure above is the real one" >&2; exit 1; }

# A draft is not published: /releases/latest never points at it and its assets are not offered,
# so "already published" would be a lie install.sh finds out about only after it hands one out.
if [ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" = true ]; then
  echo "release ${TAG} is a draft; publish or delete it by hand" >&2
  exit 1
fi

published="$(mktemp -d)"
trap 'rm -rf "$published"' EXIT
gh release download "$TAG" --pattern SHA256SUMS --dir "$published" \
  || { echo "release ${TAG} exists without SHA256SUMS; fix or delete it by hand" >&2; exit 1; }

if cmp -s dist/SHA256SUMS "${published}/SHA256SUMS"; then
  # Matching sums only say the sums match. Read the asset list too (downloading 4 binaries to
  # look at names would cost 300MB on every re-run), so a release carrying SHA256SUMS and,
  # say, two of four binaries is not read as the published one.
  assets="$(gh release view "$TAG" --json assets --jq '.assets[].name')"
  # sha256sum writes "hash  name" and "hash *name"; the last field is the asset name either way
  names="$(awk '{print $NF}' "${published}/SHA256SUMS" | tr -d '*')"
  [ -n "$names" ] || { echo "release ${TAG} has an empty SHA256SUMS; fix or delete it by hand" >&2; exit 1; }
  for name in $names; do
    printf '%s\n' "$assets" | grep -Fxq -- "$name" \
      || { echo "release ${TAG} has no asset ${name}; fix or delete it by hand" >&2; exit 1; }
  done
  echo "release ${TAG} is already published with the same SHA256SUMS; nothing to do"
  exit 0
fi

echo "release ${TAG} is published with different SHA256SUMS; not overwriting it:" >&2
diff "${published}/SHA256SUMS" dist/SHA256SUMS >&2 || true
exit 1
