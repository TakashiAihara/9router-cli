/**
 * Compiles the release binaries into dist/.
 *
 *   bun scripts/build.ts [target...]
 *
 * RELEASE_TAG, when set, is embedded as the binary's `--version` (without the leading `v`) so
 * a released binary names the tag it was built for. Without it the binary reports the version
 * in package.json, which is what a development build should say.
 *
 * No arguments builds every release target. Naming targets builds only those, which is how the
 * test builds one host binary instead of four cross-compiled ones it cannot run.
 */
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

const asked = process.argv.slice(2);
const targets = asked.length > 0 ? asked : TARGETS;

const tag = process.env.RELEASE_TAG;
const define = tag
  ? ["--define", `__BUILD_VERSION__=${JSON.stringify(tag.replace(/^v/, ""))}`]
  : [];

for (const target of targets) {
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
