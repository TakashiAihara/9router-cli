export const USAGE_PERIODS = ["today", "24h", "7d", "30d"] as const;

export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export type UsageOptions = { period: UsagePeriod; json: boolean };

export async function runUsage(_opts: UsageOptions): Promise<number> {
  throw new Error("not implemented");
}
