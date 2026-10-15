import { adminTimeoutMs, baseUrl, cell, die, errorText, guard, json, print, send } from "../lib.ts";

export type VersionOptions = { json: boolean };

export const runVersion = guard(async (o: VersionOptions) => {
  const res = await send(`${baseUrl()}/api/version`, {}, adminTimeoutMs());
  if (!res.ok) die(errorText(res.raw), 1);
  const v = JSON.parse(res.raw);
  // --json は API の応答をそのまま返す。null のままでも「null だった」ことは分かる
  if (o.json) json(v);
  // upstream が npm に届かないと latestVersion が null で hasUpdate も false になり、「最新」と読めてしまう。
  // 確認できなかったことは unknown で示す (null / 空 / キー無し)
  else print([v.currentVersion, v.latestVersion || "unknown", v.hasUpdate].map(cell).join("\t"));
  return 0;
});
