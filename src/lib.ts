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
      if (e instanceof TypeError || (e as Error).name === "ConnectionRefused") {
        process.stderr.write(`9router との通信に失敗: ${(e as Error).message}\n`);
        return 2;
      }
      throw e;
    }
  };

export const ARROW = " → ";
export const NONEXISTENT = "__9router_cli_nonexistent__";

type Config = { url?: string; api_key_command?: string; dashboard_password_command?: string };
function config(): Config {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const file = join(base, "9router-cli", "config.toml");
  if (!existsSync(file)) return {};
  try {
    return Bun.TOML.parse(readFileSync(file, "utf8")) as Config;
  } catch (e) {
    return die(`${file} を TOML として読めない: ${(e as Error).message}`, 2);
  }
}

export function baseUrl(): string {
  const u = process.env.NINE_ROUTER_URL || config().url;
  if (!u) return die("NINE_ROUTER_URL も設定の url も無い", 2);
  return u.replace(/\/+$/, "");
}

export const PASSWORD = "NINE_ROUTER_DASHBOARD_PASSWORD";
export const API_KEY = "NINE_ROUTER_API_KEY";
const CMD_KEY: Record<string, "api_key_command" | "dashboard_password_command"> = {
  [PASSWORD]: "dashboard_password_command",
  [API_KEY]: "api_key_command",
};

export function secret(name: string): string {
  const v = process.env[name];
  if (v) return v;
  const key = CMD_KEY[name];
  const cmd = key ? config()[key] : undefined;
  if (!cmd) return die(`${name} が env に無く、設定の ${key ?? "*_command"} も無い`, 2);
  const r = Bun.spawnSync(["sh", "-c", cmd], { env: process.env, stderr: "pipe" });
  const out = r.stdout.toString().replace(/\n$/, "");
  if (r.exitCode !== 0 || !out)
    return die(`${name} を ${key} から取れない (exit ${r.exitCode})`, 2);
  if (/[\r\n]/.test(out)) return die(`${name} として複数行が返った。値には使わない`, 2);
  process.env[name] = out;
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
  const res = await fetch(`${baseUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: secret(PASSWORD) }),
  });
  const raw = await res.text();
  if (res.status !== 200) return die(errorText(raw), 2);
  const c = res.headers.getSetCookie().find((x) => x.startsWith("auth_token="));
  return c ? (c.split(";")[0] ?? "") : die("auth_token が無い", 2);
}

export async function admin(cookie: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { Cookie: cookie, ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const raw = await res.text();
  if (!res.ok) return die(errorText(raw), 1);
  return JSON.parse(raw);
}

export const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ");
export const cell = (v: unknown) => (v === null || v === undefined ? "-" : String(v));
export const print = (s: string) => process.stdout.write(`${s}\n`);
export const json = (v: unknown) => print(JSON.stringify(v));
