import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { makeSandbox, removeSandbox, type Sandbox } from "./helpers/cli.ts";

const INSTALL_SH = resolve(import.meta.dir, "../install.sh");
const REPO_PATH = "/TakashiAihara/9router-cli/releases";
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ASSET = `9router-cli-${OS}-${ARCH}`;

const WORKING = "#!/bin/sh\necho working\n";
// shebang の先が無いので exec できない。shebang 無しだと sh が script として流してしまう
const BROKEN = "#!/nonexistent/interp\n";
const OLD = "#!/bin/sh\necho old-install\n";

// install.sh が使う道具だけを入れた PATH。本物の gh が紛れ込むと「gh が無い」を作れない
const TOOLS = ["uname", "mktemp", "rm", "mkdir", "mv", "chmod", "grep", "awk", "sha256sum"];

type Release = { binary?: string; sums?: string };

let sb: Sandbox;
let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];
let latestCalls = 0;
let bin: string;
let installDir: string;

function startServer(releases: Record<string, Release>): void {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (path === `${REPO_PATH}/latest`) {
        // 2 回目以降は別の release を指す。1 回しか引かないことをこれで見る
        latestCalls += 1;
        const tags = Object.keys(releases);
        const tag = tags[Math.min(latestCalls - 1, tags.length - 1)];
        return new Response(null, {
          status: 302,
          headers: { location: `${REPO_PATH}/tag/${tag}` },
        });
      }
      if (path.startsWith(`${REPO_PATH}/tag/`)) return new Response("release page");
      const m = new RegExp(`^${REPO_PATH}/download/([^/]+)/(.+)$`).exec(path);
      const release = m?.[1] ? releases[m[1]] : undefined;
      if (!release) return new Response("not found", { status: 404 });
      if (m?.[2] === ASSET && release.binary !== undefined) return new Response(release.binary);
      if (m?.[2] === "SHA256SUMS" && release.sums !== undefined) return new Response(release.sums);
      return new Response("not found", { status: 404 });
    },
  });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const release = (binary: string): Release => ({ binary, sums: `${sha(binary)}  ${ASSET}\n` });

function writeTool(name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  sb = makeSandbox();
  requests = [];
  latestCalls = 0;
  bin = join(sb.dir, "bin");
  installDir = join(sb.dir, "install");
  mkdirSync(bin);
  for (const t of TOOLS) {
    const real = Bun.which(t);
    if (!real) throw new Error(`${t} is needed to run install.sh`);
    symlinkSync(real, join(bin, t));
  }
});

afterEach(() => {
  server.stop(true);
  removeSandbox(sb);
});

// github.com への curl を手元の server に向ける。install.sh の URL は書き換えない
function shimCurl(): void {
  const real = Bun.which("curl");
  if (!real) throw new Error("curl is needed to run install.sh");
  writeTool(
    "curl",
    `for a; do shift; case "$a" in https://github.com/*) a="http://127.0.0.1:${server.port}/\${a#https://github.com/}";; esac; set -- "$@" "$a"; done
exec ${real} "$@"`,
  );
}

async function install(env: Record<string, string> = {}) {
  shimCurl();
  const proc = Bun.spawn(["/bin/sh", INSTALL_SH], {
    cwd: sb.dir,
    env: { PATH: bin, HOME: sb.home, NINE_ROUTER_CLI_INSTALL_DIR: installDir, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

const installed = () => join(installDir, "9router-cli");
const leftovers = () =>
  existsSync(installDir) ? readdirSync(installDir).filter((f) => f.startsWith(".")) : [];

function placeOldInstall(): void {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(installed(), OLD);
  chmodSync(installed(), 0o755);
}

describe("install.sh", () => {
  test("latest は 1 回だけ引き、バイナリも SHA256SUMS もその tag から取る", async () => {
    startServer({ "v1.0.0-rc.3": release(WORKING), "v1.0.0-rc.4": release(WORKING) });

    const r = await install();

    expect(r.code).toBe(0);
    expect(r.out).toContain("(v1.0.0-rc.3)");
    expect(latestCalls).toBe(1);
    expect(requests.filter((p) => p.includes("/download/"))).toEqual([
      `${REPO_PATH}/download/v1.0.0-rc.3/${ASSET}`,
      `${REPO_PATH}/download/v1.0.0-rc.3/SHA256SUMS`,
    ]);
    expect(readFileSync(installed(), "utf8")).toBe(WORKING);
    expect(leftovers()).toEqual([]);
  });

  test("tag を指定したら latest を引かない", async () => {
    startServer({ "v0.5.0": release(WORKING) });

    const r = await install({ NINE_ROUTER_CLI_VERSION: "v0.5.0" });

    expect(r.code).toBe(0);
    expect(latestCalls).toBe(0);
  });

  test("checksum が合わなければ入れない", async () => {
    startServer({ "v1.0.0": { binary: WORKING, sums: `${sha("other")}  ${ASSET}\n` } });
    placeOldInstall();

    const r = await install();

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("checksum mismatch");
    expect(readFileSync(installed(), "utf8")).toBe(OLD);
  });

  test("動かないバイナリは、入っている版を置き換えずに止まる", async () => {
    startServer({ "v1.0.0": release(BROKEN) });
    placeOldInstall();

    const r = await install();

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not run");
    expect(readFileSync(installed(), "utf8")).toBe(OLD);
    expect(leftovers()).toEqual([]);
  });

  describe("NINE_ROUTER_CLI_VERIFY_ATTESTATION=1", () => {
    const verify = { NINE_ROUTER_CLI_VERIFY_ATTESTATION: "1" };

    test("gh が無ければ、検証できないまま入れずに止まる", async () => {
      startServer({ "v1.0.0": release(WORKING) });
      placeOldInstall();

      const r = await install(verify);

      expect(r.code).not.toBe(0);
      expect(r.err).toContain("needs gh");
      expect(readFileSync(installed(), "utf8")).toBe(OLD);
    });

    test("検証が落ちたら、gh の出した理由を添えて止まる", async () => {
      startServer({ "v1.0.0": release(WORKING) });
      writeTool("gh", `echo "HTTP 401: bad credentials" >&2\nexit 1`);
      placeOldInstall();

      const r = await install(verify);

      expect(r.code).not.toBe(0);
      expect(r.err).toContain("attestation verification failed: HTTP 401: bad credentials");
      expect(readFileSync(installed(), "utf8")).toBe(OLD);
    });

    test("検証が通れば入れる", async () => {
      startServer({ "v1.0.0": release(WORKING) });
      writeTool("gh", `exit 0`);

      const r = await install(verify);

      expect(r.code).toBe(0);
      expect(r.out).toContain("attestation ok");
      expect(readFileSync(installed(), "utf8")).toBe(WORKING);
    });
  });
});
