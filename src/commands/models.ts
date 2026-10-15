import {
  adminTimeoutMs,
  API_KEY,
  baseUrl,
  die,
  errorText,
  guard,
  json,
  print,
  send,
  secret,
} from "../lib.ts";

export type ModelsOptions = { prefix: string | undefined; json: boolean };

export const runModels = guard(async (o: ModelsOptions) => {
  const key = secret(API_KEY);
  const res = await send(
    `${baseUrl()}/v1/models`,
    { headers: { Authorization: `Bearer ${key}` } },
    adminTimeoutMs(),
  );
  if (res.status !== 200) die(errorText(res.raw), 2);
  const prefix = o.prefix?.replace(/\/+$/, "");
  const ids = (JSON.parse(res.raw).data as { id: string }[])
    .map((m) => m.id)
    .filter((id) => !prefix || id.startsWith(`${prefix}/`));
  if (o.json) json(ids);
  else for (const id of ids) print(id);
  return 0;
});
