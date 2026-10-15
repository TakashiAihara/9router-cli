import { admin, cell, die, guard, json, login, oneLine, print } from "../lib.ts";

export type ProvidersListOptions = { json: boolean };
export type ProvidersAddOptions = {
  provider: string;
  keyEnv: string;
  name: string | undefined;
  json: boolean;
};

const locks = (c: Record<string, unknown>) =>
  Object.entries(c).filter(([k, v]) => {
    if (!k.startsWith("modelLock_") || !v) return false;
    const t = Date.parse(String(v));
    return !Number.isNaN(t) && t > Date.now();
  }).length;

export const runProvidersList = guard(async (o: ProvidersListOptions) => {
  const cookie = await login();
  const conns = (await admin(cookie, "GET", "/api/providers")).connections as Record<string, any>[];
  const rows = conns.map((c) => ({
    provider: c.provider ?? null,
    name: typeof c.name === "string" && c.name.includes("@") ? null : (c.name ?? null),
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

export const runProvidersAdd = guard(async (o: ProvidersAddOptions) => {
  const key = process.env[o.keyEnv];
  if (!key) die(`${o.keyEnv} が空`, 2);
  const cookie = await login();
  const payload: Record<string, unknown> = { provider: o.provider, apiKey: key };
  if (o.name) payload.name = o.name;
  const obj = await admin(cookie, "POST", "/api/providers", payload);
  const c = obj.connection ?? obj;
  if (o.json) json({ id: c.id, provider: c.provider, name: c.name, testStatus: c.testStatus });
  else print(["id", "provider", "name", "testStatus"].map((k) => cell(c[k])).join("\t"));
  return 0;
});
