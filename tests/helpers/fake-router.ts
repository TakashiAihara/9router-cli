// 偽の 9router。応答の形は 9router 0.5.91 の実 API から取った。
// providers の応答は実物と違い token を平文で返す (実物は伏せる)。伏せ漏れがあっても CLI が出さないことを見るため。
// 認証: /api/* は login で得た auth_token cookie、/v1/* は Bearer の endpoint key。
// モデルの振る舞いは名前の末尾で撃ち分ける。

export const DASHBOARD_PASSWORD = "dash-pass-r7q";
export const API_KEY = "ep-key-m4x";
export const NONEXISTENT = "__9router_cli_nonexistent__";
export const STATS = {
  totalRequests: 144,
  totalPromptTokens: 1312345,
  totalCompletionTokens: 98765,
  totalCost: 4.32,
  byProvider: { kiro: { requests: 101 }, codex: { requests: 43 } },
};
export const VERSION_INFO = { currentVersion: "0.5.99", latestVersion: "0.6.2", hasUpdate: true };
export const VERSION_INFO_CURRENT = {
  currentVersion: "0.6.2",
  latestVersion: "0.6.2",
  hasUpdate: false,
};

const SESSION_COOKIE = "auth_token=tok-9f2";
const MODEL_IDS = ["free-forever", "ocg/good", "kr/dead", "ocg/sse", "ocgx/foo", "oc/good"];

export type Logged = {
  method: string;
  path: string;
  body: unknown;
  cookie: string | null;
  auth: string | null;
};

export type FakeOptions = {
  // 実在しない ID にも 200 を返す (対照が判別能力を持たない状態)
  leaky?: boolean;
  upToDate?: boolean;
  // 応答を返さないパス (pathname)。時間切れの検査用
  hang?: string[];
  // 認証済みの /api/* が返す status。管理 API のエラーの検査用
  adminErrorStatus?: number;
  versionStatus?: number;
  // GET /api/combos の本文を丸ごと差し替える (形の違う応答の検査用)
  combosReply?: unknown;
  initialCombos?: { id: string; name: string; kind: null; models: string[] }[];
  // PUT /api/combos/:id が、依頼本文に関わらず保存したと返す段
  storedModels?: string[];
  connections?: Record<string, unknown>[];
};

export type Fake = { url: string; log: Logged[]; stop: () => void };

type Chat =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "sse" }
  | { kind: "sse-usage" }
  | { kind: "trailer" }
  | { kind: "garbled" }
  | { kind: "slow" };

const completion = (model: string, content: string) => ({
  model,
  choices: [{ message: { content } }],
});

function chat(model: string, leaky: boolean): Chat {
  if (model.endsWith(NONEXISTENT)) {
    if (leaky) return { kind: "json", status: 200, body: completion("x", "OK") };
    if (model.startsWith("kx/")) {
      return {
        kind: "json",
        status: 401,
        body: { error: { message: "[401]: upstream token expired" } },
      };
    }
    if (model.includes("/")) {
      return {
        kind: "json",
        status: 400,
        body: { error: { message: "[400]: Model is unavailable." } },
      };
    }
    return {
      kind: "json",
      status: 404,
      body: { error: { message: "No active credentials for provider: openai" } },
    };
  }
  if (model.endsWith("/dead")) {
    return { kind: "json", status: 403, body: { error: { message: "[403]: FreeTierError" } } };
  }
  if (model.endsWith("/sse")) return { kind: "sse" };
  if (model.endsWith("/sse-usage")) return { kind: "sse-usage" };
  if (model.endsWith("/trailer")) return { kind: "trailer" };
  if (model.endsWith("/garbled")) return { kind: "garbled" };
  if (model.endsWith("/slow")) return { kind: "slow" };
  if (model.endsWith("/empty")) {
    return { kind: "json", status: 200, body: completion("empty-resolved", "") };
  }
  const resolved = `${model.split("/").pop()}-resolved`;
  if (model.endsWith("/good") || ["free-forever", "translate", "shared"].includes(model)) {
    return { kind: "json", status: 200, body: completion(resolved, "OK") };
  }
  return { kind: "json", status: 404, body: { error: { message: "Model not found" } } };
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const sse = (text: string) =>
  new Response(text, { headers: { "Content-Type": "text/event-stream" } });

export function startFake(options: FakeOptions = {}): Fake {
  const log: Logged[] = [];
  const combos = options.initialCombos ?? [
    { id: "id-ff", name: "free-forever", kind: null, models: ["kr/dead", "oc/good"] },
    { id: "id-tr", name: "translate", kind: null, models: ["ocg/good", "ocg/sse"] },
    { id: "id-sh", name: "shared", kind: null, models: ["oc/good", "ocg/good"] },
  ];
  const conns = options.connections ?? [
    {
      id: "c1",
      provider: "kiro",
      name: "Account 1",
      authType: "oauth",
      isActive: true,
      testStatus: "unavailable",
      errorCode: 403,
      lastError: "[403]: bearer\r\n\tinvalid",
      expiresAt: "2026-10-02T13:55:18.801Z",
      email: "someone@example.com",
      accessToken: "SECRET-ACCESS",
      refreshToken: "SECRET-REFRESH",
      apiKey: "SECRET-APIKEY",
      providerSpecificData: { clientSecret: "SECRET-CLIENT" },
      modelLock_x: "2020-01-01T00:00:00Z",
    },
    {
      id: "c2",
      provider: "codex",
      name: "owner@example.com",
      authType: "oauth",
      isActive: true,
      testStatus: "active",
      modelLock_y: "2999-01-01T00:00:00Z",
      modelLock_z: "garbage",
    },
    {
      id: "c3",
      provider: "openrouter",
      name: "my-or",
      authType: "apikey",
      isActive: false,
      testStatus: "error",
      errorCode: 500,
      lastError: `E${"0123456789".repeat(15)}`,
    },
  ];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const raw = await req.text();
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const cookie = req.headers.get("cookie");
      const auth = req.headers.get("authorization");
      log.push({ method: req.method, path: u.pathname + u.search, body, cookie, auth });

      const p = u.pathname;
      const m = req.method;
      const b = (body ?? {}) as Record<string, unknown>;

      if (options.hang?.includes(p)) await new Promise(() => {});

      if (p === "/api/version" && m === "GET") {
        if (options.versionStatus) {
          return Response.json({ error: "version unavailable" }, { status: options.versionStatus });
        }
        return Response.json(options.upToDate ? VERSION_INFO_CURRENT : VERSION_INFO);
      }
      if (p === "/api/auth/login" && m === "POST") {
        if (b.password === DASHBOARD_PASSWORD) {
          return Response.json(
            { success: true },
            { headers: { "Set-Cookie": `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        return Response.json(
          { error: "Invalid password. 4 attempt(s) left before lockout." },
          { status: 401 },
        );
      }
      if (p.startsWith("/api/")) {
        if (!(cookie ?? "").includes(SESSION_COOKIE)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        if (options.adminErrorStatus) {
          return Response.json({ error: "admin exploded" }, { status: options.adminErrorStatus });
        }
        if (p === "/api/combos" && m === "GET") {
          return Response.json(options.combosReply ?? { combos });
        }
        if (p === "/api/combos" && m === "POST") {
          const c = {
            id: "id-new",
            name: String(b.name),
            kind: null,
            models: b.models as string[],
          };
          combos.push(c);
          return Response.json(c, { status: 201 });
        }
        if (p.startsWith("/api/combos/") && m === "PUT") {
          const id = decodeURIComponent(p.slice("/api/combos/".length));
          const c = combos.find((x) => x.id === id);
          if (!c) return Response.json({ error: "Combo not found" }, { status: 404 });
          Object.assign(c, b, options.storedModels ? { models: options.storedModels } : {});
          return Response.json(c);
        }
        if (p === "/api/providers" && m === "GET") return Response.json({ connections: conns });
        if (p === "/api/providers" && m === "POST") {
          return Response.json(
            {
              connection: {
                id: "c-new",
                provider: b.provider,
                name: b.name ?? b.provider,
                testStatus: "active",
                apiKey: b.apiKey,
              },
            },
            { status: 201 },
          );
        }
        if (p === "/api/usage/stats" && m === "GET") return Response.json(STATS);
        return Response.json({ error: "no route" }, { status: 404 });
      }
      if (p.startsWith("/v1/")) {
        if (auth !== `Bearer ${API_KEY}`) {
          return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
        }
        if (p === "/v1/models") {
          return Response.json({
            object: "list",
            data: MODEL_IDS.map((id) => ({ id, object: "model" })),
          });
        }
        if (p === "/v1/chat/completions") {
          const r = chat(String(b.model), options.leaky === true);
          switch (r.kind) {
            case "json":
              return Response.json(r.body, { status: r.status });
            case "sse":
              return sse(
                frame({ model: "sse-resolved", choices: [{ delta: { content: "O" } }] }) +
                  frame({ model: "sse-resolved", choices: [{ delta: { content: "K" } }] }) +
                  "data: [DONE]\n\n",
              );
            case "sse-usage":
              // usage を載せる実装は、最後に choices が空のフレームを送る
              return sse(
                frame({ model: "u-resolved", choices: [{ delta: { content: "OK" } }] }) +
                  frame({ model: "u-resolved", choices: [], usage: { total_tokens: 3 } }) +
                  "data: [DONE]\n\n",
              );
            case "trailer":
              // 0.5.91 は非 stream の JSON の後ろにも "data: [DONE]" を付けて返す
              return new Response(
                `${JSON.stringify(completion("trailer-resolved", "OK"))}data: [DONE]\n\n`,
                { headers: { "Content-Type": "application/json" } },
              );
            case "garbled":
              return new Response("<html>oops</html>");
            case "slow":
              await Bun.sleep(3000);
              return Response.json(completion("slow-resolved", "OK"));
          }
        }
      }
      return Response.json({ error: "no route" }, { status: 404 });
    },
  });

  return { url: `http://127.0.0.1:${server.port}`, log, stop: () => void server.stop(true) };
}

export const adminCalls = (log: Logged[]) =>
  log.filter((l) => l.path.startsWith("/api/")).map((l) => `${l.method} ${l.path}`);

export const chatModels = (log: Logged[]) =>
  log
    .filter((l) => l.path === "/v1/chat/completions")
    .map((l) => String((l.body as { model: unknown }).model));
