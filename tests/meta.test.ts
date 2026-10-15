import { describe, expect, test } from "bun:test";
import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, tsv, useFake } from "./helpers/cli.ts";
import {
  adminCalls,
  STATS,
  VERSION_INFO,
  VERSION_INFO_CURRENT,
  VERSION_INFO_UNKNOWN,
} from "./helpers/fake-router.ts";

const ctx = useFake();

describe("version", () => {
  test("本体の版と更新の有無を 1 行で出す。秘密も login も要らない", async () => {
    const r = await ctx.run(["version"], {
      NINE_ROUTER_DASHBOARD_PASSWORD: undefined,
      NINE_ROUTER_API_KEY: undefined,
    });

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("0.5.99\t0.6.2\ttrue"));
    expect(ctx.fake.log.map((l) => `${l.method} ${l.path}`)).toEqual(["GET /api/version"]);
    expect(ctx.fake.log[0]?.cookie).toBeNull();
  });

  test("--json は API の応答をそのまま返す", async () => {
    const r = await ctx.run(["version", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(VERSION_INFO);
  });

  describe("更新が無いとき", () => {
    const current = useFake({ upToDate: true });

    test("hasUpdate の列が false になる", async () => {
      const r = await current.run(["version"]);

      expect(r.code).toBe(0);
      expect(r.out).toBe(tsv("0.6.2\t0.6.2\tfalse"));
      expect(JSON.parse((await current.run(["version", "--json"])).out)).toEqual(
        VERSION_INFO_CURRENT,
      );
    });
  });

  // upstream が npm に届かないと latestVersion が null で hasUpdate も false になる (#3)
  describe("更新を確認できなかったとき", () => {
    const unknown = useFake({ versionLatestNull: true });

    test("「更新なし」と読めないよう unknown を出す", async () => {
      const r = await unknown.run(["version"]);

      expect(r.code).toBe(0);
      expect(r.out).toBe(tsv("0.5.99\tunknown\tfalse"));
    });

    test("--json は応答をそのまま返す (null が分かるので書き換えない)", async () => {
      const r = await unknown.run(["version", "--json"]);

      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual(VERSION_INFO_UNKNOWN);
    });
  });
});

describe("usage", () => {
  test("既定は today の集計で、requests / prompt / completion / cost を 1 行で出す", async () => {
    const r = await ctx.run(["usage"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("144\t1312345\t98765\t4.32"));
    expect(adminCalls(ctx.fake.log)).toEqual([
      "POST /api/auth/login",
      "GET /api/usage/stats?period=today",
    ]);
  });

  test("--period を query に渡す", async () => {
    const r = await ctx.run(["usage", "--period", "24h"]);

    expect(r.code).toBe(0);
    expect(adminCalls(ctx.fake.log)).toEqual([
      "POST /api/auth/login",
      "GET /api/usage/stats?period=24h",
    ]);
  });

  test("--json は API の応答をそのまま返す", async () => {
    const r = await ctx.run(["usage", "--period", "30d", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(STATS);
    expect(adminCalls(ctx.fake.log)).toContain("GET /api/usage/stats?period=30d");
  });

  test("知らない period は通信する前に exit 2", async () => {
    const r = await ctx.run(["usage", "--period", "1y"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("1y");
    expect(ctx.fake.log).toEqual([]);
  });
});

describe("使い方の誤り", () => {
  test("知らないコマンドは通信する前に exit 2", async () => {
    const r = await ctx.run(["bogus"]);

    expect(r.code).toBe(2);
    expect(r.err).not.toBe("");
    expect(ctx.fake.log).toEqual([]);
  });
});

// env の口は README と同じ内容を --help にも出す (#4)
describe("--help", () => {
  test("接続と時間切れの env を示す", async () => {
    const r = await ctx.run(["--help"]);

    expect(r.code).toBe(0);
    for (const env of [
      "NINE_ROUTER_URL",
      "NINE_ROUTER_DASHBOARD_PASSWORD",
      "NINE_ROUTER_API_KEY",
      "NINE_ROUTER_ADMIN_TIMEOUT",
      "NINE_ROUTER_COMMAND_TIMEOUT",
    ])
      expect(r.out).toContain(env);
    expect(ctx.fake.log).toEqual([]);
  });
});

describe("usage の period", () => {
  for (const period of ["60d", "all"]) {
    test(`${period} を query に渡す`, async () => {
      const r = await ctx.run(["usage", "--period", period]);

      expect(r.code).toBe(0);
      expect(adminCalls(ctx.fake.log)).toEqual([
        "POST /api/auth/login",
        `GET /api/usage/stats?period=${period}`,
      ]);
    });
  }
});

describe("--version", () => {
  test("package.json の version を出す (別の version を置いた複製で確かめる)", async () => {
    const repo = resolve(import.meta.dir, "..");
    const sb = makeSandbox();
    try {
      cpSync(join(repo, "src"), join(sb.dir, "src"), { recursive: true });
      symlinkSync(join(repo, "node_modules"), join(sb.dir, "node_modules"));
      writeFileSync(join(sb.dir, "package.json"), JSON.stringify({ name: "x", version: "7.7.7" }));

      const r = Bun.spawnSync([process.execPath, join(sb.dir, "src/cli.ts"), "--version"], {
        env: { PATH: process.env.PATH ?? "", HOME: sb.home },
      });

      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toBe("7.7.7\n");
    } finally {
      removeSandbox(sb);
    }
  });
});
