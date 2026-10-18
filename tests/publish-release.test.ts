import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const SCRIPT = resolve(import.meta.dir, "../scripts/publish-release.sh");
const TAG = "v0.1.1-rc.2";
const BUILT = "aaa  9router-cli-linux-x64\n";
const OTHER = "bbb  9router-cli-linux-x64\n";

let sb: Sandbox;
let calls: string;

const git = (...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: sb.dir });

beforeEach(() => {
  sb = makeSandbox();
  calls = join(sb.dir, "gh-calls");
  mkdirSync(join(sb.dir, "bin"));
  mkdirSync(join(sb.dir, "dist"));
  writeFileSync(join(sb.dir, "dist", "SHA256SUMS"), BUILT);
  writeFileSync(join(sb.dir, "dist", "9router-cli-linux-x64"), "binary");
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");

  // 呼ばれた引数を残す gh の偽。CREATE / VIEW / PUBLISHED_SUMS / PUBLISHED_BINARIES /
  // IS_DRAFT で結果を決める
  const gh = join(sb.dir, "bin", "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "release create") exit "\${CREATE:-0}" ;;
  "release view")
    case "$*" in
      *isDraft*) echo "\${IS_DRAFT:-false}" ;;
      *assets*) printf '%s\n' "\${PUBLISHED_BINARIES:-}" ;;
      *) exit "\${VIEW:-0}" ;;
    esac ;;
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

const head = () =>
  Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sb.dir }).stdout.toString().trim();

function publish(env: Record<string, string | undefined> = {}) {
  const published = join(sb.dir, "published");
  return Bun.spawnSync(["/bin/sh", SCRIPT], {
    cwd: sb.dir,
    env: {
      PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`,
      HOME: sb.home,
      TAG,
      MAIN_SHA: head(),
      PUBLISHED_SUMS: published,
      PUBLISHED_BINARIES: "9router-cli-linux-x64",
      ...env,
    },
  });
}

/** 既に公開されている release の SHA256SUMS */
function published(sums: string): void {
  writeFileSync(join(sb.dir, "published"), sums);
}

const ghCalls = () => readFileSync(calls, "utf8");

describe("publish-release.sh", () => {
  test("まだ無い release は作る", () => {
    const r = publish();

    expect(r.exitCode).toBe(0);
    expect(head()).toMatch(/^[0-9a-f]{40}$/);
    expect(ghCalls()).toContain(`release create v0.1.1-rc.2 --target ${head()} --latest=true `);
  });

  test("main の先頭でない commit の release は Latest にしない", () => {
    const r = publish({ MAIN_SHA: "0123456789abcdef0123456789abcdef01234567" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`--target ${head()} --latest=false `);
  });

  test("MAIN_SHA が無ければ release を作らずに止まる", () => {
    const r = publish({ MAIN_SHA: "" });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("MAIN_SHA");
    expect(existsSync(calls)).toBe(false);
  });

  test("公開済みで SHA256SUMS が同じなら、何もせず成功する", () => {
    published(BUILT);

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
    // sums だけでなく、release の資産一覧も見てから成功を言う
    expect(ghCalls()).toContain(`release view ${TAG} --json assets`);
  });

  // draft は /releases/latest を指さないので、公開済みとは言えない (#10)
  test("公開済みでも draft のままなら成功にしない", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", IS_DRAFT: "true" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`release ${TAG} is a draft`);
    expect(r.stdout.toString()).not.toContain("already published");
  });

  // SHA256SUMS が同じでも、release が持つバイナリが足りないと壊れた配布になる (#10)
  test("SHA256SUMS が同じでもバイナリが欠けていれば成功にしない", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", PUBLISHED_BINARIES: "SHA256SUMS" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`release ${TAG} has no asset 9router-cli-linux-x64`);
  });

  test("SHA256SUMS が空なら、同じと見なさず落ちる", () => {
    published("");
    writeFileSync(join(sb.dir, "dist", "SHA256SUMS"), "");

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("empty SHA256SUMS");
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

  // gh release create は tag を自分で作る時だけ --target を使う。既に tag があると別 commit の
  // ままなので、落的とした tag の下で別 commit のバイナリが配られることになる (#9)
  describe("tag が既に別の commit を指すとき", () => {
    test("release を作らずに止まる", () => {
      git("tag", TAG);
      const tagged = head();
      writeFileSync(join(sb.dir, "file"), "x");
      git("add", "-A");
      git("commit", "-q", "-m", "y");
      expect(head()).not.toBe(tagged);

      const r = publish();

      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain(`tag ${TAG} already points at ${tagged}`);
      expect(existsSync(calls)).toBe(false);
    });

    // 同じ commit の再実行 (落ちた run の再走、既存 tag の dispatch) は通らなくてはいけない
    test("同じ commit の tag なら、そのまま release を作る", () => {
      git("tag", TAG);

      const r = publish();

      expect(r.exitCode).toBe(0);
      expect(ghCalls()).toContain(`release create ${TAG} --target ${head()} `);
    });
  });
});

describe("publish-release.sh: 古い commit の新しい版番号 (#15)", () => {
  // old (HEAD) に v0.1.0、その先の main に v0.2.0-rc.3。HEAD は old に戻す
  let oldSha: string;
  let mainSha: string;
  beforeEach(() => {
    oldSha = head();
    git("tag", "v0.1.0");
    git("commit", "-q", "--allow-empty", "-m", "main");
    mainSha = head();
    git("tag", "v0.2.0-rc.3");
    git("checkout", "-q", oldSha);
  });

  test("main より高い版番号の新しいタグは、古い commit からは公開しない", () => {
    const r = publish({ TAG: "v0.2.0", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.2.0-rc.3");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("既存の最大より低い版番号は古い commit からも公開し、Latest にしない", () => {
    const r = publish({ TAG: "v0.0.9", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.0.9 --target ${oldSha} --latest=false `);
  });

  test("公開済みのタグの再実行は、古い commit でも止めない", () => {
    git("tag", "v0.3.0");
    published(BUILT);

    const r = publish({ TAG: "v0.3.0", MAIN_SHA: mainSha, CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
  });

  test("main の先頭への通常の正式版は Latest にする", () => {
    git("checkout", "-q", mainSha);

    const r = publish({ TAG: "v0.2.0", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.2.0 --target ${mainSha} --latest=true `);
  });
});
