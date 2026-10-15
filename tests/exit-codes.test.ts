import { describe, expect, test } from "bun:test";
import { useFake } from "./helpers/cli.ts";

describe("管理 API が否と答えたとき", () => {
  const ctx = useFake({ adminErrorStatus: 500 });

  test("exit 1 で、サーバの文言を stderr に出す", async () => {
    const r = await ctx.run(["combos", "list"]);

    expect(r.code).toBe(1);
    expect(r.err).toContain("admin exploded");
    expect(r.out).toBe("");
  });
});

describe("version が否と答えたとき", () => {
  const ctx = useFake({ versionStatus: 503 });

  test("exit 1 で、サーバの文言を stderr に出す", async () => {
    const r = await ctx.run(["version"]);

    expect(r.code).toBe(1);
    expect(r.err).toContain("version unavailable");
    expect(r.out).toBe("");
  });
});

// 手前の proxy が 502 / 503 / 504 を HTML で返すと、9router が否を答えたように見える (#5)
describe("手前の proxy が HTML を返したとき", () => {
  // 対照。HTML が無い gateway status は 9router (または 前段) 自身の返答なので exit 1 のまま
  const jsonBody = useFake({ versionStatus: 502 });

  for (const status of [502, 503, 504]) {
    const ctx = useFake({ proxyStatus: status });

    test(`HTTP ${status} は通信の失敗 (exit 2) で、HTML を stderr に出さない`, async () => {
      const r = await ctx.run(["combos", "list"]);

      expect(r.code).toBe(2);
      expect(r.err).toContain("届かなかった");
      expect(r.err).toContain(String(status));
      expect(r.err).not.toContain("<html");
      expect(r.err).not.toContain("Bad Gateway");
      expect(r.out).toBe("");
    });
  }

  const ctx = useFake({ proxyStatus: 502 });

  test("version も通信の失敗 (exit 2) で落とす", async () => {
    const r = await ctx.run(["version"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("届かなかった");
    expect(r.err).not.toContain("<html");
    expect(r.out).toBe("");
  });

  test("models も通信の失敗 (exit 2) で落とす", async () => {
    const r = await ctx.run(["models"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("届かなかった");
    expect(r.out).toBe("");
  });

  test("probe は段の NG にせず、通信の失敗として止める", async () => {
    const r = await ctx.run(["probe", "--combo", "shared"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("届かなかった");
    expect(r.out).toBe("");
  });

  // HTML が無い gateway status は exit 1 のまま (上の対照)
  test("同じ status でも JSON の本文なら相手が否と答えた扱い (exit 1) のまま", async () => {
    const r = await jsonBody.run(["version"]);

    expect(r.code).toBe(1);
    expect(r.err).toContain("version unavailable");
    expect(r.err).not.toContain("届かなかった");
  });
});

describe("想定外の応答の形", () => {
  const ctx = useFake({ combosReply: {} });

  test("通信の誤りに見せず、exit 70 で落とす", async () => {
    const r = await ctx.run(["combos", "list"]);

    expect(r.code).toBe(70);
    expect(r.err).toContain("error:");
    expect(r.err).not.toContain("通信に失敗");
    expect(r.out).toBe("");
  });
});
