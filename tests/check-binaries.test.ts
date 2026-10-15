import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const SCRIPT = resolve(import.meta.dir, "../scripts/check-binaries.sh");
const TAG = "v0.1.1-rc.2";
const VERSION = "0.1.1-rc.2";
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

// `file -b` が本当に出す文。長い部分を切って、形と CPU の語だけを残してある
const IMAGES: Record<(typeof TARGETS)[number], string> = {
  "linux-x64": "ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked",
  "linux-arm64": "ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), dynamically linked",
  "darwin-x64": "Mach-O 64-bit x86_64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL>",
  "darwin-arm64": "Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL>",
};

let sb: Sandbox;
// file(1) の偽。対象ごとの説明が DESCS/<name>.txt に書いてあるから、試験の形を差し替えられる
let descs: string;

beforeEach(() => {
  sb = makeSandbox();
  descs = join(sb.dir, "descs");
  mkdirSync(join(sb.dir, "bin"));
  mkdirSync(join(sb.dir, "dist"));
  mkdirSync(descs);

  const file = join(sb.dir, "bin", "file");
  writeFileSync(
    file,
    `#!/bin/sh
for last; do :; done
name="\${last##*/}"
[ -f "${descs}/\${name}.txt" ] || { echo "cannot open \${last}" >&2; exit 1; }
cat "${descs}/\${name}.txt"
`,
  );
  chmodSync(file, 0o755);
});
afterEach(() => removeSandbox(sb));

/** この target に対して file(1) が返す文を差し替える */
function imageOf(target: (typeof TARGETS)[number], image: string): void {
  writeFileSync(join(descs, `9router-cli-${target}.txt`), image);
}

/**
 * 偽のバイナリ。`site` だけが本物の define と同じ形にしてあり、これを tag と照合する
 */
type Opts = {
  /** --define が出す定義そのもの (既定は Bun 1.4.3 の形)。変えない限り検査は本物と同じ */
  site?: string;
  /** --version の答え (既定は埋め込んだ版) */
  says?: string;
  /** 本物のバイナリにはあるが define はない、余分なバイト。行頭に # を付けてコメントにする */
  extra?: string;
};

/** 余分なバイトは、偽が /bin/sh として壊れないようコメントにして入れる */
function asComments(text: string): string {
  return text
    .split("\n")
    .map((line) => `# ${line}`)
    .join("\n");
}

/** tag を define と同じ形で抱えていて、--version には別の値を答える偽のバイナリ */
function writeBinary(target: (typeof TARGETS)[number], embedded: string, opts: Opts = {}): void {
  const path = join(sb.dir, "dist", `9router-cli-${target}`);
  writeFileSync(
    path,
    `#!/bin/sh
# ${opts.site ?? `var VERSION = "${embedded}";`}
${opts.extra ? asComments(opts.extra) : ""}
case "$1" in
  --version) echo ${opts.says ?? embedded} ;;
  --help) echo "usage: 9router-cli" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

/** 4 つとも「その target の形」を名乗り、tag を抱えている dist を用意する */
function built(opts: { only?: (typeof TARGETS)[number]; version?: string } = {}): void {
  for (const target of TARGETS) {
    imageOf(target, IMAGES[target]);
    if (opts.only && target !== opts.only) continue;
    writeBinary(target, opts.version ?? VERSION);
  }
}

function check(env: Record<string, string | undefined> = {}, path?: string) {
  const merged = {
    PATH: path ?? `${join(sb.dir, "bin")}:${process.env.PATH ?? ""}`,
    HOME: sb.home,
    TAG,
    ...env,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  return Bun.spawnSync(["/bin/sh", SCRIPT], { cwd: sb.dir, env: clean });
}

describe("check-binaries.sh", () => {
  test("4 つとも自分の形を名乗って tag を抱えていれば通る", () => {
    built();

    const r = check();

    expect(r.exitCode).toBe(0);
  });

  test("別の CPU の形を名乗るバイナリが落ちたら通らない", () => {
    built();
    // build が 4 つとも host のままだったとき、--version は linux-x64 しか見ない
    imageOf("linux-arm64", IMAGES["linux-x64"]);

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/9router-cli-linux-arm64");
  });

  test("Mach-O を ELF と読み違えていても通らない", () => {
    built();
    imageOf("darwin-arm64", IMAGES["linux-arm64"]);

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/9router-cli-darwin-arm64");
  });

  test("tag を抱えていないバイナリは通らない (埋め込みが効いていない)", () => {
    built();
    writeBinary("darwin-x64", "0.1.0");

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/9router-cli-darwin-x64 does not carry the tag");
  });

  test("走らせられるバイナリが tag と違う版を名乗れば通らない", () => {
    built();
    // 中身は tag を抱えていても、syntax が違えば --version が違う値になる
    writeBinary("linux-x64", VERSION, { says: "0.1.0" });

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`says 0.1.0, tag is ${TAG}`);
  });

  test("走らせられない 3 つも無ければ通らない (build は成功でも中身は無い)", () => {
    built({ only: "linux-x64" });

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/9router-cli-linux-arm64 was not built");
  });

  test("TAG が無ければ止まる", () => {
    built();

    const r = check({ TAG: undefined });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("TAG");
  });

  // file(1) が無いと、走らせない 3 つを確かめる方法が無いので黙って通さない
  test("file が無ければ止まる", () => {
    built();

    const r = check({}, "/nonexistent");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("file(1)");
  });
});

// Bun がどのバイナリにも同梱する `bun create` の template の一部。本物のバイナリにもこの
// "version": "0.1.0" が 3 箇所ある。版の前後も版の文字で繋がっていないので、版の前後だけを
// 見て tag を数える検査では必ず当てになり、rc.2 のバイナリが v0.1.0 の tag を通ってしまう。
// そのため tag を数えるのは define が出す行だけに限る。
const BUN_TEMPLATE = `{
  "name": "bun-react-template",
  "version": "0.1.0",
  "private": true,
  "type": "module",
}`;

// 埋め込みの版は、define が出す行そのものとして出ていなければ tag と数えない
describe("埋め込みの版は define の形でなければ tag と数えない", () => {
  const TAG_010 = "v0.1.0";
  const noTag = "dist/9router-cli-darwin-x64 does not carry the tag";

  test("tag の define があれば通る (4 つとも)", () => {
    built({ version: "0.1.0" });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(0);
  });

  test("define が別の版なら tag と数えない", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.0-rc.2");

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
  });

  // 本物の衝突。rc.2 のバイナリには同梱の template の 0.1.0 がある。define を見ないと
  // v0.1.0 の tag を素通りして、rc.2 のバイナリを 0.1.0 として配ってしまう
  test("rc.2 のバイナリは、同梱の template が 0.1.0 でも v0.1.0 の tag を通らない", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.1-rc.2", { extra: BUN_TEMPLATE });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
    // 探した行も出す。ずれたとき、何を探して無かったのかがログから分かる
    expect(r.stderr.toString()).toContain(`no 'var VERSION = "0.1.0";' in it`);
  });

  // Bun は mise で 1.4.3 に固定してある。出した形が変われば一致は失われる。黙って緑にして
  // 出すのではなく release を止めるのは狙いで、形が変わるごとに直せば済むから
  test("define の形が Bun 1.4.3 と違えば通らない (出力がずれたら閉じる)", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.0", { site: `var VERSION="0.1.0"` });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
  });
});
