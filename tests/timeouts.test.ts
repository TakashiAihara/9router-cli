import { describe, expect, test } from "bun:test";
import * as lib from "../src/lib.ts";
import { useFake } from "./helpers/cli.ts";

const FAST = { NINE_ROUTER_ADMIN_TIMEOUT: "0.5" };

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("時間切れの既定値", () => {
  test("管理 API / models / version は 20 秒", () => {
    expect(withEnv("NINE_ROUTER_ADMIN_TIMEOUT", undefined, () => lib.adminTimeoutMs())).toBe(
      20_000,
    );
  });

  test("*_command は 60 秒", () => {
    expect(withEnv("NINE_ROUTER_COMMAND_TIMEOUT", undefined, () => lib.commandTimeoutMs())).toBe(
      60_000,
    );
  });

  test("env は秒数で上書きできる", () => {
    expect(withEnv("NINE_ROUTER_ADMIN_TIMEOUT", "0.5", () => lib.adminTimeoutMs())).toBe(500);
  });
});

describe("login が応答しない", () => {
  const ctx = useFake({ hang: ["/api/auth/login"] });

  test("exit 2 で、時間切れを stderr に出す", async () => {
    const r = await ctx.run(["combos", "list"], FAST);

    expect(r.code).toBe(2);
    expect(r.err).toContain("0.5 秒");
    expect(r.out).toBe("");
  });
});

describe("管理 API が応答しない", () => {
  const ctx = useFake({ hang: ["/api/combos"] });

  test("exit 2 で、時間切れを stderr に出す", async () => {
    const r = await ctx.run(["combos", "list"], FAST);

    expect(r.code).toBe(2);
    expect(r.err).toContain("0.5 秒");
    expect(r.out).toBe("");
  });
});

describe("models が応答しない", () => {
  const ctx = useFake({ hang: ["/v1/models"] });

  test("exit 2 で、時間切れを stderr に出す", async () => {
    const r = await ctx.run(["models"], FAST);

    expect(r.code).toBe(2);
    expect(r.err).toContain("0.5 秒");
    expect(r.out).toBe("");
  });
});

describe("version が応答しない", () => {
  const ctx = useFake({ hang: ["/api/version"] });

  test("exit 2 で、時間切れを stderr に出す", async () => {
    const r = await ctx.run(["version"], FAST);

    expect(r.code).toBe(2);
    expect(r.err).toContain("0.5 秒");
    expect(r.out).toBe("");
  });
});

describe("時間切れの env が正の数でないとき", () => {
  const ctx = useFake();

  for (const bad of ["abc", "0", "-1", "Infinity"]) {
    test(`${bad} は通信する前に exit 2 で、変数名を示す`, async () => {
      const r = await ctx.run(["combos", "list"], { NINE_ROUTER_ADMIN_TIMEOUT: bad });

      expect(r.code).toBe(2);
      expect(r.err).toContain("NINE_ROUTER_ADMIN_TIMEOUT");
      expect(ctx.fake.log).toEqual([]);
    });
  }
});
