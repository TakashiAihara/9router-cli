import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as lib from "../src/lib.ts";
import {
  runCli,
  tsv,
  useFake,
  writeConfig,
  writeLeakCheckScript,
  writeSecretScript,
} from "./helpers/cli.ts";
import { adminCalls, API_KEY, DASHBOARD_PASSWORD, startFake } from "./helpers/fake-router.ts";

const COMBOS_LIST = tsv(
  "free-forever\tkr/dead → oc/good",
  "translate\tocg/good → ocg/sse",
  "shared\toc/good → ocg/good",
);

const ctx = useFake();

// env に秘密を渡さず、設定の *_command で取らせる
function commandConfig(url: string) {
  const { script, log } = writeSecretScript(ctx.sb);
  const toml = `url = "${url}"
api_key_command = "${script} key"
dashboard_password_command = "${script} pw"
`;
  writeConfig(ctx.sb, toml);
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { calls };
}

const bare = (args: string[], env: Record<string, string | undefined> = {}) =>
  runCli(ctx.sb, args, env);

describe("秘密が env に無いとき", () => {
  test("設定の dashboard_password_command だけを 1 回走らせて login できる", async () => {
    const { calls } = commandConfig(ctx.fake.url);

    const r = await bare(["combos", "list"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(COMBOS_LIST);
    expect(calls()).toEqual(["pw"]);
  });

  test("models は api_key_command だけを走らせる", async () => {
    const { calls } = commandConfig(ctx.fake.url);

    const r = await bare(["models", "--prefix", "oc"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("oc/good"));
    expect(calls()).toEqual(["key"]);
  });

  test("probe --combo は要る 2 本をそれぞれ 1 回ずつ取る", async () => {
    const { calls } = commandConfig(ctx.fake.url);

    const r = await bare(["probe", "--combo", "shared"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("ok=3 ng=0 controls=3\n");
    expect(calls().sort()).toEqual(["key", "pw"]);
  });

  test("取った値を stdout にも stderr にも出さない", async () => {
    commandConfig(ctx.fake.url);

    const r = await bare(["combos", "list"]);

    expect(r.out).toBe(COMBOS_LIST);
    for (const secret of [DASHBOARD_PASSWORD, API_KEY]) {
      expect(r.out).not.toContain(secret);
      expect(r.err).not.toContain(secret);
    }
  });

  test("env に値があれば command を走らせない", async () => {
    const { calls } = commandConfig(ctx.fake.url);

    const r = await bare(["combos", "list"], {
      NINE_ROUTER_DASHBOARD_PASSWORD: DASHBOARD_PASSWORD,
    });

    expect(r.code).toBe(0);
    expect(calls()).toEqual([]);
  });

  test("command が失敗したら 1 回で exit 2。失敗時の出力を秘密として使わず、示すのは変数名", async () => {
    const { calls } = commandConfig(ctx.fake.url);

    const r = await bare(["combos", "list"], { CMD_FAIL: "1" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("NINE_ROUTER_DASHBOARD_PASSWORD");
    expect(r.out).toBe("");
    expect(r.err).not.toContain("machine identity");
    expect(calls()).toEqual(["pw"]);
    expect(adminCalls(ctx.fake.log)).toEqual([]);
  });

  test("改行を含む値は秘密として使わず exit 2 (前置きの通知行を鍵にしない)", async () => {
    const { calls } = commandConfig(ctx.fake.url);

    const r = await bare(["combos", "list"], { CMD_NL: "1" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("NINE_ROUTER_DASHBOARD_PASSWORD");
    expect(r.out).toBe("");
    expect(r.err).not.toContain(DASHBOARD_PASSWORD);
    expect(calls()).toEqual(["pw"]);
    expect(adminCalls(ctx.fake.log)).toEqual([]);
  });

  test("末尾の CRLF は 1 つ落として使う", async () => {
    commandConfig(ctx.fake.url);

    const r = await bare(["models"], { CMD_CR: "1" });

    expect(r.code).toBe(0);
    expect(r.out).toBe(
      tsv("free-forever", "ocg/good", "kr/dead", "ocg/sse", "ocgx/foo", "oc/good"),
    );
    expect(ctx.fake.log[0]?.auth).toBe(`Bearer ${API_KEY}`);
  });

  test("途中に CR を含む値は使わず exit 2", async () => {
    commandConfig(ctx.fake.url);

    const r = await bare(["models"], { CMD_CR_MID: "1" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("NINE_ROUTER_API_KEY");
    expect(ctx.fake.log).toEqual([]);
  });

  test("command の stderr の末尾 1 行を理由として添える。それ以前の行と stdout は出さない", async () => {
    commandConfig(ctx.fake.url);

    const r = await bare(["models"], { CMD_STDERR: "1" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("NINE_ROUTER_API_KEY");
    expect(r.err).toContain("identity endpoint returned 503");
    expect(r.err).not.toContain("first stderr line");
    expect(ctx.fake.log).toEqual([]);
  });

  test("command が時間内に返らなければ exit 2 で、変数名と秒数を示す", async () => {
    commandConfig(ctx.fake.url);

    const r = await bare(["combos", "list"], {
      CMD_SLEEP: "5",
      NINE_ROUTER_COMMAND_TIMEOUT: "0.5",
    });

    expect(r.code).toBe(2);
    expect(r.err).toContain("NINE_ROUTER_DASHBOARD_PASSWORD");
    expect(r.err).toContain("0.5 秒");
    expect(adminCalls(ctx.fake.log)).toEqual([]);
  });

  test("先に取った秘密を、次の command の子の env に渡さない", async () => {
    const { script, log } = writeLeakCheckScript(ctx.sb);
    writeConfig(
      ctx.sb,
      `url = "${ctx.fake.url}"
api_key_command = "${script} key"
dashboard_password_command = "${script} pw"
`,
    );

    const r = await bare(["probe", "--combo", "shared"]);

    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean).sort()).toEqual([
      "key clean",
      "pw clean",
    ]);
  });

  test("command が何も出さなければ exit 2", async () => {
    commandConfig(ctx.fake.url);

    const r = await bare(["models"], { CMD_EMPTY: "1" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("NINE_ROUTER_API_KEY");
    expect(ctx.fake.log).toEqual([]);
  });

  test("env も設定も無ければ exit 2 で、足りない変数名を示す", async () => {
    writeConfig(ctx.sb, `url = "${ctx.fake.url}"\n`);

    const r = await bare(["combos", "list"]);

    expect(r.code).toBe(2);
    expect(r.err).toContain("NINE_ROUTER_DASHBOARD_PASSWORD");
    expect(r.out).toBe("");
    expect(ctx.fake.log).toEqual([]);
  });
});

describe("接続先と設定ファイル", () => {
  test("url が env にも設定にも無ければ exit 2 (既定の接続先を持たない)", async () => {
    const r = await bare(["models"], { NINE_ROUTER_API_KEY: API_KEY });

    expect(r.code).toBe(2);
    expect(r.err).toContain("NINE_ROUTER_URL");
    expect(r.out).toBe("");
  });

  test("設定の url を使う", async () => {
    writeConfig(ctx.sb, `url = "${ctx.fake.url}"\n`);

    const r = await bare(["models", "--prefix", "kr"], { NINE_ROUTER_API_KEY: API_KEY });

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("kr/dead"));
  });

  test("env の NINE_ROUTER_URL は設定の url に勝つ", async () => {
    writeConfig(ctx.sb, 'url = "http://127.0.0.1:1"\n');

    const r = await ctx.run(["models", "--prefix", "kr"]);

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("kr/dead"));
  });

  test("url の末尾の / は落とす", async () => {
    const r = await ctx.run(["combos", "list"], { NINE_ROUTER_URL: `${ctx.fake.url}/` });

    expect(r.code).toBe(0);
    expect(adminCalls(ctx.fake.log)).toEqual(["POST /api/auth/login", "GET /api/combos"]);
  });

  test("XDG_CONFIG_HOME が無ければ ~/.config/9router-cli/config.toml を読む", async () => {
    writeConfig(ctx.sb, `url = "${ctx.fake.url}"\n`, { xdg: false });

    const r = await runCli(
      ctx.sb,
      ["models", "--prefix", "kr"],
      { NINE_ROUTER_API_KEY: API_KEY },
      { xdg: false },
    );

    expect(r.code).toBe(0);
    expect(r.out).toBe(tsv("kr/dead"));
  });

  test("設定ファイルが TOML として読めなければ exit 2 で、ファイル名を示す", async () => {
    writeConfig(ctx.sb, 'url = "unterminated\n');

    // url を env で渡すと設定を読む必要が無くなるので、設定から読ませる
    const r = await ctx.run(["models"], { NINE_ROUTER_URL: undefined });

    expect(r.code).toBe(2);
    expect(r.err).toContain("config.toml");
    expect(r.out).toBe("");
  });

  test("url の末尾の / を落とす (偽サーバは // を正規化するので、関数を直接見る)", () => {
    const saved = process.env.NINE_ROUTER_URL;
    process.env.NINE_ROUTER_URL = "http://router.test:8080///";
    try {
      expect(lib.baseUrl()).toBe("http://router.test:8080");
    } finally {
      if (saved === undefined) delete process.env.NINE_ROUTER_URL;
      else process.env.NINE_ROUTER_URL = saved;
    }
  });

  test("url に scheme が無ければ通信せず exit 2", async () => {
    const r = await ctx.run(["version"], { NINE_ROUTER_URL: "router.test:8080" });

    expect(r.code).toBe(2);
    expect(r.err).toContain("http://");
    expect(r.err).not.toContain("通信に失敗");
    expect(r.out).toBe("");
  });

  test("設定の url が文字列でなければ exit 2 で、キー名を示す", async () => {
    writeConfig(ctx.sb, "url = 5\n");

    const r = await ctx.run(["models"], { NINE_ROUTER_URL: undefined });

    expect(r.code).toBe(2);
    expect(r.err).toContain("url");
    expect(r.err).toContain("文字列");
    expect(r.err).not.toContain("通信に失敗");
    expect(r.out).toBe("");
  });

  for (const key of ["api_key_command", "dashboard_password_command"]) {
    test(`設定の ${key} が文字列でなければ exit 2 で、キー名を示す`, async () => {
      writeConfig(ctx.sb, `url = "${ctx.fake.url}"\n${key} = 7\n`);

      const r = await bare(["models"]);

      expect(r.code).toBe(2);
      expect(r.err).toContain(key);
      expect(r.err).toContain("文字列");
      expect(r.err).not.toContain("通信に失敗");
      expect(ctx.fake.log).toEqual([]);
    });
  }

  test("つながらない接続先は exit 2", async () => {
    const dead = startFake();
    const url = dead.url;
    dead.stop();

    const r = await ctx.run(["combos", "list"], { NINE_ROUTER_URL: url });

    expect(r.code).toBe(2);
    expect(r.err).not.toBe("");
    expect(r.out).toBe("");
  });
});

describe("json の失敗", () => {
  test("--json でも失敗は stderr に出し、stdout は空", async () => {
    const r = await ctx.run(["combos", "list", "--json"], {
      NINE_ROUTER_DASHBOARD_PASSWORD: "wrong-pass",
    });

    expect(r.code).toBe(2);
    expect(r.err).toContain("Invalid password");
    expect(r.out).toBe("");
  });
});
