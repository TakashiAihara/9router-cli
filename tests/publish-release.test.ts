import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const SCRIPT = resolve(import.meta.dir, "../scripts/publish-release.sh");
const BUILT = "aaa  9router-cli-linux-x64\n";
const OTHER = "bbb  9router-cli-linux-x64\n";

let sb: Sandbox;
let calls: string;

beforeEach(() => {
  sb = makeSandbox();
  calls = join(sb.dir, "gh-calls");
  mkdirSync(join(sb.dir, "bin"));
  mkdirSync(join(sb.dir, "dist"));
  writeFileSync(join(sb.dir, "dist", "SHA256SUMS"), BUILT);
  writeFileSync(join(sb.dir, "dist", "9router-cli-linux-x64"), "binary");
  const git = (...a: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: sb.dir });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");

  // 呼ばれた引数を残す gh の偽。CREATE / VIEW / PUBLISHED_SUMS で結果を決める
  const gh = join(sb.dir, "bin", "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "release create") exit "\${CREATE:-0}" ;;
  "release view") exit "\${VIEW:-0}" ;;
  "release download")
    [ -n "$PUBLISHED_SUMS" ] || exit 1
    while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    cp "$PUBLISHED_SUMS" "$dir/SHA256SUMS" ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
});
afterEach(() => removeSandbox(sb));

function publish(env: Record<string, string> = {}) {
  const published = join(sb.dir, "published");
  return Bun.spawnSync(["/bin/sh", SCRIPT], {
    cwd: sb.dir,
    env: {
      PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`,
      HOME: sb.home,
      TAG: "v0.1.1-rc.2",
      PUBLISHED_SUMS: published,
      ...env,
    },
  });
}

function published(sums: string): void {
  writeFileSync(join(sb.dir, "published"), sums);
}

const ghCalls = () => readFileSync(calls, "utf8");

describe("publish-release.sh", () => {
  test("まだ無い release は作る", () => {
    const r = publish();

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain("release create v0.1.1-rc.2 --target ");
  });

  test("公開済みで SHA256SUMS が同じなら、何もせず成功する", () => {
    published(BUILT);

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
  });

  test("公開済みで SHA256SUMS が違えば、上書きせず落ちる", () => {
    published(OTHER);

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("not overwriting");
  });

  test("release が読めなければ、create の失敗を本当の失敗として落ちる", () => {
    const r = publish({ CREATE: "1", VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("the failure above is the real one");
  });

  test("公開済みなのに SHA256SUMS が無ければ、同じと見なさず落ちる", () => {
    const r = publish({ CREATE: "1", PUBLISHED_SUMS: "" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("without SHA256SUMS");
  });

  test("SHA256SUMS が違う公開済み release に、upload も --clobber もしない", () => {
    published(OTHER);
    publish({ CREATE: "1" });

    expect(ghCalls()).not.toContain("upload");
    expect(ghCalls()).not.toContain("--clobber");
  });
});
