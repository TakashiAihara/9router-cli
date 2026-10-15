import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class ExitError extends Error {
  constructor(
    message: string,
    public code: number,
  ) {
    super(message);
  }
}
export const die = (m: string, code: number): never => {
  throw new ExitError(m, code);
};
export const guard =
  <T>(fn: (o: T) => Promise<number>) =>
  async (o: T): Promise<number> => {
    try {
      return await fn(o);
    } catch (e) {
      if (e instanceof ExitError) {
        process.stderr.write(`${e.message}\n`);
        return e.code;
      }
      throw e;
    }
  };

export class CommError extends ExitError {
  constructor(
    message: string,
    public timedOut: boolean,
  ) {
    super(message, 2);
  }
}

function timeoutMs(env: string, defaultSec: number): number {
  const raw = process.env[env];
  if (raw === undefined) return defaultSec * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : die(`${env} は正の秒数にする: ${raw}`, 2);
}

// 2 つの env はテスト用の口ではなく、利用者が設定する口として公開する。
// テストは待たずに済ませたいので縮め、実用では infisical の login や 9router の応答が遅いときに延ばす。
// README と --help に同じ内容を載せる
export const adminTimeoutMs = () => timeoutMs("NINE_ROUTER_ADMIN_TIMEOUT", 20);
export const commandTimeoutMs = () => timeoutMs("NINE_ROUTER_COMMAND_TIMEOUT", 60);

// 9router の手前に proxy があると、届かなかった時に 502 / 503 / 504 が HTML のエラーページで返る。
// HTTP の応答として届くので区別しないと「相手が否と答えた」(exit 1) と読まれる
const GATEWAY_STATUS = new Set([502, 503, 504]);
const HTML_BODY = /^\s*(?:<!doctype\s+html|<html[\s>])/i;
const isProxyReply = (status: number, raw: string) =>
  GATEWAY_STATUS.has(status) && HTML_BODY.test(raw);

// 通信の失敗だけを ExitError に変える。応答の形の誤りは変換せず cli.ts の想定外 (exit 70) に届ける
export async function send(url: string, init: RequestInit, ms: number) {
  let res: Response;
  let raw: string;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    raw = await res.text();
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    throw new CommError(
      timedOut
        ? `9router が ${ms / 1000} 秒で応答しない: ${url}`
        : `9router との通信に失敗: ${(e as Error).message}`,
      timedOut,
    );
  }
  // proxy のエラーページは HTML が何行も詰まるので、本文をそのまま stderr にも出さない
  if (isProxyReply(res.status, raw))
    throw new CommError(
      `9router に届かなかった (HTTP ${res.status})。手前の proxy が返した応答で、9router 自身の返答ではない: ${url}`,
      false,
    );
  return { status: res.status, ok: res.ok, headers: res.headers, raw };
}

export const ARROW = " → ";
export const NONEXISTENT = "__9router_cli_nonexistent__";

type Config = { url?: string; api_key_command?: string; dashboard_password_command?: string };
function config(): Config {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const file = join(base, "9router-cli", "config.toml");
  if (!existsSync(file)) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return die(`${file} を TOML として読めない: ${(e as Error).message}`, 2);
  }
  for (const key of ["url", "api_key_command", "dashboard_password_command"]) {
    if (key in parsed && typeof parsed[key] !== "string")
      die(`${file} の ${key} は文字列にする`, 2);
  }
  return parsed as Config;
}

export function baseUrl(): string {
  const u = process.env.NINE_ROUTER_URL || config().url;
  if (!u) return die("NINE_ROUTER_URL も設定の url も無い", 2);
  // scheme の無い値は proxy 越しだと 502 の HTML が返り、通信の失敗ではなく相手の否に見える
  if (!/^https?:\/\//.test(u)) return die(`url は http:// か https:// で始める: ${u}`, 2);
  return u.replace(/\/+$/, "");
}

export const PASSWORD = "NINE_ROUTER_DASHBOARD_PASSWORD";
export const API_KEY = "NINE_ROUTER_API_KEY";
const CMD_KEY: Record<string, "api_key_command" | "dashboard_password_command"> = {
  [PASSWORD]: "dashboard_password_command",
  [API_KEY]: "api_key_command",
};

// detached で起動した子が持つプロセスグループをまとめて止める。
// 宛先は直下で起動した子の pid (= その pgid) だけなので、自分のプロセスグループには及ばない。
// Linux はグループにプロセスを残している間その pgid を pid として取らないので、別のグループを誤って指すこともない
function killGroup(pid: number): void {
  // 0 は自分のグループ、負の値は別の番号 (−1 なら全プロセス)。子の pid は自分の pid と同じにならない
  if (pid <= 1 || pid === process.pid) return;
  try {
    // 0 で居ることを確かめてから止める。空のグループは pgid を再利用されうるので、その場合は何もしない
    process.kill(-pid, 0);
    process.kill(-pid, "SIGKILL");
  } catch {
    // 既に止まっていれば (ESRCH) 止める対象も無いので、何もしなくてよい
  }
}

type Command = { timedOut: boolean; code: number | null; out: string; err: string };

// 直下の子が終わった後から pipe の EOF を待つ猶予。
// 孫が pipe を持ったままなら EOF は来ないので、この時間を信じてから孫ごと止める
const EOF_GRACE_MS = 200;

// 待ちを ms で打ち切って null を返す。onTimeout は打ち切りの前に止める対象へ signal を送るため
function deadline<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(null);
    }, ms);
  });
  return Promise.race([work, cut]).finally(() => clearTimeout(timer));
}

// 設定の *_command を走らせて出力を集める。
// 同期実行 (spawnSync) では実行中の JS が動かないので、Ctrl-C を受けて孫まで止める処理が書けない。
// detached で子を別グループにすると signal は子に届かないので、親が先に死んで孫が孤児として残る。
// そこで非同期で走らせ、待つあいだ handler を効かせたままにする
async function runCommand(cmd: string, ms: number): Promise<Command> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // 子の pid がそのまま pgid になるので、孫をまとめて止めるのに使える
    detached: true,
  });
  const pgid = proc.pid;
  // signal を受けたら先にグループを止めてから終わる。code は signal を素で受けたときと同じ (130 / 143)
  const onSigint = () => {
    killGroup(pgid);
    process.exit(130);
  };
  const onSigterm = () => {
    killGroup(pgid);
    process.exit(143);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // 出力が大きければ pipe のバッファで子が詰まるので、待つ前に読み始める。
  // 孫を追い払ったあとも出力を捨てずに済むよう、読み終えたら変数に残す
  let out = "";
  let err = "";
  const readOut = new Response(proc.stdout).text().then((t) => (out = t));
  const readErr = new Response(proc.stderr).text().then((t) => (err = t));
  const done = (async () => ({
    code: await proc.exited,
    out: await readOut,
    err: await readErr,
  }))();
  // 打ち切ったあとは待たないことがあるので、握り潰して unhandled にしない
  done.catch(() => {});

  try {
    // 時間切れは直下の子の終了だけで決める。孫が pipe を持ったまま残り続けても待たない
    const code = await deadline(proc.exited, ms, () => killGroup(pgid));
    if (code === null) return { timedOut: true, code: null, out: "", err: "" };

    // 直下の子は終わったので、残りは孫の分。孫が pipe を持ったままだと出力は揃っていても EOF が来ない。
    // 猶予を置いて待ち、待てなければ孫ごと止めてから出力を拾う (#6)
    const r = await deadline(done, EOF_GRACE_MS, () => killGroup(pgid));
    if (!r) await deadline(done, EOF_GRACE_MS);
    return { timedOut: false, code, out, err };
  } finally {
    // 正常・失敗・時間切れのどれで終わっても、孫が残っていれば止めておく
    killGroup(pgid);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export async function secret(name: string): Promise<string> {
  const v = process.env[name];
  if (v) return v;
  const key = CMD_KEY[name];
  const cmd = key ? config()[key] : undefined;
  if (!cmd) return die(`${name} が env に無く、設定の ${key ?? "*_command"} も無い`, 2);
  const ms = commandTimeoutMs();
  const r = await runCommand(cmd, ms);
  if (r.timedOut) return die(`${name} を ${key} から取れない: ${ms / 1000} 秒で返らない`, 2);
  const out = r.out.replace(/\r?\n$/, "");
  const why = r.err.trim().split("\n").pop() ?? "";
  if (r.code !== 0 || !out)
    return die(`${name} を ${key} から取れない (exit ${r.code}) ${why}`.trimEnd(), 2);
  if (/[\r\n]/.test(out)) return die(`${name} として複数行が返った。値には使わない`, 2);
  return out;
}

export function errorText(raw: string): string {
  try {
    const o = JSON.parse(raw);
    let err = o?.error;
    if (err && typeof err === "object") err = err.message;
    return typeof err === "string" && err ? err : raw;
  } catch {
    return raw;
  }
}

export async function login(): Promise<string> {
  const res = await send(
    `${baseUrl()}/api/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: await secret(PASSWORD) }),
    },
    adminTimeoutMs(),
  );
  if (res.status !== 200) return die(errorText(res.raw), 2);
  const c = res.headers.getSetCookie().find((x) => x.startsWith("auth_token="));
  return c ? (c.split(";")[0] ?? "") : die("auth_token が無い", 2);
}

export async function admin(cookie: string, method: string, path: string, payload?: unknown) {
  const res = await send(
    `${baseUrl()}${path}`,
    {
      method,
      headers: { Cookie: cookie, ...(payload ? { "Content-Type": "application/json" } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    },
    adminTimeoutMs(),
  );
  if (!res.ok) return die(errorText(res.raw), 1);
  return JSON.parse(res.raw);
}

export const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ");
export const cell = (v: unknown) => (v === null || v === undefined ? "-" : String(v));
export const print = (s: string) => process.stdout.write(`${s}\n`);
export const json = (v: unknown) => print(JSON.stringify(v));
