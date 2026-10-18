import { describe, expect, test } from "bun:test";
import { normalizeElapsed, tsv, useFake } from "./helpers/cli.ts";
import { adminCalls, API_KEY, chatModels, NONEXISTENT, startFake } from "./helpers/fake-router.ts";

const ctx = useFake();

const ctrl = (prefix: string | null) => (prefix ? `${prefix}/${NONEXISTENT}` : NONEXISTENT);

describe("probe", () => {
  test("200 は OK、それ以外は NG で exit 1。対照を先に接頭辞ごとに 1 回ずつ当て、最後に件数", async () => {
    const r = await ctx.run(["probe", "ocg/good", "kr/dead", "ocg/sse"]);

    expect(r.code).toBe(1);
    expect(normalizeElapsed(r.out)).toBe(
      tsv(
        `CTRL\t400\t${ctrl("ocg")}`,
        `CTRL\t400\t${ctrl("kr")}`,
        "OK\t200\t<t>\tocg/good\tgood-resolved\tOK",
        "NG\t403\t<t>\tkr/dead\t-\t[403]: FreeTierError",
        "OK\t200\t<t>\tocg/sse\tsse-resolved\tOK",
        "ok=2 ng=1 controls=2",
      ),
    );
    expect(chatModels(ctx.fake.log)).toEqual([
      ctrl("ocg"),
      ctrl("kr"),
      "ocg/good",
      "kr/dead",
      "ocg/sse",
    ]);
  });

  test("endpoint key だけで動き、chat には固定の依頼本文を Bearer で送る。管理 API は叩かない", async () => {
    const r = await ctx.run(["probe", "ocg/good"], { NINE_ROUTER_DASHBOARD_PASSWORD: undefined });

    expect(r.code).toBe(0);
    expect(adminCalls(ctx.fake.log)).toEqual([]);
    const call = ctx.fake.log.find((l) => (l.body as { model?: string }).model === "ocg/good");
    expect(call?.method).toBe("POST");
    expect(call?.auth).toBe(`Bearer ${API_KEY}`);
    expect(call?.body).toEqual({
      model: "ocg/good",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 32,
    });
  });

  test("応答の形ごとに読める: 非 stream JSON の後ろの [DONE] / 空の usage フレーム / 空本文", async () => {
    const r = await ctx.run(["probe", "ocg/trailer", "ocg/sse-usage", "ocg/empty"]);

    expect(r.code).toBe(0);
    expect(normalizeElapsed(r.out)).toBe(
      tsv(
        `CTRL\t400\t${ctrl("ocg")}`,
        "OK\t200\t<t>\tocg/trailer\ttrailer-resolved\tOK",
        "OK\t200\t<t>\tocg/sse-usage\tu-resolved\tOK",
        "OK\t200\t<t>\tocg/empty\tempty-resolved\t(empty)",
        "ok=3 ng=0 controls=1",
      ),
    );
  });

  test("200 でも本文が読めなければ NG にして、本文の頭を出す", async () => {
    const r = await ctx.run(["probe", "ocg/garbled", "ocg/good"]);

    expect(r.code).toBe(1);
    expect(normalizeElapsed(r.out)).toBe(
      tsv(
        `CTRL\t400\t${ctrl("ocg")}`,
        "NG\t200\t<t>\tocg/garbled\t-\tunreadable: <html>oops</html>",
        "OK\t200\t<t>\tocg/good\tgood-resolved\tOK",
        "ok=1 ng=1 controls=1",
      ),
    );
  });

  test("時間切れは NG (timeout) にして続ける", async () => {
    const r = await ctx.run(["probe", "ocg/slow", "ocg/good", "--timeout", "1"]);

    expect(r.code).toBe(1);
    expect(normalizeElapsed(r.out)).toBe(
      tsv(
        `CTRL\t400\t${ctrl("ocg")}`,
        "NG\ttimeout\t<t>\tocg/slow\t-\ttimed out",
        "OK\t200\t<t>\tocg/good\tgood-resolved\tOK",
        "ok=1 ng=1 controls=1",
      ),
    );
  });

  test("上流の 401 ([401]: ...) が素で返る対照では止めない", async () => {
    const r = await ctx.run(["probe", "kx/good", "ocg/good"]);

    expect(r.code).toBe(0);
    expect(normalizeElapsed(r.out)).toBe(
      tsv(
        `CTRL\t401\t${ctrl("kx")}`,
        `CTRL\t400\t${ctrl("ocg")}`,
        "OK\t200\t<t>\tkx/good\tgood-resolved\tOK",
        "OK\t200\t<t>\tocg/good\tgood-resolved\tOK",
        "ok=2 ng=0 controls=2",
      ),
    );
  });

  test("対照が 9router 自身の 401 なら鍵の誤りとして本番を当てずに exit 2", async () => {
    const r = await ctx.run(["probe", "ocg/good", "kr/dead"], { NINE_ROUTER_API_KEY: "wrong-key" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("endpoint key");
    expect(r.err).toContain("401");
    expect(r.out).toBe(`CTRL\t401\t${ctrl("ocg")}\n`);
    expect(chatModels(ctx.fake.log)).toEqual([ctrl("ocg")]);
  });

  test("モデルも combo も無ければ通信する前に usage エラーで exit 2", async () => {
    const r = await ctx.run(["probe"]);

    expect(r.code).toBe(2);
    expect(r.err).not.toBe("");
    expect(ctx.fake.log).toEqual([]);
  });

  test("--json は controls / results / ok / ng を 1 つの JSON で返し、NG があれば exit 1", async () => {
    const r = await ctx.run(["probe", "ocg/good", "kr/dead", "ocg/sse", "--json"]);

    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      controls: [
        { id: ctrl("ocg"), status: 400 },
        { id: ctrl("kr"), status: 400 },
      ],
      results: [
        {
          verdict: "OK",
          status: 200,
          elapsedMs: expect.any(Number),
          target: "ocg/good",
          model: "good-resolved",
          reply: "OK",
        },
        {
          verdict: "NG",
          status: 403,
          elapsedMs: expect.any(Number),
          target: "kr/dead",
          model: null,
          reply: "[403]: FreeTierError",
        },
        {
          verdict: "OK",
          status: 200,
          elapsedMs: expect.any(Number),
          target: "ocg/sse",
          model: "sse-resolved",
          reply: "OK",
        },
      ],
      ok: 2,
      ng: 1,
    });
  });

  test("--json の時間切れは status が null", async () => {
    const r = await ctx.run(["probe", "ocg/slow", "--timeout", "1", "--json"]);

    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).results).toEqual([
      {
        verdict: "NG",
        status: null,
        elapsedMs: expect.any(Number),
        target: "ocg/slow",
        model: null,
        reply: "timed out",
      },
    ]);
  });
});

describe("probe --combo / --all-combos", () => {
  test("--combo は各段を先に当ててから combo 自身を当てる。接頭辞の無い名前にも対照を当てる", async () => {
    const r = await ctx.run(["probe", "--combo", "my-combo"]);

    expect(r.code).toBe(1);
    expect(normalizeElapsed(r.out)).toBe(
      tsv(
        `CTRL\t400\t${ctrl("kr")}`,
        `CTRL\t400\t${ctrl("oc")}`,
        `CTRL\t404\t${ctrl(null)}`,
        "NG\t403\t<t>\tkr/dead\t-\t[403]: FreeTierError",
        "OK\t200\t<t>\toc/good\tgood-resolved\tOK",
        "OK\t200\t<t>\tmy-combo\tmy-combo-resolved\tOK",
        "ok=2 ng=1 controls=3",
      ),
    );
    expect(chatModels(ctx.fake.log)).toEqual([
      ctrl("kr"),
      ctrl("oc"),
      ctrl(null),
      "kr/dead",
      "oc/good",
      "my-combo",
    ]);
    expect(adminCalls(ctx.fake.log)).toEqual(["POST /api/auth/login", "GET /api/combos"]);
  });

  test("--all-combos は全 combo と全段を 1 回ずつ、段を combo より先に当てる", async () => {
    const r = await ctx.run(["probe", "--all-combos"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("ok=6 ng=1 controls=4\n");
    expect(chatModels(ctx.fake.log)).toEqual([
      ctrl("kr"),
      ctrl("oc"),
      ctrl(null),
      ctrl("ocg"),
      "kr/dead",
      "oc/good",
      "my-combo",
      "ocg/good",
      "ocg/sse",
      "translate",
      "shared",
    ]);
  });

  test("モデル引数 / --combo / --all-combos で重なった対象は、最初に現れた位置で 1 回だけ当てる", async () => {
    const r = await ctx.run(["probe", "ocg/sse", "--combo", "shared", "--all-combos"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("ok=6 ng=1 controls=4\n");
    expect(chatModels(ctx.fake.log)).toEqual([
      ctrl("ocg"),
      ctrl("oc"),
      ctrl(null),
      ctrl("kr"),
      "ocg/sse",
      "oc/good",
      "ocg/good",
      "shared",
      "kr/dead",
      "my-combo",
      "translate",
    ]);
  });

  test("無い combo 名は何も当てずに exit 2", async () => {
    const r = await ctx.run(["probe", "--combo", "nope-combo"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("nope-combo");
    expect(chatModels(ctx.fake.log)).toEqual([]);
    expect(adminCalls(ctx.fake.log)).toEqual(["POST /api/auth/login", "GET /api/combos"]);
  });
});

describe("probe の対照が判別能力を持たないとき", () => {
  const leaky = useFake({ leaky: true });

  test("実在しない ID に 200 が返ったら本番を当てずに exit 2", async () => {
    const r = await leaky.run(["probe", "ocg/good"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain(ctrl("ocg"));
    expect(r.err).toContain("200");
    expect(r.out).toBe(`CTRL\t200\t${ctrl("ocg")}\n`);
    expect(chatModels(leaky.fake.log)).toEqual([ctrl("ocg")]);
  });
});

describe("probe の --timeout", () => {
  for (const bad of ["abc", "-1", "0", "Infinity"]) {
    test(`${bad} は使い方の誤りとして通信する前に exit 2`, async () => {
      const r = await ctx.run(["probe", "ocg/good", "--timeout", bad]);

      expect(r.code).toBe(2);
      expect(r.err).toContain("--timeout");
      expect(r.err).not.toContain("通信に失敗");
      expect(ctx.fake.log).toEqual([]);
    });
  }
});

describe("probe の対象が 0 件のとき", () => {
  const empty = useFake({ initialCombos: [] });

  test("--all-combos で combo が 0 本なら何も当てずに exit 2", async () => {
    const r = await empty.run(["probe", "--all-combos"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("0 件");
    expect(r.out).toBe("");
    expect(chatModels(empty.fake.log)).toEqual([]);
  });
});

describe("probe がつながらない接続先に当たったとき", () => {
  test("時間切れの NG にせず、通信の誤りとして exit 2", async () => {
    const dead = startFake();
    const url = dead.url;
    dead.stop();

    const r = await ctx.run(["probe", "ocg/good"], { NINE_ROUTER_URL: url });

    expect(r.code).toBe(2);
    expect(r.err).toContain("通信に失敗");
    expect(r.out).toBe("");
  });
});
