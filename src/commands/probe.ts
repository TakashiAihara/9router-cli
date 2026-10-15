import {
  admin,
  API_KEY,
  baseUrl,
  cell,
  CommError,
  die,
  errorText,
  guard,
  json,
  login,
  NONEXISTENT,
  oneLine,
  print,
  secret,
  send,
} from "../lib.ts";

export type ProbeOptions = {
  models: string[];
  combo: string[];
  allCombos: boolean;
  timeout: number;
  json: boolean;
};

async function call(key: string, model: string, timeout: number) {
  const started = performance.now();
  try {
    const res = await send(
      `${baseUrl()}/v1/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 32,
        }),
      },
      timeout * 1000,
    );
    return { status: res.status as number | null, raw: res.raw, ms: performance.now() - started };
  } catch (e) {
    if (e instanceof CommError && e.timedOut)
      return { status: null, raw: "", ms: performance.now() - started };
    throw e;
  }
}

function parseSuccess(raw: string): [string | null, string] {
  if (raw.startsWith("data:")) {
    let model: string | null = null;
    let text = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") continue;
      const ch = JSON.parse(line.slice(6));
      model = ch.model ?? model;
      // usage を載せる最後のフレームは choices が空
      if (ch.choices?.length) text += ch.choices[0].delta.content ?? "";
    }
    return [model, text];
  }
  // 0.5.91 は非 stream の JSON の後ろにも "data: [DONE]" を付けて返すので、先頭の JSON 値だけを読む
  let depth = 0,
    end = -1,
    inStr = false,
    esc = false;
  const s = raw.trimStart();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) throw new SyntaxError("JSON の終端が無い");
  const obj = JSON.parse(s.slice(0, end));
  return [obj.model ?? null, obj.choices[0].message.content ?? ""];
}

const prefixOf = (m: string) => (m.includes("/") ? m.split("/")[0]! : null);

export const runProbe = guard(async (o: ProbeOptions) => {
  if (!o.models.length && !o.combo.length && !o.allCombos)
    die("probe には model か --combo か --all-combos が要る", 2);
  const key = await secret(API_KEY);
  let targets = [...o.models];
  if (o.combo.length || o.allCombos) {
    const cookie = await login();
    const combos = (await admin(cookie, "GET", "/api/combos")).combos as {
      name: string;
      models: string[];
    }[];
    const picked = o.combo.map(
      (n) => combos.find((c) => c.name === n) ?? die(`combo '${n}' が無い`, 2),
    );
    if (o.allCombos) picked.push(...combos);
    // 段を先に当てる。combo を先に当てると死んだ段がロックされ、続く段の probe が本来の 403 ではなく 503 になる
    for (const c of picked) targets.push(...c.models, c.name);
  }
  targets = [...new Set(targets)];
  if (!targets.length) die("対象が 0 件", 2);
  // 対照は実在しない ID で当てるので、lock されるのはその架空 ID だけ。ただし上流が 401-404 を返すと、接続の testStatus / lastError は対照の結果で上書きされる (providers list は probe の前に読む)
  const controls: { id: string; status: number | null }[] = [];
  for (const prefix of new Set(targets.map(prefixOf))) {
    const id = prefix ? `${prefix}/${NONEXISTENT}` : NONEXISTENT;
    const r = await call(key, id, o.timeout);
    controls.push({ id, status: r.status });
    if (!o.json) print(`CTRL\t${r.status ?? "timeout"}\t${id}`);
    if (r.status === 200) die(`対照 ${id} が 200 を返した = 判別能力が無い`, 2);
    // 上流のエラーは "[401]: ..." の形で素の status のまま返ることがある。9router 自身が endpoint key を拒んだときだけ文言が "[" で始まらない ("Invalid API key"。v0.5.91 の src/sse/handlers/chat.js)
    if (r.status === 401 && !errorText(r.raw).startsWith("["))
      die("endpoint key が拒否された (401)。全部が NG に見えるので本番は当てない", 2);
  }
  const results = [];
  for (const t of targets) {
    const r = await call(key, t, o.timeout);
    // 200 が返っても本文が「サービス終了」の案内のことがある。だが返答の文面で判定すると推論モデルが max_tokens を使い切った空の返答を NG にしてしまうので、判定は HTTP の status で決め、返答の頭を出して人が読む
    let model: string | null = null,
      reply = "",
      verdict = "NG";
    if (r.status === null) reply = "timed out";
    else if (r.status === 200) {
      try {
        [model, reply] = parseSuccess(r.raw);
        verdict = "OK";
      } catch {
        reply = `unreadable: ${r.raw}`;
      }
    } else reply = errorText(r.raw);
    let head = oneLine(reply).slice(0, 120);
    if (!head.trim()) head = "(empty)";
    results.push({
      verdict,
      status: r.status,
      elapsedMs: Math.round(r.ms),
      target: t,
      model,
      reply: head,
    });
    if (!o.json)
      print(
        `${verdict}\t${r.status ?? "timeout"}\t${(r.ms / 1000).toFixed(1)}s\t${t}\t${cell(model)}\t${head}`,
      );
  }
  const ok = results.filter((x) => x.verdict === "OK").length;
  const ng = results.length - ok;
  if (o.json) json({ controls, results, ok, ng });
  else print(`ok=${ok} ng=${ng} controls=${controls.length}`);
  return ng ? 1 : 0;
});
