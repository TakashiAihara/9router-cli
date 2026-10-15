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
