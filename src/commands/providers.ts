export type ProvidersListOptions = { json: boolean };
export type ProvidersAddOptions = {
  provider: string;
  keyEnv: string;
  name: string | undefined;
  json: boolean;
};

export async function runProvidersList(_opts: ProvidersListOptions): Promise<number> {
  throw new Error("not implemented");
}

export async function runProvidersAdd(_opts: ProvidersAddOptions): Promise<number> {
  throw new Error("not implemented");
}
