import { describe, expect, test } from "bun:test";
import { useFake, tsv } from "./helpers/cli.ts";
import { adminCalls } from "./helpers/fake-router.ts";

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
        "c1\tkiro\tAccount 1\toauth\ttrue\tunavailable\t403\t[403]: bearer invalid\t2026-10-02T13:55:18.801Z\tlocks=0",
        "c2\tcodex\t-\toauth\ttrue\tactive\t-\t-\t-\tlocks=1",
        `c3\topenrouter\tmy-or\tapikey\tfalse\terror\t500\t${LAST_ERROR_120}\t-\tlocks=0`,
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
        id: "c1",
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
        id: "c2",
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
        id: "c3",
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

describe("providers list の name の伏せ方 (#2)", () => {
  const atName = useFake({
    connections: [
      {
        id: "a1",
        provider: "openrouter",
        name: "team@example.org",
        authType: "apikey",
        isActive: true,
        testStatus: "active",
      },
      {
        id: "a2",
        provider: "kiro",
        name: "me@example.org",
        authType: "oauth",
        isActive: true,
        testStatus: "active",
      },
      { id: "a3", provider: "codex", name: "work", authType: "oauth", isActive: true },
    ],
  });

  test("apikey の name は利用者が選んだ表示名なので、@ を含んでいても伏せない", async () => {
    const r = await atName.run(["providers", "list"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(
      tsv(
        "a1\topenrouter\tteam@example.org\tapikey\ttrue\tactive\t-\t-\t-\tlocks=0",
        "a2\tkiro\t-\toauth\ttrue\tactive\t-\t-\t-\tlocks=0",
        "a3\tcodex\twork\toauth\ttrue\t-\t-\t-\t-\tlocks=0",
      ),
    );
    expect(r.err).toBe("");
  });

  test("--json でも apikey の name が出て、oauth の email は null", async () => {
    const r = await atName.run(["providers", "list", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).map((c: { id: string; name: unknown }) => [c.id, c.name])).toEqual([
      ["a1", "team@example.org"],
      ["a2", null],
      ["a3", "work"],
    ]);
  });

  test("編集の応答でも apikey の name は伏せない", async () => {
    const r = await atName.run(["providers", "set", "a1", "--priority", "2", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).name).toBe("team@example.org");
  });

  test("編集の応答で oauth の email は伏せる", async () => {
    const r = await atName.run(["providers", "set", "a2", "--priority", "2", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).name).toBeNull();
    expect(r.out).not.toContain("me@example.org");
  });
});

// authType が apikey だと確認できたときだけ @ を含む name を出す。フィールドが無い / null /
// 別の値 / 9router が将来増やす型は email かもしれないので伏せる
describe("providers の authType が apikey 以外 / 不明なとき", () => {
  const maybeEmail = useFake({
    connections: [
      // authType が無い (フィールド自体が無い)
      { id: "u1", provider: "kiro", name: "no-type@example.org", isActive: true },
      // authType が null
      { id: "u2", provider: "kiro", name: "null-type@example.org", authType: null, isActive: true },
      // 9router が将来増やす型。email を入れる型かもしれない
      {
        id: "u3",
        provider: "kiro",
        name: "future@example.org",
        authType: "oauth2",
        isActive: true,
      },
      // 大文字小文字が違う値。apikey と見ない
      {
        id: "u4",
        provider: "kiro",
        name: "ApiKey@example.org",
        authType: "APIKEY",
        isActive: true,
      },
      // @ が無く、伏せる対象ではない name は型が不明でも出す
      { id: "u5", provider: "kiro", name: "no-at-name", isActive: true },
    ],
  });

  test("list は @ を含む name を全部伏せる (authType が無い / null / 別の値 / 大小文字違い)", async () => {
    const r = await maybeEmail.run(["providers", "list", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).map((c: { id: string; name: unknown }) => [c.id, c.name])).toEqual([
      ["u1", null],
      ["u2", null],
      ["u3", null],
      ["u4", null],
      ["u5", "no-at-name"],
    ]);
    for (const leaked of [
      "no-type@example.org",
      "null-type@example.org",
      "future@example.org",
      "ApiKey@example.org",
    ]) {
      expect(r.out).not.toContain(leaked);
      expect(r.err).not.toContain(leaked);
    }
  });

  test("list は @ が無い name を出す (型が不明でも本人を伏せられる物だけを落とす)", async () => {
    const r = await maybeEmail.run(["providers", "list"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(
      tsv(
        "u1\tkiro\t-\t-\ttrue\t-\t-\t-\t-\tlocks=0",
        "u2\tkiro\t-\t-\ttrue\t-\t-\t-\t-\tlocks=0",
        "u3\tkiro\t-\toauth2\ttrue\t-\t-\t-\t-\tlocks=0",
        "u4\tkiro\t-\tAPIKEY\ttrue\t-\t-\t-\t-\tlocks=0",
        "u5\tkiro\tno-at-name\t-\ttrue\t-\t-\t-\t-\tlocks=0",
      ),
    );
  });

  test("編集の応答でも、authType が無ければ email は伏せる", async () => {
    const r = await maybeEmail.run(["providers", "set", "u1", "--priority", "2", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).name).toBeNull();
    expect(r.out).not.toContain("no-type@example.org");
  });

  test("編集の応答でも、authType が別の値なら email は伏せる", async () => {
    const r = await maybeEmail.run(["providers", "set", "u3", "--priority", "2", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).name).toBeNull();
    expect(r.out).not.toContain("future@example.org");
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

  test("--name に @ が入っていても伏せない (利用者が選んだ表示名)", async () => {
    const r = await ctx.run(
      ["providers", "add", "openrouter", "--key-env", "NEWKEY", "--name", "team@example.org"],
      { NEWKEY: "sk-new-5588" },
    );

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("c-new\topenrouter\tteam@example.org\tactive"));
  });

  // 偽サーバの add 応答は authType を返さない。list / set では「不明なら伏せる」判定になるが、
  // add で作る接続は apikey だけなので、選んだ @ を含む表示名は出す (#2)
  test("add の応答に authType が無いのにも、@ を含む --name を出して、キーだけ伏せる", async () => {
    const r = await ctx.run(
      [
        "providers",
        "add",
        "openrouter",
        "--key-env",
        "NEWKEY",
        "--name",
        "me@team.example",
        "--json",
      ],
      { NEWKEY: "sk-new-5588" },
    );

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "c-new",
      provider: "openrouter",
      name: "me@team.example",
      testStatus: "active",
    });
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

describe("providers list の lock の時刻", () => {
  const naive = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19);
  const zoned = useFake({
    connections: [
      {
        id: "c9",
        provider: "kiro",
        name: "n",
        authType: "apikey",
        isActive: true,
        testStatus: "active",
        modelLock_future: naive(60 * 60 * 1000),
        modelLock_past: naive(-60 * 60 * 1000),
        modelLock_offset: `${naive(60 * 60 * 1000 + 9 * 60 * 60 * 1000)}+09:00`,
        modelLock_space: naive(60 * 60 * 1000).replace("T", " "),
      },
    ],
  });

  test("タイムゾーンの無い時刻は UTC として読む (JST の host でも 9 時間ずれない)", async () => {
    const r = await zoned.run(["providers", "list"], { TZ: "Asia/Tokyo" });

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("c9\tkiro\tn\tapikey\ttrue\tactive\t-\t-\t-\tlocks=3"));
  });
});

describe("providers maintenance", () => {
  test("接続を編集し、送った鍵は出力に出さず、サーバが保存した値を返す", async () => {
    const r = await ctx.run(
      [
        "providers",
        "set",
        "c3",
        "--name",
        "new name",
        "--priority",
        "2",
        "--active",
        "--key-env",
        "NEWKEY",
        "--json",
      ],
      { NEWKEY: "sk-replaced-123" },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "c3",
      provider: "openrouter",
      name: "new name",
      isActive: true,
      priority: 2,
    });
    const put = ctx.fake.log.find((l) => l.method === "PUT");
    expect(put?.path).toBe("/api/providers/c3");
    expect(put?.body).toEqual({
      name: "new name",
      priority: 2,
      isActive: true,
      apiKey: "sk-replaced-123",
    });
    expect(r.out).not.toContain("sk-replaced-123");
    expect(r.err).not.toContain("sk-replaced-123");
  });

  // 偽サーバは実物と異なり token を平文で返す。伏せるのは CLI 側のフィールド選択だけ
  test("編集の応答が token / clientSecret を持っていても出さない", async () => {
    const r = await ctx.run(["providers", "set", "c1", "--priority", "3"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("c1\tkiro\tAccount 1\ttrue\t3"));
    for (const leaked of ["SECRET-", "someone@example.com"]) {
      expect(r.out).not.toContain(leaked);
      expect(r.err).not.toContain(leaked);
    }
  });

  test("編集の応答の name が email でも出さない", async () => {
    const r = await ctx.run(["providers", "set", "c2", "--priority", "5", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "c2",
      provider: "codex",
      name: null,
      isActive: true,
      priority: 5,
    });
    expect(r.out).not.toContain("owner@example.com");
  });

  test("無効化し、編集項目が無ければ通信しない", async () => {
    const r = await ctx.run(["providers", "set", "c1", "--inactive"]);
    expect(r.code).toBe(0);
    expect(ctx.fake.log.find((l) => l.method === "PUT")?.body).toEqual({ isActive: false });
    const empty = await ctx.run(["providers", "set", "c1"]);
    expect(empty.code).toBe(2);
    expect(ctx.fake.log.filter((l) => l.method === "PUT")).toHaveLength(1);
  });

  test("key の env が空なら exit 2 で、変数名を示して何も送らない", async () => {
    const r = await ctx.run(["providers", "set", "c3", "--key-env", "NOPE_UNSET_VAR"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("NOPE_UNSET_VAR");
    expect(ctx.fake.log).toEqual([]);
  });

  test("--name が空なら exit 2 で、何も送らない", async () => {
    const r = await ctx.run(["providers", "set", "c1", "--name", " "]);
    expect(r.code).toBe(2);
    expect(ctx.fake.log).toEqual([]);
  });

  test("OAuth 接続には API key の更新を送らず、他の項目も書かない", async () => {
    const r = await ctx.run(["providers", "set", "c1", "--name", "n", "--key-env", "NEWKEY"], {
      NEWKEY: "secret",
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("apikey");
    expect(r.err).toContain("c1");
    // 型を確かめる GET は行くが、PUT は 1 本も無い (0.5.91 は 200 で黙って捨てる)
    expect(adminCalls(ctx.fake.log)).toEqual(["POST /api/auth/login", "GET /api/providers/c1"]);
  });

  test("接続テストは valid で終了コードを分ける", async () => {
    const bad = await ctx.run(["providers", "test", "c1", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toEqual({
      id: "c1",
      valid: false,
      error: "expired",
      refreshed: false,
    });
    const good = await ctx.run(["providers", "test", "c2"]);
    expect(good.code).toBe(0);
    expect(good.out).toBe(tsv("c2\tOK\t-\ttrue"));
  });

  test("ID で接続を削除する", async () => {
    const r = await ctx.run(["providers", "delete", "c3", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ action: "deleted", id: "c3" });
    expect(ctx.fake.log.find((l) => l.method === "DELETE")?.path).toBe("/api/providers/c3");
    const list = await ctx.run(["providers", "list", "--json"]);
    expect(JSON.parse(list.out).map((c: { id: string }) => c.id)).not.toContain("c3");
  });
});

describe("providers maintenance の失敗", () => {
  const notFound = useFake({ adminErrorStatus: 404 });

  test("管理 API が否と答えたら exit 1 で、サーバの文言を stderr に出す", async () => {
    for (const args of [
      ["providers", "set", "c1", "--inactive"],
      ["providers", "delete", "c1"],
      ["providers", "test", "c1"],
    ]) {
      const r = await notFound.run(args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("admin exploded");
      expect(r.out).toBe("");
    }
  });
});

describe("providers test の応答", () => {
  const messy = useFake({
    connections: [
      {
        id: "m1",
        provider: "openrouter",
        name: "messy",
        authType: "apikey",
        isActive: true,
        testReply: {
          valid: false,
          error: "401: invalid key\tagain\r\n<html>oops</html>",
          refreshed: false,
        },
      },
    ],
  });

  test("error を 1 行にして、接続ごとに 1 行で出す", async () => {
    const r = await messy.run(["providers", "test", "m1"]);

    expect(r.code).toBe(1);
    expect(r.out).toBe(tsv("m1\tNG\t401: invalid key again <html>oops</html>\tfalse"));
  });
});

describe("providers set の使い方", () => {
  test("--active と --inactive は同時に指定できない", async () => {
    const r = await ctx.run(["providers", "set", "c1", "--active", "--inactive"]);
    expect(r.code).toBe(2);
    expect(ctx.fake.log).toEqual([]);
  });

  for (const bad of ["", " ", "-1", "1.5", "abc"]) {
    test(`--priority ${JSON.stringify(bad)} は通信する前に exit 2`, async () => {
      const r = await ctx.run(["providers", "set", "c1", "--priority", bad]);
      expect(r.code).toBe(2);
      expect(ctx.fake.log).toEqual([]);
    });
  }
});
