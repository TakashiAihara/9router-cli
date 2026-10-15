import { baseUrl, cell, errorText, die, guard, json, print } from "../lib.ts";

export type VersionOptions = { json: boolean };

export const runVersion = guard(async (o: VersionOptions) => {
  const res = await fetch(`${baseUrl()}/api/version`);
  const raw = await res.text();
  if (!res.ok) die(errorText(raw), 1);
  const v = JSON.parse(raw);
  if (o.json) json(v);
  else print([v.currentVersion, v.latestVersion, v.hasUpdate].map(cell).join("\t"));
  return 0;
});
