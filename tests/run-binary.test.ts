import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const SCRIPT = resolve(import.meta.dir, "../scripts/run-binary.sh");

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => removeSandbox(sb));

// 本物のバイナリの代わりに、--help と --version の答えを撃ち分ける sh を置く
function fakeBinary(body: string): string {
  const file = join(sb.dir, "9router-cli-linux-x64");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o644);
  return file;
}

const run = (file: string, tag: string) =>
  Bun.spawnSync(["/bin/sh", SCRIPT, file, tag], { cwd: sb.dir, env: { PATH: process.env.PATH } });

describe("scripts/run-binary.sh (#13)", () => {
  const good = `case "$1" in --help) echo usage ;; --version) echo 0.4.2-rc.7 ;; *) exit 9 ;; esac`;

  test("--help が通り --version が tag (v を除く) と一致すれば 0 で、実行権が無くても付けて走らせる", () => {
    const r = run(fakeBinary(good), "v0.4.2-rc.7");

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("0.4.2-rc.7");
  });

  test("--version が tag と違えば 1 で、両方の値を出す", () => {
    const r = run(fakeBinary(good), "v0.4.2-rc.8");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("0.4.2-rc.7");
    expect(r.stderr.toString()).toContain("0.4.2-rc.8");
  });

  test("--help が落ちれば 1 で、--version は見ない", () => {
    const r = run(
      fakeBinary(
        `case "$1" in --help) echo broken >&2; exit 3 ;; --version) echo 0.4.2-rc.7 ;; esac`,
      ),
      "v0.4.2-rc.7",
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--help");
  });

  test("--version が落ちれば 1", () => {
    const r = run(
      fakeBinary(`case "$1" in --help) echo usage ;; --version) exit 4 ;; esac`),
      "v0.4.2-rc.7",
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--version");
  });

  test("ファイルが無ければ 1", () => {
    const r = run(join(sb.dir, "9router-cli-darwin-arm64"), "v0.4.2-rc.7");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("9router-cli-darwin-arm64 does not exist");
  });

  test("引数が足りなければ 2", () => {
    const r = Bun.spawnSync(["/bin/sh", SCRIPT], { cwd: sb.dir, env: { PATH: process.env.PATH } });

    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("usage:");
  });
});
