import { describe, expect, test } from "bun:test";
import { tsv, useFake } from "./helpers/cli.ts";
import { adminCalls, STATS, VERSION_INFO, VERSION_INFO_CURRENT } from "./helpers/fake-router.ts";

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
