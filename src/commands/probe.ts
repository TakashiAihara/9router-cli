export type ProbeOptions = {
  models: string[];
  combo: string[];
  allCombos: boolean;
  timeout: number;
  json: boolean;
};

export async function runProbe(_opts: ProbeOptions): Promise<number> {
  throw new Error("not implemented");
}
