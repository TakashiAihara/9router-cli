import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { makeSandbox, removeSandbox, runCli, type Sandbox } from "./helpers/cli.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => removeSandbox(sb));

describe("--version", () => {
  // 版の識別子は compile 時に入れるもので、実行時の env ではない。開発実行でも、利用者の
  // env で埋め込み版を名乗ることはない (#7)
  test("開発実行は、埋め込み用の識別子が env にあっても package.json の版を名乗る", async () => {
    const r = await runCli(sb, ["--version"], { __BUILD_VERSION__: "0.0.1" });

    expect(r.code).toBe(0);
    expect(r.out).toBe(`${pkg.version}\n`);
  });

  test("build で版を差し込んだバイナリは、差し込んだ版を名乗る", async () => {
    const out = join(sb.dir, "cli.js");
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      CLI,
      "--target=bun",
      "--define",
      '__BUILD_VERSION__="9.8.7-rc.6"',
      "--outfile",
      out,
    ]);
    expect(build.exitCode).toBe(0);

    const run = Bun.spawnSync([process.execPath, out, "--version"], {
      // 利用者の env で版を偽れないこと
      env: { PATH: process.env.PATH, HOME: sb.home, __BUILD_VERSION__: "0.0.1" },
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("9.8.7-rc.6\n");
  });
});
