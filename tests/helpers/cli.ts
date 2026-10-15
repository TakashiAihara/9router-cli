import { afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
function cliEnv(sb: Sandbox, env: Env, opts: { xdg?: boolean }): Record<string, string> {
  const base: Env = { PATH: process.env.PATH, HOME: sb.home };
  if (opts.xdg !== false) base.XDG_CONFIG_HOME = sb.xdg;
  const merged = { ...base, ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) clean[k] = v;
  }
  return clean;
}

// CLI を走らせたまま返す。待ち続ける前に signal を送りたいとき用
export function startCli(sb: Sandbox, args: string[], env: Env = {}, opts: { xdg?: boolean } = {}) {
  return Bun.spawn([process.execPath, CLI, ...args], {
    cwd: sb.dir,
    env: cliEnv(sb, env, opts),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function finishCli(proc: ReturnType<typeof startCli>): Promise<Ran> {
  const killer = setTimeout(() => proc.kill(), HANG_LIMIT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  } finally {
    clearTimeout(killer);
  }
}

export async function runCli(
  sb: Sandbox,
  args: string[],
  env: Env = {},
  opts: { xdg?: boolean } = {},
): Promise<Ran> {
  return finishCli(startCli(sb, args, env, opts));
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

// 時間内に返らない command の偽。command は孫 (command を親に持つ子) を 1 つ起動して止まる。
// 孫は自分の pid を pidFile に残し、SIGINT と SIGTERM を無視する。
// よって孫の pid が消えたかどうかで「sh だけを殺した」か「プロセスグループごと止めた」かが分かれる。
// 120 秒で自然に終わる。試験が設定する時間切れより長いので、自然に終わる前に消えたことだけを見る。
export function writeHangCommand(sb: Sandbox): { command: string; pidFile: string } {
  const child = join(sb.dir, "hang-child.sh");
  const command = join(sb.dir, "hang-command.sh");
  const pidFile = join(sb.dir, "hang-child.pid");
  writeFileSync(
    child,
    `#!/bin/sh
trap '' INT TERM
echo "$$" > "${pidFile}"
i=0
while [ "$i" -lt 240 ]; do sleep 0.5; i=$((i + 1)); done
`,
  );
  // sh -c がこの script を exec しても、script 自身が & と wait を持つので孫は必ず 1 つ下にいる
  writeFileSync(command, `#!/bin/sh\nsh "${child}" &\nwait\n`);
  chmodSync(child, 0o755);
  chmodSync(command, 0o755);
  return { command, pidFile };
}

// 1 行返してから stdout を持ち続ける子を background で残す command の偽 (#6)。
// 直下の sh は値を出した直後に終わるので、出力は正しいのに孫の pipe だけが残り、EOF が来ない状態になる。
// 孫は pid を pidFile に残し SIGINT と SIGTERM を無視するので、猶予を置いてプロセスグループごと止めたときだけ消える。
// pidFile を待ってから値を返すので、孫が pipe を持ったまま直下の sh が終わるのは確実
export function writePipeHolderCommand(
  sb: Sandbox,
  value: string,
): { command: string; pidFile: string } {
  const child = join(sb.dir, "pipe-holder.sh");
  const command = join(sb.dir, "pipe-holder-command.sh");
  const pidFile = join(sb.dir, "pipe-holder.pid");
  writeFileSync(
    child,
    `#!/bin/sh
trap '' INT TERM
echo "$$" > "${pidFile}"
i=0
while [ "$i" -lt 240 ]; do sleep 0.5; i=$((i + 1)); done
`,
  );
  writeFileSync(
    command,
    `#!/bin/sh
sh "${child}" &
while [ ! -s "${pidFile}" ]; do sleep 0.05; done
printf '%s\\n' '${value}'
`,
  );
  chmodSync(child, 0o755);
  chmodSync(command, 0o755);
  return { command, pidFile };
}

// pid が生きているか。ゾンビ (Z) は既に動いていないので死んだものと数える。
// kill -0 はゾンビにも成功し、孤児にした子は親 (init) に kill された後もゾンビで残ることがあるので使わない
export function pidAlive(pid: number): boolean {
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString();
  const err = r.stderr.toString().trim();
  // ps が 1 を返して stdout も stderr も空なのは「対象がない」= 死んだ、ときだけ (procps, BSD とも同じ)。
  // 不正な option や fork の失敗も 1 を返し stdout は空なので、ここを混ぜると生きてる pid を
  // 「死んだ」と誤認して waitPidGone が待たずに true を返す。ps 自身の異常として落とす
  if (r.exitCode === 1 && out === "" && err === "") return false;
  if (r.exitCode !== 0)
    throw new Error(`ps -p ${pid} failed: exit=${r.exitCode} signal=${r.signalCode} ${err}`);
  const stat = out.trim();
  // 0 は「いた」と ps が言った印。stat が空なら出力を読めない、生かさない
  if (stat === "") throw new Error(`ps -p ${pid} exited 0 without stat`);
  return !stat.startsWith("Z");
}

// pid が消えるまで待つ。時間切れの直後は signal の到着と親 (init) による reaping が遅れるので、
// 1 回見ただけでは決めない
export async function waitPidGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (pidAlive(pid) && Date.now() < until) await Bun.sleep(50);
  return !pidAlive(pid);
}

// pid ファイルが現れるまで待って、その中の pid を返す。現れなければ null (その検査は成立しない)
export async function waitPidFile(file: string, ms: number): Promise<number | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(file)) return Number(readFileSync(file, "utf8").trim());
    await Bun.sleep(50);
  }
  return null;
}

// elapsed は実行ごとに変わるので固定の印に置き換える
export const normalizeElapsed = (s: string) => s.replace(/\t\d+\.\ds\t/g, "\t<t>\t");

export const tsv = (...lines: string[]) => `${lines.join("\n")}\n`;
