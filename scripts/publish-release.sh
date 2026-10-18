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
#
# Why $RELEASE_TRIGGER is needed: the three paths that reach this script do not agree on a tag
# from a commit that is not main's head. An automatic rc belongs to a commit main has since moved
# past and publishes nothing. A hand-pushed tag is a person choosing a version, and a dispatch
# re-runs a tag that was pushed before; both are refused when the version outranks the published
# releases, because --latest=false keeps such a release out of GitHub's latest and nothing else.
set -eu

: "${TAG:?TAG is required}"
: "${MAIN_SHA:?MAIN_SHA is required}"
: "${RELEASE_TRIGGER:?RELEASE_TRIGGER is required}"

# Release tags are vX.Y.Z or vX.Y.Z-rc.N, with no leading zeros and no number wider than this.
# The versions below are compared as numbers, and "v0.011.0" would compare as 0.11.0 while a
# twenty digit patch is not a number `[` can compare at all, so neither shape means the version
# its name writes down. A tag of any other shape is not released, and never compared.
version_shape='^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-rc\.(0|[1-9][0-9]{0,8}))?$'

head="$(git rev-parse --verify HEAD)"

# A tag this checkout already carries is decided here, before any API call and before dist/ is read,
# because the common case needs no round trip: a tag that is already on another commit (cut by hand
# for this rc, or left by a run that died after tagging) would carry binaries built from $head under a
# name that says something else. Stopping here leaves the operator to pick the next tag.
#
# This only sees the tags the checkout carries, so create_tag below repeats the comparison through the
# API, which is the only one that sees a name pushed after this point.
if tagged="$(git rev-parse -q --verify "refs/tags/${TAG}^{commit}" 2>/dev/null)"; then
  if [ "$tagged" != "$head" ]; then
    echo "tag ${TAG} already points at ${tagged}, but these binaries are built from ${head};" >&2
    echo "not publishing them under it" >&2
    exit 1
  fi
fi

if ! printf '%s\n' "$TAG" | grep -E "$version_shape" >/dev/null; then
  echo "tag ${TAG} is not vX.Y.Z or vX.Y.Z-rc.N: each number has no leading zero and 9 digits at most" >&2
  exit 1
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

# Whether $1 is a higher semver than $2. Stops at the first field that differs, so that
# v0.2.0-rc.9 does not outrank v0.2.1-rc.1 because its rc count is the bigger number.
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

# Stops when a tag with no release yet would rank above the published releases.
#
# The partners are published releases rather than tags: a tag left on the remote by a refused
# run, or one whose release is still a draft, is something nobody can install, so it must not be
# what a new version has to stay below.
#
# gh reports a tag it has no release for as "release not found" and every other failure (network,
# auth, a broken API) in its own words. Only the first one is evidence that this tag is new.
# Reading a failure as "not published" cannot let a version through -- the comparison below runs
# either way -- it can only refuse a tag that was already published, and it would blame the
# version number for a failure it knows nothing about.
#
# --latest=false keeps main out of GitHub's latest, but the number still reads as the newest
# version to whoever picks a release by the highest tag, and keeps reading that way until main
# ships something higher. That is what a backport is for: older code under a version below the
# highest published one still says which code it carries, so it goes out.
refuse_higher_than_existing() {
  if view_err="$(gh release view "$TAG" 2>&1 >/dev/null)"; then
    return 0
  fi
  case "$view_err" in
    *"release not found"*) ;;
    *)
      echo "could not read release ${TAG}:" >&2
      echo "$view_err" >&2
      exit 1
      ;;
  esac

  # gh's stderr comes along so a failure can be reported in gh's own words. A warning it prints
  # on success stays in there too, and the shape below drops it before it is read as a version.
  listed="$(gh release list --exclude-drafts --limit 1000 --json tagName --jq '.[].tagName' 2>&1)" || {
    echo "could not read the list of published releases:" >&2
    echo "$listed" >&2
    exit 1
  }
  # Both greps exit 1 on an empty result: no published release carries a tag of this shape, or
  # nothing is left once $TAG itself is taken out. Either way there is no partner to compare
  # against, so nothing is refused. $TAG is taken out only for the moment between the view above
  # and this list, where its release could appear; a tag compared with itself outranks nothing.
  existing="$(printf '%s\n' "$listed" | grep -E "$version_shape" | grep -Fxv -- "$TAG")" || existing=""
  highest=""
  for other in $existing; do
    if [ -z "$highest" ] || version_gt "$other" "$highest"; then highest="$other"; fi
  done

  if [ -n "$highest" ] && version_gt "$TAG" "$highest"; then
    echo "tag ${TAG} is higher than ${highest}, the highest published release;" >&2
    echo "not publishing it from ${head}, which is not main's head" >&2
    echo "if it was main's head when it was pushed and main moved on during the run, release it" >&2
    echo "with workflow_dispatch once a published release above ${TAG} exists; otherwise delete" >&2
    echo "the pushed tag, which the next runs see too: git push origin :refs/tags/${TAG}" >&2
    exit 1
  fi
}

# The repository is left to gh, which fills {owner} and {repo} from the same place every `gh release`
# command here gets it, so an API tag cannot land in a different repository than the release.
api_repo='repos/{owner}/{repo}'

# The tag has to exist before the release does. gh release create makes the tag itself when it is
# missing, which leaves a window between reading the tag and creating the release that a hand push of
# the same name can walk into; creating it here and passing --verify-tag closes that window for the
# path this script drives. It is not a lock: the tag can still be moved while the assets upload.
#
# Making the ref is also the only way to know whether this run or an earlier one owns it, which is
# what tells a tag left behind by a failed run from a tag that belongs to somebody.
tag_created=false

# Whether the existing tag points at $head. A name already on $head is the same commit published
# again, which is what a re-run is, so it goes on to the release; anything else is somebody else's
# version number and stops here.
#
# A read failure is its own case: "the tag is not there" and "I could not find out" have to stay
# apart, or a network blip would read as permission to publish under a tag this run never saw.
tag_is_head() {
  if ! tag_ref="$(gh api "${api_repo}/git/ref/tags/${TAG}" --jq '.object.type + " " + .object.sha' 2>&1)"; then
    echo "could not read tag ${TAG}:" >&2
    echo "$tag_ref" >&2
    exit 1
  fi
  # An annotated tag's sha is the tag object rather than the commit, which is never the one these
  # binaries were built from, so compare the commit that object points at and read a re-run as one.
  object_type="${tag_ref%% *}"
  tagged="${tag_ref#* }"
  if [ "$object_type" = tag ]; then
    if ! tagged="$(gh api "${api_repo}/git/tags/${tagged}" --jq .object.sha 2>&1)"; then
      echo "could not read annotated tag ${TAG}:" >&2
      echo "$tagged" >&2
      exit 1
    fi
  fi

  if [ "$tagged" != "$head" ]; then
    echo "tag ${TAG} now points at ${tagged}, but these binaries are built from ${head};" >&2
    echo "not publishing them under it" >&2
    exit 1
  fi
}

create_tag() {
  # gh's stderr decides which failure this is. "Reference already exists" is the only evidence that
  # the name is taken, and a different 422 (a repository rule, say) is this call failing, not evidence
  # about any tag, so it stops without reading a ref that was never shown to exist.
  if create_err="$(gh api --method POST "${api_repo}/git/refs" \
    -f "ref=refs/tags/${TAG}" -f "sha=${head}" 2>&1 >/dev/null)"; then
    tag_created=true
    return 0
  fi

  case "$create_err" in
    *"Reference already exists"*) ;;
    *)
      echo "could not create tag ${TAG}:" >&2
      echo "$create_err" >&2
      exit 1
      ;;
  esac

  tag_is_head
}

# A tag this run made and is not releasing is worse than no tag: next-tag.ts counts every tag it
# finds, so the one left behind would push the next version number up for every run after it, and
# every later run would see a version number nobody can publish. A tag that already existed belongs
# to whoever made it, so it is left alone.
drop_tag_if_made_here() {
  [ "$tag_created" = true ] || return 0
  if ! drop_err="$(gh api --method DELETE "${api_repo}/git/refs/tags/${TAG}" 2>&1 >/dev/null)"; then
    echo "could not delete tag ${TAG}, which this run made; delete it by hand:" >&2
    echo "git push origin :refs/tags/${TAG}" >&2
    echo "$drop_err" >&2
  fi
}

# install.sh は Latest を配るので、main の先頭でない commit の release を Latest にしない
if [ "$head" = "$MAIN_SHA" ]; then latest=true; else latest=false; fi

# On main's head the three paths do the same thing, so this is the only place they can differ.
if [ "$head" != "$MAIN_SHA" ]; then
  # This run's rc tag was decided while $head was main's head, and main moved on before the
  # release step got here. The run for the newer commit decides its own tag, so publishing this
  # one would only put older code under a version number that reads as the newest. The tag job
  # checks this too, but it ran before the build.
  if [ "$RELEASE_TRIGGER" = workflow_run ]; then
    echo "::notice::main has moved on since ${TAG} was decided; this run releases nothing"
    exit 0
  fi
  # A dispatch re-runs a tag that was pushed before, which the check lets through for as long as
  # that release exists (a draft also passes here, and the draft check below stops it). It is also
  # how a refused tag gets released later, so it is not a way around the check: nothing gets
  # published by being dispatched a second time.
  refuse_higher_than_existing
fi

create_tag

# --verify-tag then attaches the release to the tag this run made or read, instead of gh making a
# tag of its own from --target. --target is kept because the tests match it and because it names
# the commit in the log, but with the tag already there it decides nothing.
if gh release create "$TAG" --target "$head" --latest="$latest" --verify-tag --title "$TAG" \
  --generate-notes dist/9router-cli-* dist/SHA256SUMS; then
  exit 0
fi

echo "release ${TAG} was not created; checking whether it is already published" >&2
gh release view "$TAG" >/dev/null \
  || { echo "could not read release ${TAG}, so the failure above is the real one" >&2; drop_tag_if_made_here; exit 1; }

# A draft is not published: /releases/latest never points at it and its assets are not offered,
# so "already published" would be a lie install.sh finds out about only after it hands one out.
if [ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" = true ]; then
  echo "release ${TAG} is a draft; publish or delete it by hand" >&2
  drop_tag_if_made_here
  exit 1
fi

published="$(mktemp -d)"
trap 'rm -rf "$published"' EXIT
gh release download "$TAG" --pattern SHA256SUMS --dir "$published" \
  || { echo "release ${TAG} exists without SHA256SUMS; fix or delete it by hand" >&2; drop_tag_if_made_here; exit 1; }

if cmp -s dist/SHA256SUMS "${published}/SHA256SUMS"; then
  # Matching sums only say the sums match. Read the asset list too (downloading 4 binaries to
  # look at names would cost 300MB on every re-run), so a release carrying SHA256SUMS and,
  # say, two of four binaries is not read as the published one.
  assets="$(gh release view "$TAG" --json assets --jq '.assets[].name')"
  # sha256sum writes "hash  name" and "hash *name"; the last field is the asset name either way
  names="$(awk '{print $NF}' "${published}/SHA256SUMS" | tr -d '*')"
  [ -n "$names" ] || { echo "release ${TAG} has an empty SHA256SUMS; fix or delete it by hand" >&2; drop_tag_if_made_here; exit 1; }
  for name in $names; do
    printf '%s\n' "$assets" | grep -Fxq -- "$name" \
      || { echo "release ${TAG} has no asset ${name}; fix or delete it by hand" >&2; drop_tag_if_made_here; exit 1; }
  done
  echo "release ${TAG} is already published with the same SHA256SUMS; nothing to do"
  exit 0
fi

echo "release ${TAG} is published with different SHA256SUMS; not overwriting it:" >&2
diff "${published}/SHA256SUMS" dist/SHA256SUMS >&2 || true
drop_tag_if_made_here
exit 1
