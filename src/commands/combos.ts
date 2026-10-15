import { admin, ARROW, die, guard, json, login, print } from "../lib.ts";

export type CombosListOptions = { json: boolean };
export type CombosSetOptions = { name: string; models: string[]; create: boolean; json: boolean };
type Combo = { id: string; name: string; models: string[] };
const list = async (c: string) => (await admin(c, "GET", "/api/combos")).combos as Combo[];

export const runCombosList = guard(async (o: CombosListOptions) => {
  const combos = await list(await login());
  if (o.json) json(combos.map(({ id, name, models }) => ({ id, name, models })));
  else for (const c of combos) print(`${c.name}\t${c.models.join(ARROW)}`);
  return 0;
});

export const runCombosSet = guard(async (o: CombosSetOptions) => {
  const cookie = await login();
  const ex = (await list(cookie)).find((c) => c.name === o.name);
  if (ex) {
    const put = await admin(cookie, "PUT", `/api/combos/${encodeURIComponent(ex.id)}`, {
      models: o.models,
    });
    if (o.json) json({ action: "updated", name: o.name, before: ex.models, after: put.models });
    else {
      print(`before: ${ex.models.join(ARROW)}`);
      print(`after: ${put.models.join(ARROW)}`);
    }
  } else if (o.create) {
    await admin(cookie, "POST", "/api/combos", { name: o.name, models: o.models });
    if (o.json) json({ action: "created", name: o.name, models: o.models });
    else print(`created: ${o.name}: ${o.models.join(ARROW)}`);
  } else die(`combo '${o.name}' が無い。新しく作るなら --create を付ける`, 2);
  return 0;
});
