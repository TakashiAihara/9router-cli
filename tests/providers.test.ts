import { describe, expect, test } from "bun:test";
import { useFake, tsv } from "./helpers/cli.ts";

const ctx = useFake();

// 偽サーバの c3 の lastError は "E" + "0123456789" x 15 (151 字)。先頭 120 字で切る
const LAST_ERROR_120 =
  "E01234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678";

describe("providers list", () => {
  test("接続ごとに 1 行で状態を出す。email の name は伏せ、lastError は 1 行にして 120 字で切る", async () => {
    const r = await ctx.run(["providers", "list"]);

    expect(LAST_ERROR_120).toHaveLength(120);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      tsv(
        "kiro\tAccount 1\toauth\ttrue\tunavailable\t403\t[403]: bearer invalid\t2026-10-02T13:55:18.801Z\tlocks=0",
        "codex\t-\toauth\ttrue\tactive\t-\t-\t-\tlocks=1",
        `openrouter\tmy-or\tapikey\tfalse\terror\t500\t${LAST_ERROR_120}\t-\tlocks=0`,
      ),
    );
    expect(r.err).toBe("");
  });

  test("token / clientSecret / email を stdout にも stderr にも出さない", async () => {
    const r = await ctx.run(["providers", "list"]);

    expect(r.out).toContain("kiro");
    for (const leaked of ["SECRET-", "someone@example.com", "owner@example.com"]) {
      expect(r.out).not.toContain(leaked);
      expect(r.err).not.toContain(leaked);
    }
  });

  test("--json は伏せた項目だけの配列で、name の email は null", async () => {
    const r = await ctx.run(["providers", "list", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([
      {
        provider: "kiro",
        name: "Account 1",
        authType: "oauth",
        isActive: true,
        testStatus: "unavailable",
        errorCode: 403,
        lastError: "[403]: bearer invalid",
        expiresAt: "2026-10-02T13:55:18.801Z",
        locks: 0,
      },
      {
        provider: "codex",
        name: null,
        authType: "oauth",
        isActive: true,
        testStatus: "active",
        errorCode: null,
        lastError: null,
        expiresAt: null,
        locks: 1,
      },
      {
        provider: "openrouter",
        name: "my-or",
        authType: "apikey",
        isActive: false,
        testStatus: "error",
        errorCode: 500,
        lastError: LAST_ERROR_120,
        expiresAt: null,
        locks: 0,
      },
    ]);
  });
});

describe("providers add", () => {
  test("鍵の env が空なら exit 2 で、変数名を示して何も POST しない", async () => {
    const r = await ctx.run(["providers", "add", "openrouter", "--key-env", "NOPE_UNSET_VAR"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("NOPE_UNSET_VAR");
    expect(ctx.fake.log.filter((l) => l.method === "POST" && l.path === "/api/providers")).toEqual(
      [],
    );
  });

  test("鍵は env から POST に載せ、応答の鍵は stdout にも stderr にも出さない", async () => {
    const r = await ctx.run(
      ["providers", "add", "openrouter", "--key-env", "NEWKEY", "--name", "my-or"],
      { NEWKEY: "sk-new-5588" },
    );

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("c-new\topenrouter\tmy-or\tactive"));
    const post = ctx.fake.log.find((l) => l.method === "POST" && l.path === "/api/providers");
    expect(post?.body).toEqual({ provider: "openrouter", apiKey: "sk-new-5588", name: "my-or" });
    expect(r.out).not.toContain("sk-new-5588");
    expect(r.err).not.toContain("sk-new-5588");
  });

  test("--name が無ければ body に name を載せない", async () => {
    const r = await ctx.run(["providers", "add", "openrouter", "--key-env", "NEWKEY"], {
      NEWKEY: "sk-new-5588",
    });

    expect(r.code).toBe(0);
    const post = ctx.fake.log.find((l) => l.method === "POST" && l.path === "/api/providers");
    expect(post?.body).toEqual({ provider: "openrouter", apiKey: "sk-new-5588" });
  });

  test("--json は id / provider / name / testStatus だけを返す", async () => {
    const r = await ctx.run(
      ["providers", "add", "openrouter", "--key-env", "NEWKEY", "--name", "my-or", "--json"],
      { NEWKEY: "sk-new-5588" },
    );

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "c-new",
      provider: "openrouter",
      name: "my-or",
      testStatus: "active",
    });
    expect(r.out).not.toContain("sk-new-5588");
  });

  test("--key-env が無ければ usage エラーで exit 2", async () => {
    const r = await ctx.run(["providers", "add", "openrouter"]);

    expect(r.code).toBe(2);
    expect(r.err).not.toBe("");
    expect(ctx.fake.log).toEqual([]);
  });
});
