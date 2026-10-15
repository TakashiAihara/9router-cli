#!/usr/bin/env bun
import { Command, InvalidArgumentError, Option } from "commander";
import { runCombosDelete, runCombosList, runCombosSet } from "./commands/combos.ts";
import { runModels } from "./commands/models.ts";
import { runProbe } from "./commands/probe.ts";
import {
  runProvidersAdd,
  runProvidersDelete,
  runProvidersList,
  runProvidersSet,
  runProvidersTest,
} from "./commands/providers.ts";
import { runUsage, USAGE_PERIODS, type UsagePeriod } from "./commands/usage.ts";
import { runVersion } from "./commands/version.ts";
import { VERSION } from "./version.ts";

const JSON_FLAG = "--json";
const JSON_HELP = "TSV ではなく JSON を stdout に出す";

const program = new Command();
program.exitOverride((e) => process.exit(e.exitCode === 0 ? 0 : 2));

program
  .name("9router-cli")
  .description("9router の combo / provider の管理と、経路ごとの疎通確認")
  .version(VERSION);

const combos = program.command("combos").description("combo の一覧・段の入れ替え・削除");

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

combos
  .command("delete")
  .description("名前で combo を削除する")
  .argument("<name>", "combo 名")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (name: string, opts: { json?: boolean }) => {
    process.exit(await runCombosDelete({ name, json: opts.json === true }));
  });

const providers = program
  .command("providers")
  .description("provider 接続の一覧・追加・編集・削除・試験");

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

// Number("") は 0 なので、空文字を弾かないと --priority "" が優先度 0 として通ってしまう
const priority = (value: string): number => {
  const text = value.trim();
  const n = Number(text);
  if (!text || !Number.isSafeInteger(n) || n < 0)
    throw new InvalidArgumentError("0 以上の整数を指定する");
  return n;
};

providers
  .command("set")
  .description("ID で接続の名前・優先度・有効状態・API key を更新する")
  .argument("<id>", "providers list に表示される ID")
  .option("--name <name>", "表示名")
  .option("--priority <n>", "優先度", priority)
  .option("--active", "接続を有効にする")
  .option("--inactive", "接続を無効にする")
  .option("--key-env <VAR>", "新しい API key が入っている環境変数")
  .option(JSON_FLAG, JSON_HELP)
  .action(
    async (
      id: string,
      opts: {
        name?: string;
        priority?: number;
        active?: boolean;
        inactive?: boolean;
        keyEnv?: string;
        json?: boolean;
      },
    ) => {
      if (opts.active && opts.inactive) {
        process.stderr.write("--active と --inactive は同時に指定できない\n");
        process.exit(2);
      }
      process.exit(
        await runProvidersSet({
          id,
          name: opts.name,
          priority: opts.priority,
          active: opts.active ? true : opts.inactive ? false : undefined,
          keyEnv: opts.keyEnv,
          json: opts.json === true,
        }),
      );
    },
  );

providers
  .command("delete")
  .description("ID で provider 接続を削除する")
  .argument("<id>", "接続 ID")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (id: string, opts: { json?: boolean }) => {
    process.exit(await runProvidersDelete({ id, json: opts.json === true }));
  });

providers
  .command("test")
  .description("ID で provider 接続をテストする")
  .argument("<id>", "接続 ID")
  .option(JSON_FLAG, JSON_HELP)
  .action(async (id: string, opts: { json?: boolean }) => {
    process.exit(await runProvidersTest({ id, json: opts.json === true }));
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
// 2 は使い方・秘密・通信の誤りと、login と models の失敗 (status を問わない。移植元どおり) で、どちらも意味を持つ終了コードなので、
// 想定外の例外がそのどちらかに見えないよう別の値で落とす
program.parseAsync().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(70);
});
