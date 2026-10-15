#!/bin/sh
# 9router-cli installer.
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/9router-cli/main/install.sh | sh
#
# Environment:
#   NINE_ROUTER_CLI_VERSION      tag to install (default: latest)
#   NINE_ROUTER_CLI_INSTALL_DIR  where to put it (default: $HOME/.local/bin)
#   NINE_ROUTER_CLI_VERIFY_ATTESTATION
#                                1 to verify the build provenance with gh (stops if gh is missing)
set -eu

REPO="TakashiAihara/9router-cli"
VERSION="${NINE_ROUTER_CLI_VERSION:-latest}"
INSTALL_DIR="${NINE_ROUTER_CLI_INSTALL_DIR:-$HOME/.local/bin}"

die() {
  echo "9router-cli: $1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

asset="9router-cli-${os}-${arch}"

command -v curl >/dev/null 2>&1 || die "curl is required"

# A release lands on every merge. Resolving "latest" once keeps the binary and SHA256SUMS
# from two different releases when one is published between the two downloads.
if [ "$VERSION" = latest ]; then
  latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")" \
    || die "could not look up the latest release"
  case "$latest_url" in
    */releases/tag/*) VERSION="${latest_url##*/}" ;;
    *) die "could not resolve the latest release (got: ${latest_url})" ;;
  esac
fi
base="https://github.com/${REPO}/releases/download/${VERSION}"

# The scratch dir is inside the install dir: the binary is run from here before it replaces
# anything, so it must not depend on /tmp being mounted executable, and mv stays a rename.
mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d "${INSTALL_DIR}/.9router-cli.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
# dash は signal では EXIT trap を走らせないので、exit を通して PATH の dir に残骸を残さない
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "9router-cli: fetching ${asset} (${VERSION})"
curl -fsSL "${base}/${asset}" -o "${tmp}/9router-cli" || die "download failed: ${base}/${asset}"

# Stop when verification cannot happen. This is piped into sh, so failing open is the
# same as no check at all. "so releases without SHA256SUMS still install" is not a reason
# to hand someone an unverified executable.
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "neither sha256sum nor shasum found; cannot verify, aborting"
fi

curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" \
  || die "could not fetch SHA256SUMS: ${base}/SHA256SUMS"

expected="$(grep " ${asset}$" "${tmp}/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || die "SHA256SUMS has no line for ${asset}"

actual="$(sha256 "${tmp}/9router-cli")"
[ "$actual" = "$expected" ] || die "checksum mismatch (expected ${expected}, got ${actual})"
echo "9router-cli: checksum ok"

# Note: this checksum comes from the same release, so anyone able to tamper with one can
# replace both. Verifying authenticity needs gh (optional):
#   gh attestation verify <binary> --repo TakashiAihara/9router-cli \
#     --signer-workflow TakashiAihara/9router-cli/.github/workflows/release.yml
#
# With --repo alone an attestation from any workflow in the repo passes, so pin the
# workflow that signed it.
if [ "${NINE_ROUTER_CLI_VERIFY_ATTESTATION:-0}" = 1 ]; then
  command -v gh >/dev/null 2>&1 \
    || die "NINE_ROUTER_CLI_VERIFY_ATTESTATION=1 needs gh, which is not installed"
  # A && B || C is not if-then-else: a failing echo alone would reach die (SC2015)
  if verify_err="$(gh attestation verify "${tmp}/9router-cli" \
    --repo "$REPO" \
    --signer-workflow "${REPO}/.github/workflows/release.yml" 2>&1 >/dev/null)"; then
    echo "9router-cli: attestation ok"
  else
    die "attestation verification failed: ${verify_err}"
  fi
fi

chmod +x "${tmp}/9router-cli"

# Run it before it replaces anything. A binary this machine cannot execute (wrong libc, a CPU
# the build does not support) must not take a working install down with it.
"${tmp}/9router-cli" --help >/dev/null 2>&1 \
  || die "the downloaded binary does not run on this machine; ${INSTALL_DIR}/9router-cli is unchanged"

mv "${tmp}/9router-cli" "${INSTALL_DIR}/9router-cli"
echo "9router-cli: installed to ${INSTALL_DIR}/9router-cli"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "9router-cli: ${INSTALL_DIR} is not on PATH; add it in your shell config" >&2 ;;
esac
