import { admin, cell, die, guard, json, login, oneLine, print } from "../lib.ts";

export type ProvidersListOptions = { json: boolean };
export type ProvidersAddOptions = {
  provider: string;
  keyEnv: string;
  name: string | undefined;
  json: boolean;
};
export type ProvidersSetOptions = {
  id: string;
  name?: string;
  priority?: number;
  active?: boolean;
  keyEnv?: string;
  json: boolean;
};
export type ProvidersIdOptions = { id: string; json: boolean };

// タイムゾーンの無い時刻は UTC として読む (Date.parse は host の local time で読む)。区切りは移植元の fromisoformat に合わせ T と空白の両方
const asUtc = (v: string) =>
  /^\d{4}-\d\d-\d\d[T ][\d:.]+$/.test(v) ? `${v.replace(" ", "T")}Z` : v;

const locks = (c: Record<string, unknown>) =>
  Object.entries(c).filter(
    ([k, v]) => k.startsWith("modelLock_") && v && Date.parse(asUtc(String(v))) > Date.now(),
  ).length;

const publicName = (name: unknown) =>
  typeof name === "string" && name.includes("@") ? null : (name ?? null);

export const runProvidersList = guard(async (o: ProvidersListOptions) => {
  const cookie = await login();
  const conns = (await admin(cookie, "GET", "/api/providers")).connections as Record<string, any>[];
  const rows = conns.map((c) => ({
    id: c.id ?? null,
    provider: c.provider ?? null,
    name: publicName(c.name),
    authType: c.authType ?? null,
    isActive: c.isActive ?? null,
    testStatus: c.testStatus ?? null,
    errorCode: c.errorCode ?? null,
    lastError: c.lastError == null ? null : oneLine(String(c.lastError)).slice(0, 120),
    expiresAt: c.expiresAt ?? null,
    locks: locks(c),
  }));
  if (o.json) json(rows);
  else
    for (const r of rows) {
      print(
        [
          r.id,
          r.provider,
          r.name,
          r.authType,
          r.isActive,
          r.testStatus,
          r.errorCode,
          r.lastError,
          r.expiresAt,
          `locks=${r.locks}`,
        ]
          .map(cell)
          .join("\t"),
      );
    }
  return 0;
});

export const runProvidersSet = guard(async (o: ProvidersSetOptions) => {
  const payload: Record<string, unknown> = {};
  // 空文字は「名前を消したい」ではなく、未束縛の変数か取り違えと見て止める
  if (o.name !== undefined) {
    if (!o.name.trim()) die("--name は空にしない", 2);
    payload.name = o.name;
  }
  if (o.priority !== undefined) payload.priority = o.priority;
  if (o.active !== undefined) payload.isActive = o.active;
  if (o.keyEnv !== undefined) {
    if (!o.keyEnv.trim()) die("--key-env に環境変数名を指定する", 2);
    const key = process.env[o.keyEnv];
    if (!key) die(`${o.keyEnv} が空`, 2);
    payload.apiKey = key;
  }
  if (!Object.keys(payload).length) die("更新する項目を指定する", 2);
  const cookie = await login();
  const path = `/api/providers/${encodeURIComponent(o.id)}`;
  if (o.keyEnv !== undefined) {
    // 0.5.91 の PUT は authType が apikey のときだけ apiKey を反映し、他では 200 で黙って捨てる。
    // 送ると成功に見えて黙るだけなので、型を見るまで書かない
    const current = (await admin(cookie, "GET", path)).connection;
    if (current.authType !== "apikey")
      die(
        `接続 ${o.id} は ${cell(current.authType)} 型。API key の更新は apikey 型の接続だけにできる。` +
          "他の項目も書かずに止めたので、--key-env を外せば編集できる",
        2,
      );
  }
  const c = (await admin(cookie, "PUT", path, payload)).connection;
  const row = {
    id: c.id,
    provider: c.provider,
    name: publicName(c.name),
    isActive: c.isActive,
    priority: c.priority,
  };
  if (o.json) json(row);
  else print(Object.values(row).map(cell).join("\t"));
  return 0;
});

export const runProvidersDelete = guard(async (o: ProvidersIdOptions) => {
  await admin(await login(), "DELETE", `/api/providers/${encodeURIComponent(o.id)}`);
  if (o.json) json({ action: "deleted", id: o.id });
  else print(`deleted: ${o.id}`);
  return 0;
});

export const runProvidersTest = guard(async (o: ProvidersIdOptions) => {
  const result = await admin(
    await login(),
    "POST",
    `/api/providers/${encodeURIComponent(o.id)}/test`,
  );
  const row = {
    id: o.id,
    valid: result.valid === true,
    // 上流の本文をそのまま返すので、次の行へ送られないよう 1 行にする
    error: result.error == null ? null : oneLine(String(result.error)).slice(0, 120),
    refreshed: result.refreshed === true,
  };
  if (o.json) json(row);
  else print([row.id, row.valid ? "OK" : "NG", row.error, row.refreshed].map(cell).join("\t"));
  return row.valid ? 0 : 1;
});

export const runProvidersAdd = guard(async (o: ProvidersAddOptions) => {
  const key = process.env[o.keyEnv];
  if (!key) die(`${o.keyEnv} が空`, 2);
  const cookie = await login();
  const payload: Record<string, unknown> = { provider: o.provider, apiKey: key };
  if (o.name) payload.name = o.name;
  const obj = await admin(cookie, "POST", "/api/providers", payload);
  const c = obj.connection;
  const row = {
    id: c.id,
    provider: c.provider,
    name: publicName(c.name),
    testStatus: c.testStatus,
  };
  if (o.json) json(row);
  else print(Object.values(row).map(cell).join("\t"));
  return 0;
});
