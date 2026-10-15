import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nextTag } from "../scripts/next-tag.ts";

/**
 * Every push to main that passes CI releases under the tag this returns, and install.sh
 * hands out whatever is latest. A wrong answer either fails the release on a tag that
 * exists or publishes a version that sorts below the one before it.
 */
// どの tag とも違う値にして、tag があるときに package.json の版へ落ちていないことも見る
const FIRST = "7.7.7";

describe("nextTag", () => {
  test("steps the release candidate", () => {
    expect(nextTag(["v0.1.0-rc.1", "v0.1.0-rc.2", "v0.1.0-rc.3"], FIRST)).toBe("v0.1.0-rc.4");
  });

  test("compares rc numbers as numbers, not text", () => {
    expect(nextTag(["v0.1.0-rc.9", "v0.1.0-rc.10", "v0.1.0-rc.2"], FIRST)).toBe("v0.1.0-rc.11");
  });

  test("compares patch numbers as numbers, not text", () => {
    expect(nextTag(["v0.1.9", "v0.1.10"], FIRST)).toBe("v0.1.11-rc.1");
  });

  test("counts rc.0 as a release candidate, not a final version", () => {
    expect(nextTag(["v0.1.0-rc.0"], FIRST)).toBe("v0.1.0-rc.1");
  });

  test("puts a final version above its own release candidates, and starts the next patch", () => {
    expect(nextTag(["v0.1.0-rc.3", "v0.1.0", "v0.1.0-rc.2"], FIRST)).toBe("v0.1.1-rc.1");
  });

  test("takes the highest version, whatever order the tags come in", () => {
    expect(nextTag(["v0.2.0-rc.1", "v0.10.0-rc.1", "v0.9.9"], FIRST)).toBe("v0.10.0-rc.2");
    expect(nextTag(["v1.0.0-rc.1", "v0.9.0"], FIRST)).toBe("v1.0.0-rc.2");
  });

  test("ignores tags in any other shape", () => {
    expect(nextTag(["v0.1.0-rc.3", "v9", "latest", "v2.0.0-beta.1", ""], FIRST)).toBe(
      "v0.1.0-rc.4",
    );
  });

  test("ignores a tag that only ends in a version", () => {
    expect(nextTag(["v0.1.0-rc.3", "release-v9.0.0"], FIRST)).toBe("v0.1.0-rc.4");
  });

  test("reads a tag with a trailing carriage return", () => {
    expect(nextTag(["v0.1.0-rc.3\r"], FIRST)).toBe("v0.1.0-rc.4");
  });

  test("starts the first release candidate from the package.json version when no tag counts", () => {
    expect(nextTag([], "0.1.0")).toBe("v0.1.0-rc.1");
    expect(nextTag(["latest", "", "v2.0.0-beta.1"], "3.4.5")).toBe("v3.4.5-rc.1");
  });

  test("refuses a package.json version it cannot count from", () => {
    expect(() => nextTag([], "0.1")).toThrow("not X.Y.Z");
    expect(() => nextTag([], "1.0.0-rc.1")).toThrow("not X.Y.Z");
  });
});

// workflow は標準出力を tag として使うので、tag が 1 つも無い repo で終了コード 0 と tag を返すこと
// (失敗の握り潰しは workflow 側で塞ぐが、ここが落ちたら main が緑のまま release されない)
describe("next-tag.ts を tag の無い repo で実行したとき", () => {
  test("package.json の版から数えた tag を出して、終了コード 0 で終わる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "next-tag-"));
    try {
      const git = Bun.spawnSync(["git", "init", "-q", dir]);
      expect(git.exitCode).toBe(0);
      const script = resolve(import.meta.dir, "../scripts/next-tag.ts");
      const run = Bun.spawnSync([process.execPath, script], { cwd: dir });

      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toBe(`v${pkg.version}-rc.1\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
