import { afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  API_KEY,
  DASHBOARD_PASSWORD,
  startFake,
  type Fake,
  type FakeOptions,
} from "./fake-router.ts";

// 時間切れの検査 (slow な偽モデル) とサブプロセスの起動を含むので、既定の 5 秒では足りない
setDefaultTimeout(30_000);

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
const HANG_LIMIT_MS = 20_000;

export type Env = Record<string, string | undefined>;
export type Ran = { code: number; out: string; err: string };

export type Sandbox = { dir: string; home: string; xdg: string };

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "9router-cli-test-"));
  const home = join(dir, "home");
  const xdg = join(dir, "xdg");
  mkdirSync(home);
  mkdirSync(xdg);
  return { dir, home, xdg };
}

export function removeSandbox(sb: Sandbox): void {
  rmSync(sb.dir, { recursive: true, force: true });
}

// 本物の NINE_ROUTER_* や利用者の設定ファイルが紛れ込まないよう、env は親から引き継がず組み直す
export async function runCli(
  sb: Sandbox,
  args: string[],
  env: Env = {},
  opts: { xdg?: boolean } = {},
): Promise<Ran> {
  const base: Env = { PATH: process.env.PATH, HOME: sb.home };
  if (opts.xdg !== false) base.XDG_CONFIG_HOME = sb.xdg;
  const merged = { ...base, ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) clean[k] = v;
  }

  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: sb.dir,
    env: clean,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill(), HANG_LIMIT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  return { code, out, err };
}

export type Ctx = {
  sb: Sandbox;
  fake: Fake;
  // url / password / endpoint key を env で渡した状態で起動する。undefined を渡した項目は外す
  run: (args: string[], env?: Env) => Promise<Ran>;
};

export function useFake(options: FakeOptions = {}): Ctx {
  const ctx = {} as Ctx;
  beforeEach(() => {
    ctx.sb = makeSandbox();
    ctx.fake = startFake(options);
    ctx.run = (args, env = {}) =>
      runCli(ctx.sb, args, {
        NINE_ROUTER_URL: ctx.fake.url,
        NINE_ROUTER_DASHBOARD_PASSWORD: DASHBOARD_PASSWORD,
        NINE_ROUTER_API_KEY: API_KEY,
        ...env,
      });
  });
  afterEach(() => {
    ctx.fake.stop();
    removeSandbox(ctx.sb);
  });
  return ctx;
}

export function writeConfig(sb: Sandbox, toml: string, opts: { xdg?: boolean } = {}): string {
  const dir =
    opts.xdg === false ? join(sb.home, ".config", "9router-cli") : join(sb.xdg, "9router-cli");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.toml");
  writeFileSync(file, toml);
  return file;
}

// 秘密を出すコマンドの偽。呼ばれた引数を log に 1 行ずつ残し、CMD_* の env で出力を壊す
export function writeSecretScript(sb: Sandbox): { script: string; log: string } {
  const script = join(sb.dir, "secret.sh");
  const log = join(sb.dir, "secret.log");
  writeFileSync(
    script,
    `#!/bin/sh
echo "$1" >> "${log}"
if [ -n "$CMD_FAIL" ]; then echo "error: machine identity login failed"; exit 1; fi
if [ -n "$CMD_STDERR" ]; then echo "first stderr line" >&2; echo "identity endpoint returned 503" >&2; exit 1; fi
if [ -n "$CMD_SLEEP" ]; then sleep "$CMD_SLEEP"; fi
if [ "$1" = pw ]; then v='${DASHBOARD_PASSWORD}'; else v='${API_KEY}'; fi
if [ -n "$CMD_NL" ]; then printf 'notice: update available\\n%s\\n' "$v"; exit 0; fi
if [ -n "$CMD_CR" ]; then printf '%s\\r\\n' "$v"; exit 0; fi
if [ -n "$CMD_CR_MID" ]; then printf 'a\\rb\\n'; exit 0; fi
if [ -n "$CMD_EMPTY" ]; then exit 0; fi
printf '%s\\n' "$v"
`,
  );
  chmodSync(script, 0o755);
  return { script, log };
}

// 兄弟の秘密が子の env に漏れていないかを log に残す秘密コマンドの偽。値そのものは書かない
export function writeLeakCheckScript(sb: Sandbox): { script: string; log: string } {
  const script = join(sb.dir, "leak.sh");
  const log = join(sb.dir, "leak.log");
  writeFileSync(
    script,
    `#!/bin/sh
if [ "$1" = pw ]; then
  v='${DASHBOARD_PASSWORD}'
  if [ -n "$NINE_ROUTER_API_KEY" ]; then echo "pw sees key" >> "${log}"; else echo "pw clean" >> "${log}"; fi
else
  v='${API_KEY}'
  if [ -n "$NINE_ROUTER_DASHBOARD_PASSWORD" ]; then echo "key sees pw" >> "${log}"; else echo "key clean" >> "${log}"; fi
fi
printf '%s\\n' "$v"
`,
  );
  chmodSync(script, 0o755);
  return { script, log };
}

// elapsed は実行ごとに変わるので固定の印に置き換える
export const normalizeElapsed = (s: string) => s.replace(/\t\d+\.\ds\t/g, "\t<t>\t");

export const tsv = (...lines: string[]) => `${lines.join("\n")}\n`;
