import { describe, expect, test } from "bun:test";
import { useFake, tsv } from "./helpers/cli.ts";
import { API_KEY } from "./helpers/fake-router.ts";

const ctx = useFake();

describe("models", () => {
  test("--prefix で絞った ID をサーバの順に出す (ocgx/ は ocg/ に含めない)", async () => {
    const r = await ctx.run(["models", "--prefix", "ocg"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("ocg/good", "ocg/sse"));
    expect(r.err).toBe("");
  });

  test("endpoint key だけで動く。dashboard の login も password も要らない", async () => {
    const r = await ctx.run(["models"], { NINE_ROUTER_DASHBOARD_PASSWORD: undefined });

    expect(r.code).toBe(0);
    expect(r.out).toBe(
      tsv("free-forever", "ocg/good", "kr/dead", "ocg/sse", "ocgx/foo", "oc/good"),
    );
    expect(ctx.fake.log).toHaveLength(1);
    expect(ctx.fake.log[0]?.method).toBe("GET");
    expect(ctx.fake.log[0]?.path).toBe("/v1/models");
    expect(ctx.fake.log[0]?.auth).toBe(`Bearer ${API_KEY}`);
  });

  test("--json は ID の配列", async () => {
    const r = await ctx.run(["models", "--prefix", "oc", "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(["oc/good"]);
  });

  test("endpoint key が拒否されたら exit 2 で、サーバの文言を stderr に出す", async () => {
    const r = await ctx.run(["models"], { NINE_ROUTER_API_KEY: "wrong-key" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("Invalid API key");
    expect(r.out).toBe("");
  });
});
