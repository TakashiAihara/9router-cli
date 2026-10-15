import { admin, cell, guard, json, login, print } from "../lib.ts";

export const USAGE_PERIODS = ["today", "24h", "7d", "30d", "60d", "all"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export type UsageOptions = { period: UsagePeriod; json: boolean };

export const runUsage = guard(async (o: UsageOptions) => {
  const s = await admin(await login(), "GET", `/api/usage/stats?period=${o.period}`);
  if (o.json) json(s);
  else
    print(
      [s.totalRequests, s.totalPromptTokens, s.totalCompletionTokens, s.totalCost]
        .map(cell)
        .join("\t"),
    );
  return 0;
});
