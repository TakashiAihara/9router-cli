import { adminTimeoutMs, baseUrl, cell, die, errorText, guard, json, print, send } from "../lib.ts";

export type VersionOptions = { json: boolean };

export const runVersion = guard(async (o: VersionOptions) => {
  const res = await send(`${baseUrl()}/api/version`, {}, adminTimeoutMs());
  if (!res.ok) die(errorText(res.raw), 1);
  const v = JSON.parse(res.raw);
  if (o.json) json(v);
  else print([v.currentVersion, v.latestVersion, v.hasUpdate].map(cell).join("\t"));
  return 0;
});
