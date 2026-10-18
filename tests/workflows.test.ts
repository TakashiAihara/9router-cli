import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKFLOWS = ["ci.yml", "release.yml"];
const dir = resolve(import.meta.dir, "../.github/workflows");
const read = (file: string) => readFileSync(join(dir, file), "utf8");
// YAML の解釈は Bun に任せるので、必要な所だけ型を付ける
const release = () =>
  Bun.YAML.parse(read("release.yml")) as {
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: {
      tag: { steps: { name: string; run?: string }[] };
      build: { steps: { name: string; run?: string; env?: Record<string, string> }[] };
      publish: {
        permissions?: Record<string, string>;
        steps: { name: string; run?: string; env?: Record<string, string> }[];
      };
    };
  };
type Job = keyof ReturnType<typeof release>["jobs"];
const stepRun = (job: Job, name: string) =>
  release().jobs[job].steps.find((step) => step.name === name)?.run ?? "";
const releaseStep = () =>
  release().jobs.publish.steps.find((step) => step.name === "release")?.run ?? "";

const REPO = "TakashiAihara/9router-cli";

// GitHub の式を評価するものは手元に無いので、concurrency 式が使う形だけ (文字列の ==, &&,
// ||, 括弧) を素朴に評価する。GHA と同じ規則を使う: && は左が falsy なら左を返し、|| は左が
// truthy なら左を返す、空文字は falsy。見つからない path は空文字。
const evaluate = (tokens: string[], context: Record<string, unknown>): string => {
  let i = 0;
  const peek = () => tokens[i];
  const lookup = (path: string) =>
    String(
      path
        .split(".")
        .reduce<unknown>((v, k) => (v == null ? undefined : (v as never)[k]), context) ?? "",
    );
  const atom = (): string => {
    const token = tokens[i++]!;
    if (token === "(") {
      const value = or();
      i++; // )
      return value;
    }
    return token.startsWith("'") ? token.slice(1, -1) : lookup(token);
  };
  const eq = (): string => {
    const left = atom();
    if (peek() !== "==") return left;
    i++;
    return atom() === left ? "true" : "";
  };
  const and = (): string => {
    let left = eq();
    while (peek() === "&&") {
      i++;
      const right = eq();
      left = left ? right : left;
    }
    return left;
  };
  // function 宣言 (hoist) で、atom から先に参照できるようにする
  function or(): string {
    let left = and();
    while (peek() === "||") {
      i++;
      const right = and();
      left = left || right;
    }
    return left;
  }
  return or();
};

// release.yml の concurrency 式を、その run のイベント情報で評価した group 名を返す。
// run_id は 1 固定なので「run_id の group」は全部 "release-1" になる。
const groupFor = (eventName: string, event?: string, headRepository?: string) => {
  const source = release()
    .concurrency.group.replace(/^release-\$\{\{/, "")
    .replace(/\}\}$/, "");
  const tokens = [...source.matchAll(/\s*('[^']*'|[A-Za-z_][\w.]*|==|&&|\|\||[()])/g)].map(
    (m) => m[1]!,
  );
  return (
    "release-" +
    evaluate(tokens, {
      github: {
        event_name: eventName,
        run_id: 1,
        repository: REPO,
        event: {
          workflow_run: {
            event,
            head_repository: { full_name: headRepository },
          },
        },
      },
    })
  );
};

describe("release.yml の concurrency", () => {
  // Cancel ができるかどうかは job ではなく run で決まるので、jobs を全部 skip する run まで
  // main の group に入ると、その run が待ち行列の main の run を取り消す。cancel-in-progress が
  // false でも、後から来た run は先に queue された pending の run を取り消す。
  // だから main の group に入れるのは「その repo の main への push に対する CI の run」だけ。
  test("その repo の main への push に対する run だけが main の group に入る", () => {
    expect(groupFor("workflow_run", "push", REPO)).toBe("release-main");
  });

  // この repo の PR の CI も workflow_run を起きる。jobs は event が push でないので全部
  // skip されるが、run 自体は queue に入る。main と同じ group には入れない
  test("この repo の PR の run は自分の run_id の group に入る", () => {
    expect(groupFor("workflow_run", "pull_request", REPO)).toBe("release-1");
  });

  // fork の中の main という名前の branch への push も、この repo の main への pushでは
  // ないので run_id 側 (#3)
  test("fork の run は自分の run_id の group に入る", () => {
    expect(groupFor("workflow_run", "push", "someone/9router-cli")).toBe("release-1");
  });

  // 手で push した tag の release と再 dispatch は、それぞれ別 group に入れているので、
  // 次の main の run に取り消されない
  test("tag の push と手動 dispatch は自分の run_id の group に入る", () => {
    expect(groupFor("push")).toBe("release-1");
    expect(groupFor("workflow_dispatch")).toBe("release-1");
  });

  test("cancel-in-progress は false", () => {
    expect(release().concurrency["cancel-in-progress"]).toBe(false);
  });
});

describe("action の固定", () => {
  // action は tag ではなく commit (docker image は digest) で固定する。動かされた tag の下で
  // 差し替えられた action は「自分たちが作った」ものとして署名の証明に使われる
  test("全部 commit SHA / image digest で固定し、版を行末コメントに残す", () => {
    const uses: string[] = [];
    for (const file of WORKFLOWS) {
      for (const line of read(file).split("\n")) {
        if (!line.includes("uses:")) continue;
        uses.push(line);
        expect(line).toMatch(/uses:\s*\S+@([0-9a-f]{40}|sha256:[0-9a-f]{64})\s+#\s*v\S*\s*$/);
      }
    }

    expect(uses.length).toBeGreaterThan(0);
  });
});

// publish-release.sh は main の先頭と比べるのと、push / dispatch で checkout された tag が既に
// 誰のものかを確かめる。checkout は shallow なので、release step の fetch が全部
// 取って初めてできる。版の比較は gh release list を見るので、この tag 一覧には依存しない
describe("release.yml の publish job", () => {
  test("publish-release.sh を走らせる前に全 tag を fetch する", () => {
    const run = releaseStep();

    expect(run).toContain("+refs/tags/*:refs/tags/*");
    expect(run).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(run.indexOf("+refs/tags/*")).toBeLessThan(run.indexOf("sh scripts/publish-release.sh"));
  });

  // push / workflow_run / workflow_dispatch で「main の先頭でない commit の tag」の扱い方が
  // 変わる。スクリプトは event 名以外から経路を知れないので、この env が抜けると `:?` の
  // 検査で止まり、release を作る前に必ず失敗する
  test("publish-release.sh に event 名を渡す", () => {
    const env = release().jobs.publish.steps.find((step) => step.name === "release")?.env ?? {};

    expect(env.RELEASE_TRIGGER).toBe("${{ github.event_name }}");
  });

  // publish-release.sh は tag を API で ref として作るので、この job に書き込み権限が無いと
  // tag が作れず、すべての release が止まる
  test("release step の job が ref を作れる contents: write を持つ", () => {
    const publish = release().jobs.publish;

    expect(publish.permissions?.contents).toBe("write");
  });
});

// publish-release.sh は `:?` の後で tag の形を厳格に要求する (0 始まりと 9 桁を超える数を受け付け
// ない)。workflow 側が緩い形だと、checkout と build を全部走らせてから script で落とすことになる
describe("release.yml の tag の形", () => {
  test("check the requested tag が publish-release.sh と同じ形で見る", () => {
    const run = stepRun("tag", "check the requested tag");

    expect(run).toContain(
      "shape='^v(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(-rc\\.(0|[1-9][0-9]{0,8}))?$'",
    );
    expect(run).not.toContain("[0-9]+\\.");
  });

  // 取り直しの tag も後で release できる必要がある。緩い形だと script で落とす
  test("decide the tag が取り直し用の rc tag も同じ形で見る", () => {
    const run = stepRun("tag", "decide the tag");

    expect(run).toContain(
      "grep -E '^v(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})-rc\\.(0|[1-9][0-9]{0,8})$'",
    );
  });
});

describe("release.yml: 公開前に 4 種を各 runner で動かす (#13)", () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  type AnyJob = {
    needs?: string | string[];
    "runs-on"?: string;
    permissions?: Record<string, string>;
    strategy?: { "fail-fast"?: boolean; matrix?: { include?: Record<string, string>[] } };
    steps: Step[];
  };
  const jobs = () => (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, AnyJob> }).jobs;
  const needs = (job: AnyJob) => ([] as string[]).concat(job.needs ?? []);
  const runs = (job: AnyJob) => job.steps.map((s) => s.run ?? "").join("\n");
  const uses = (job: AnyJob, action: string) =>
    job.steps.some((s) => s.uses?.startsWith(`${action}@`));

  test("verify job は 4 種それぞれを、その OS / CPU の runner で走らせる", () => {
    const verify = jobs().verify!;
    const pairs = (verify.strategy?.matrix?.include ?? [])
      .map((m) => `${m.target} ${m.runner}`)
      .sort();

    expect(pairs).toEqual([
      "darwin-arm64 macos-15",
      "darwin-x64 macos-15-intel",
      "linux-arm64 ubuntu-24.04-arm",
      "linux-x64 ubuntu-24.04",
    ]);
    expect(verify["runs-on"]).toBe("${{ matrix.runner }}");
    expect(verify.strategy?.["fail-fast"]).toBe(false);
  });

  test("verify は build が上げた成果物を落として検査し、自分では build しない", () => {
    const { build, verify } = jobs();

    expect(uses(build!, "actions/upload-artifact")).toBe(true);
    expect(needs(verify!)).toContain("build");
    expect(uses(verify!, "actions/download-artifact")).toBe(true);
    expect(runs(verify!)).not.toContain("bun build");
    expect(runs(verify!)).not.toContain("scripts/build.ts");
    expect(runs(verify!)).toContain("scripts/run-binary.sh");
    expect(runs(verify!)).toMatch(/sha256sum|shasum/);
  });

  test("公開は全部の verify が通ってからで、同じ成果物を落として SHA256SUMS を照合する", () => {
    const { publish } = jobs();

    expect(needs(publish!)).toEqual(expect.arrayContaining(["build", "verify"]));
    expect(uses(publish!, "actions/download-artifact")).toBe(true);
    expect(runs(publish!)).toMatch(/sha256sum -c|shasum -a 256 -c/);
    expect(uses(publish!, "actions/attest-build-provenance")).toBe(true);
    expect(runs(publish!)).toContain("sh scripts/publish-release.sh");
  });

  test("書き込みの権限を持つのは公開の job だけ", () => {
    const { build, verify, publish } = jobs();

    expect(build!.permissions?.contents ?? "read").toBe("read");
    expect(build!.permissions?.["id-token"]).toBeUndefined();
    expect(verify!.permissions?.contents ?? "read").toBe("read");
    expect(publish!.permissions?.contents).toBe("write");
    expect(publish!.permissions?.["id-token"]).toBe("write");
    expect(runs(build!)).not.toContain("publish-release.sh");
    expect(uses(build!, "actions/attest-build-provenance")).toBe(false);
  });
});

// publish が照合する SHA256SUMS は build が出したもの。バイナリか sums の片方だけが
// artifact に入れば、公開する物と照合する物が食い違う (#13)
describe("release.yml: build の上げる artifact (#13)", () => {
  type Step = {
    uses?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
    run?: string;
  };
  type Job = { steps: Step[] };
  const job = (name: string) =>
    (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, Job> }).jobs[name]!;
  const upload = () =>
    job("build").steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))?.with ?? {};

  test("4 個と SHA256SUMS を同じ artifact に上げる", () => {
    const path = String(upload().path ?? "");

    expect(path).toContain("dist/9router-cli-*");
    expect(path).toContain("dist/SHA256SUMS");
  });

  // 走らせるのは matrix の target、中身は publish する tag。どちらかが欠けると、別の
  // バイナリか別の tag を検査したことになる
  test("verify は tag と target を script に渡す", () => {
    const step = job("verify").steps.find((s) => s.run?.includes("run-binary.sh"));

    expect(step?.env?.TAG).toBe("${{ needs.tag.outputs.tag }}");
    expect(step?.env?.TARGET).toBe("${{ matrix.target }}");
    expect(step?.run).toContain('sh scripts/run-binary.sh "dist/9router-cli-$TARGET" "$TAG"');
  });
});

describe("release.yml: 検査した commit と成果物をそのまま公開する (#13 の 2 周目)", () => {
  type Step = {
    id?: string;
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  };
  type AnyJob = {
    needs?: string | string[];
    if?: string;
    "timeout-minutes"?: number;
    permissions?: unknown;
    outputs?: Record<string, string>;
    env?: Record<string, string>;
    steps: Step[];
  };
  const jobs = () => (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, AnyJob> }).jobs;
  const needs = (job: AnyJob) => ([] as string[]).concat(job.needs ?? []);
  const runs = (job: AnyJob) => job.steps.map((s) => s.run ?? "").join("\n");
  const stepsUsing = (job: AnyJob, action: string) =>
    job.steps.filter((s) => s.uses?.startsWith(`${action}@`));

  test("tag job が検査した commit の SHA を出し、build / verify / publish はその SHA を checkout する", () => {
    const all = jobs();

    expect(all.tag!.outputs?.sha).toBe("${{ steps.commit.outputs.sha }}");
    const commit = all.tag!.steps.find((s) => s.id === "commit");
    expect(commit?.run).toContain('sha="$(git rev-parse HEAD)"');
    expect(commit?.run).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
    for (const name of ["build", "verify", "publish"]) {
      const job = all[name]!;
      expect(needs(job)).toContain("tag");
      const checkouts = stepsUsing(job, "actions/checkout");
      expect(checkouts.length).toBe(1);
      expect(checkouts[0]!.with?.ref).toBe("${{ needs.tag.outputs.sha }}");
    }
  });

  test("verify には時間の上限があり、止まったバイナリが main の release を詰まらせない", () => {
    const limit = jobs().verify!["timeout-minutes"];

    expect(typeof limit).toBe("number");
    expect(limit!).toBeGreaterThan(0);
    expect(limit!).toBeLessThanOrEqual(30);
  });

  test("artifact は保持期間を明示し、build が上げた名前を verify と publish が落とす", () => {
    const { build, verify, publish } = jobs();
    const up = stepsUsing(build!, "actions/upload-artifact");

    expect(up.length).toBe(1);
    const retention = up[0]!.with?.["retention-days"];
    expect(typeof retention).toBe("number");
    expect(retention as number).toBeLessThanOrEqual(30);
    const name = up[0]!.with?.name;
    expect(typeof name).toBe("string");
    for (const job of [verify!, publish!]) {
      const down = stepsUsing(job, "actions/download-artifact");
      expect(down.length).toBe(1);
      expect(down[0]!.with?.name).toBe(name);
    }
  });

  test("verify は SHA256SUMS を Linux でも macOS でも照合し、run-binary.sh の失敗を潰さない", () => {
    const text = runs(jobs().verify!);

    expect(text).toContain("sha256sum -c");
    expect(text).toContain("shasum -a 256 -c");
    expect(text).toMatch(/^\s*sh scripts\/run-binary\.sh [^\n]*$/m);
    expect(text).not.toMatch(/run-binary\.sh[^\n]*(\|\||;)/);
  });

  test("publish は status 関数で verify の失敗を通さず、全ファイルを照合し、TAG を受け取る", () => {
    const publish = jobs().publish!;

    expect(publish.if).toBe("needs.tag.outputs.tag != ''");
    expect(runs(publish)).toMatch(/^\s*sha256sum -c SHA256SUMS\s*$/m);
    expect(publish.env?.TAG).toBe("${{ needs.tag.outputs.tag }}");
  });

  test("権限は object で書き、署名の権限は publish だけが持つ", () => {
    const { build, verify, publish } = jobs();

    for (const job of [build!, verify!, publish!]) expect(typeof job.permissions).toBe("object");
    for (const job of [build!, verify!]) {
      const p = job.permissions as Record<string, string>;
      expect(p["id-token"]).toBeUndefined();
      expect(p.attestations).toBeUndefined();
      expect(p.contents).toBe("read");
    }
    const p = publish!.permissions as Record<string, string>;
    expect(p.attestations).toBe("write");
  });
});
