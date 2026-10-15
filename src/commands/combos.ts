export type CombosListOptions = { json: boolean };
export type CombosSetOptions = { name: string; models: string[]; create: boolean; json: boolean };

export async function runCombosList(_opts: CombosListOptions): Promise<number> {
  throw new Error("not implemented");
}

export async function runCombosSet(_opts: CombosSetOptions): Promise<number> {
  throw new Error("not implemented");
}
