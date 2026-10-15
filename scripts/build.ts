/**
 * Compiles the four release binaries into dist/.
 *
 * RELEASE_TAG, when set, is embedded as the binary's `--version` (without the leading `v`) so
 * a released binary names the tag it was built for. Without it the binary reports the version
 * in package.json, which is what a development build should say.
 */
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

const tag = process.env.RELEASE_TAG;
const define = tag
  ? ["--define", `__BUILD_VERSION__=${JSON.stringify(tag.replace(/^v/, ""))}`]
  : [];

for (const target of TARGETS) {
  const build = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      `--target=bun-${target}`,
      ...define,
      "src/cli.ts",
      "--outfile",
      `dist/9router-cli-${target}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
}
