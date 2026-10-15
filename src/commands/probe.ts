import {
  admin,
  API_KEY,
  baseUrl,
  cell,
  die,
  errorText,
  guard,
  json,
  login,
  NONEXISTENT,
  oneLine,
  PASSWORD,
  print,
  secret,
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
    const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(timeout * 1000),
    });
    return {
      status: res.status as number | null,
      raw: await res.text(),
      ms: performance.now() - started,
    };
  } catch (e) {
    if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError")
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
      if (ch.choices?.length) text += ch.choices[0].delta.content ?? "";
    }
    return [model, text];
  }
  // 先頭の JSON 値だけを読む
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
  const obj = JSON.parse(s.slice(0, end));
  return [obj.model ?? null, obj.choices[0].message.content ?? ""];
}

const prefixOf = (m: string) => (m.includes("/") ? m.split("/")[0]! : null);

export const runProbe = guard(async (o: ProbeOptions) => {
  if (!o.models.length && !o.combo.length && !o.allCombos)
    die("probe には model か --combo か --all-combos が要る", 2);
  const key = secret(API_KEY);
  let targets = [...o.models];
  if (o.combo.length || o.allCombos) {
    secret(PASSWORD);
    const cookie = await login();
    const combos = (await admin(cookie, "GET", "/api/combos")).combos as {
      name: string;
      models: string[];
    }[];
    const picked = o.combo.map(
      (n) => combos.find((c) => c.name === n) ?? die(`combo '${n}' が無い`, 2),
    );
    if (o.allCombos) picked.push(...combos);
    for (const c of picked) targets.push(...c.models, c.name);
  }
  targets = [...new Set(targets)];
  const controls: { id: string; status: number | null }[] = [];
  for (const prefix of new Set(targets.map(prefixOf))) {
    const id = prefix ? `${prefix}/${NONEXISTENT}` : NONEXISTENT;
    const r = await call(key, id, o.timeout);
    controls.push({ id, status: r.status });
    if (!o.json) print(`CTRL\t${r.status ?? "timeout"}\t${id}`);
    if (r.status === 200) die(`対照 ${id} が 200 を返した = 判別能力が無い`, 2);
    if (r.status === 401 && !errorText(r.raw).startsWith("["))
      die("endpoint key が拒否された (401)。全部が NG に見えるので本番は当てない", 2);
  }
  const results = [];
  for (const t of targets) {
    const r = await call(key, t, o.timeout);
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
