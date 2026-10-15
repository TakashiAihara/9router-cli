import { API_KEY, baseUrl, die, errorText, guard, json, print, secret } from "../lib.ts";

export type ModelsOptions = { prefix: string | undefined; json: boolean };

export const runModels = guard(async (o: ModelsOptions) => {
  const key = secret(API_KEY);
  const res = await fetch(`${baseUrl()}/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const raw = await res.text();
  if (res.status !== 200) die(errorText(raw), 2);
  const ids = (JSON.parse(raw).data as { id: string }[])
    .map((m) => m.id)
    .filter((id) => !o.prefix || id.startsWith(`${o.prefix}/`));
  if (o.json) json(ids);
  else for (const id of ids) print(id);
  return 0;
});
