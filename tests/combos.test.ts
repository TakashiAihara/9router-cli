import { describe, expect, test } from "bun:test";
import { useFake, tsv } from "./helpers/cli.ts";
import { adminCalls, DASHBOARD_PASSWORD } from "./helpers/fake-router.ts";

const ctx = useFake();

describe("combos list", () => {
  test("login を中で済ませ、combo ごとに 1 行で段を順に出す", async () => {
    const r = await ctx.run(["combos", "list"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(
      tsv(
        "free-forever\tkr/dead → oc/good",
        "translate\tocg/good → ocg/sse",
        "shared\toc/good → ocg/good",
      ),
    );
    expect(r.err).toBe("");
    expect(adminCalls(ctx.fake.log)).toEqual(["POST /api/auth/login", "GET /api/combos"]);
    expect(ctx.fake.log[0]?.body).toEqual({ password: DASHBOARD_PASSWORD });
    expect(ctx.fake.log[1]?.cookie).toContain("auth_token=tok-9f2");
  });

  test("誤ったパスワードは exit 2 で、サーバの文言を stderr に出す", async () => {
    const r = await ctx.run(["combos", "list"], { NINE_ROUTER_DASHBOARD_PASSWORD: "wrong-pw" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("Invalid password");
    expect(r.out).toBe("");
    expect(adminCalls(ctx.fake.log)).toEqual(["POST /api/auth/login"]);
  });

  test("--json は id / name / models の配列", async () => {
    const r = await ctx.run(["combos", "list", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([
      { id: "id-ff", name: "free-forever", models: ["kr/dead", "oc/good"] },
      { id: "id-tr", name: "translate", models: ["ocg/good", "ocg/sse"] },
      { id: "id-sh", name: "shared", models: ["oc/good", "ocg/good"] },
    ]);
  });
});

describe("combos set", () => {
  test("既存は PUT で段を全置換し、前後を出す", async () => {
    const r = await ctx.run(["combos", "set", "shared", "ocg/sse", "kr/dead", "oc/good"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("before: oc/good → ocg/good", "after: ocg/sse → kr/dead → oc/good"));
    const put = ctx.fake.log.find((l) => l.method === "PUT");
    expect(put?.path).toBe("/api/combos/id-sh");
    expect(put?.body).toEqual({ models: ["ocg/sse", "kr/dead", "oc/good"] });
  });

  test("--json は更新の前後を返す", async () => {
    const r = await ctx.run(["combos", "set", "translate", "ocg/sse", "oc/good", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      action: "updated",
      name: "translate",
      before: ["ocg/good", "ocg/sse"],
      after: ["ocg/sse", "oc/good"],
    });
  });

  test("無い名前は --create が無ければ何も書かず exit 2", async () => {
    const r = await ctx.run(["combos", "set", "no-such", "ocg/good"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("--create");
    expect(r.err).toContain("no-such");
    expect(r.out).toBe("");
    // login と一覧の取得まで進んだうえで、POST / PUT が 1 本も無い
    expect(adminCalls(ctx.fake.log)).toEqual(["POST /api/auth/login", "GET /api/combos"]);
  });

  test("--create で POST する", async () => {
    const r = await ctx.run(["combos", "set", "no-such", "ocg/good", "ocg/sse", "--create"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("created: no-such: ocg/good → ocg/sse"));
    const post = ctx.fake.log.find((l) => l.method === "POST" && l.path === "/api/combos");
    expect(post?.body).toEqual({ name: "no-such", models: ["ocg/good", "ocg/sse"] });
  });

  test("--create の --json は作った名前と段を返す", async () => {
    const r = await ctx.run([
      "combos",
      "set",
      "no-such",
      "ocg/good",
      "ocg/sse",
      "--create",
      "--json",
    ]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      action: "created",
      name: "no-such",
      models: ["ocg/good", "ocg/sse"],
    });
  });

  test("--create があっても既存の名前は作り直さず PUT する", async () => {
    const r = await ctx.run(["combos", "set", "translate", "oc/good", "--create"]);

    expect(r.code).toBe(0);
    expect(adminCalls(ctx.fake.log)).toEqual([
      "POST /api/auth/login",
      "GET /api/combos",
      "PUT /api/combos/id-tr",
    ]);
  });

  test("段が 0 本なら通信する前に usage エラーで exit 2", async () => {
    const r = await ctx.run(["combos", "set", "translate"]);

    expect(r.code).toBe(2);
    expect(r.err).not.toBe("");
    expect(ctx.fake.log).toEqual([]);
  });
});

describe("combos delete", () => {
  test("名前を ID に解決して削除し、再取得した一覧から消える", async () => {
    const deleted = await ctx.run(["combos", "delete", "shared", "--json"]);
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.out)).toEqual({
      action: "deleted",
      name: "shared",
      models: ["oc/good", "ocg/good"],
    });
    expect(adminCalls(ctx.fake.log)).toEqual([
      "POST /api/auth/login",
      "GET /api/combos",
      "DELETE /api/combos/id-sh",
    ]);
    const list = await ctx.run(["combos", "list", "--json"]);
    expect(JSON.parse(list.out).map((c: { name: string }) => c.name)).not.toContain("shared");
  });

  test("名前が無ければ削除しない", async () => {
    const r = await ctx.run(["combos", "delete", "missing"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(adminCalls(ctx.fake.log)).toEqual(["POST /api/auth/login", "GET /api/combos"]);
  });
});

describe("combos delete が管理 API に拒まれたとき", () => {
  const broken = useFake({ adminErrorStatus: 500 });

  test("exit 1 で、サーバの文言を stderr に出す", async () => {
    const r = await broken.run(["combos", "delete", "shared"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("admin exploded");
    expect(r.out).toBe("");
  });
});

describe("combos set が出す after", () => {
  const stored = useFake({ storedModels: ["stored-a", "stored-b"] });

  test("依頼した段ではなく、サーバが保存したと返した段を出す", async () => {
    const r = await stored.run(["combos", "set", "shared", "asked-x", "asked-y"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("before: oc/good → ocg/good", "after: stored-a → stored-b"));
  });

  test("--json の after も同じ", async () => {
    const r = await stored.run(["combos", "set", "shared", "asked-x", "asked-y", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      action: "updated",
      name: "shared",
      before: ["oc/good", "ocg/good"],
      after: ["stored-a", "stored-b"],
    });
  });

  test("作成時もサーバが保存した段を出す", async () => {
    const r = await stored.run(["combos", "set", "new-combo", "asked-x", "--create", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      action: "created",
      name: "new-combo",
      models: ["stored-a", "stored-b"],
    });
  });
});
