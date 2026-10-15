#!/usr/bin/env bun
import { Command, InvalidArgumentError, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runCombosList, runCombosSet } from "./commands/combos.ts";
import { runModels } from "./commands/models.ts";
import { runProbe } from "./commands/probe.ts";
import { runProvidersAdd, runProvidersList } from "./commands/providers.ts";
import { runUsage, USAGE_PERIODS, type UsagePeriod } from "./commands/usage.ts";
import { runVersion } from "./commands/version.ts";

const JSON_FLAG = "--json";
const JSON_HELP = "TSV ではなく JSON を stdout に出す";

const program = new Command();
program.exitOverride((e) => process.exit(e.exitCode === 0 ? 0 : 2));

program
  .name("9router-cli")
  .description("9router の combo / provider の管理と、経路ごとの疎通確認")
  .version(pkg.version);

const combos = program.command("combos").description("combo の一覧と段の入れ替え");

combos
  .command("list")
  .description("combo ごとに 1 行で段を順に出す")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (opts: { json?: boolean }) => {
    process.exit(await runCombosList({ json: opts.json === true }));
  });

combos
  .command("set")
  .description("combo の段を全置換する。無い名前は --create が無ければ書かない")
  .argument("<name>", "combo 名")
  .argument("<models...>", "段のモデル ID (1 本以上、この順)")
  .option("--create", "無い名前なら新しく作る")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (name: string, models: string[], opts: { create?: boolean; json?: boolean }) => {
    process.exit(
      await runCombosSet({
        name,
        models,
        create: opts.create === true,
        json: opts.json === true,
      }),
    );
  });

const providers = program.command("providers").description("provider 接続の一覧と追加");

providers
  .command("list")
  .description("接続ごとに 1 行で状態を出す (token と email は出さない)")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (opts: { json?: boolean }) => {
    process.exit(await runProvidersList({ json: opts.json === true }));
  });

providers
  .command("add")
  .description("API key の provider 接続を足す。鍵は env から取り、argv にも出力にも載せない")
  .argument("<provider>", "provider 名")
  .requiredOption("--key-env <VAR>", "鍵が入っている環境変数の名前")
  .option("--name <name>", "接続の表示名")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (provider: string, opts: { keyEnv: string; name?: string; json?: boolean }) => {
    process.exit(
      await runProvidersAdd({
        provider,
        keyEnv: opts.keyEnv,
        name: opts.name,
        json: opts.json === true,
      }),
    );
  });

program
  .command("models")
  .description(
    "/v1/models の ID を出す。載っていることは提供中を意味しないので、入れる前に probe する",
  )
  .option("--prefix <P>", "接頭辞 P/ で始まる ID だけ出す")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (opts: { prefix?: string; json?: boolean }) => {
    process.exit(await runModels({ prefix: opts.prefix, json: opts.json === true }));
  });

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const positiveSeconds = (value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("正の数を指定する");
  return n;
};

program
  .command("probe")
  .description("モデル / combo / combo の各段を 1 本ずつ当てて、HTTP status で OK / NG を判定する")
  .argument("[models...]", "当てるモデル ID")
  .option("--combo <name>", "combo とその各段を当てる (繰り返せる)", collect, [])
  .option("--all-combos", "全 combo とその各段を当てる")
  .option("--timeout <sec>", "1 本ごとの時間切れ (秒)", positiveSeconds, 60)
  .option(JSON_FLAG, JSON_HELP)
  .action(
    async (
      models: string[],
      opts: { combo: string[]; allCombos?: boolean; timeout: number; json?: boolean },
    ) => {
      process.exit(
        await runProbe({
          models,
          combo: opts.combo,
          allCombos: opts.allCombos === true,
          timeout: opts.timeout,
          json: opts.json === true,
        }),
      );
    },
  );

program
  .command("version")
  .description("9router 本体の版と、更新があるかを出す (認証不要)")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (opts: { json?: boolean }) => {
    process.exit(await runVersion({ json: opts.json === true }));
  });

program
  .command("usage")
  .description("期間ごとの利用量の集計を出す")
  .addOption(new Option("--period <period>", "集計の期間").choices(USAGE_PERIODS).default("today"))
  .option(JSON_FLAG, JSON_HELP)
  .action(async (opts: { period: UsagePeriod; json?: boolean }) => {
    process.exit(await runUsage({ period: opts.period, json: opts.json === true }));
  });

// 1 は相手が否と答えた (probe の NG・管理 API のエラー・version のエラー)、
// 2 は使い方・秘密・通信・認証 (login と models の鍵の拒否) の誤りで、どちらも意味を持つ終了コードなので、
// 想定外の例外がそのどちらかに見えないよう別の値で落とす
program.parseAsync().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(70);
});
