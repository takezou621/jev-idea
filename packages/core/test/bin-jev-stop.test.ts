/**
 * jev-stop CLI（src/bin/jev-stop.ts・#21 Claude Code Stop フック配線）。
 *
 * DoD を先にテストとして書く（Issue #21）:
 * - DoD 1「アサーション違反のコード変更で、Stop 時に事実として理由が表示される」
 *   → Stop フック出力（systemMessage）に事実（触れたアサーション id・判定結果）
 *     が載り、p・confidence・answers を含まない
 * - DoD 2「observe 中はフックが exit 0 で終わり、記録だけ残る」
 *   → runStop は判定結果（would-block の pass 変換・escalate・failed を含む）で
 *     throw しない。触れた変更がなければ systemMessage も返さない
 *
 * - 判定は jev-judge MCP サーバー経由（docs/06。CI の jev-observe と同一の実行口。
 *   in-process の ServerState を judge ツール契約で包んだクライアントを注入する。
 *   judge ツール実装がそのまま走る）
 * - Stop フック入力（stdin JSON）の cwd を git の実行起点に渡す配線を検査する
 * - git は仮化するが、evidence ファイルは実ファイルシステムに書く（paths 契約）。
 *   実 bin プロセス（dist + stdin パイプ）での E2E はビルド後の smoke で実施
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { extractAssertionDefs } from "../src/assertions/touched.js";
import { findAssertionUsages } from "../src/assertions/references.js";
import { parseStopInput, runStop, stopHookOutput } from "../src/bin/jev-stop.js";
import type { ObserveDeps } from "../src/bin/jev-observe.js";
import { createJevJudgeServer } from "../src/mcp/server.js";
import type { ServerState } from "../src/mcp/protocol.js";
import type { JudgeProvider } from "../src/types.js";
import type { JevJudgeClient, JudgeToolOutput } from "../src/mcp/client.js";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const REQ_FILE = `import { require } from "./dsl.js";\nexport const AdultAge = require.number("adult-age", { within: [18, 99] });\n`;
const USER_FILE = `import { AdultAge } from "./req/sample.req.js";\nexport function register(age: number) { return check(AdultAge, age); }\n`;

function makeRepo(): string {
  const dir = tempDir("jev-stop-repo-");
  mkdirSync(join(dir, "req"), { recursive: true });
  writeFileSync(join(dir, "req", "sample.req.ts"), REQ_FILE);
  writeFileSync(join(dir, "user.ts"), USER_FILE);
  return dir;
}

type GitCall = { args: string[]; cwd?: string };

function fakeGit(repoDir: string, changed: string[], calls: GitCall[]): ObserveDeps["git"] {
  return (args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    // 実装は -c core.quotePath=false を前置する（非 ASCII パスのクォート防止）
    const a = args.filter((x, i) => !(x === "-c" || (i === 1 && x === "core.quotePath=false")));
    if (a[0] === "rev-parse") return `${repoDir}\n`;
    if (a[0] === "ls-files") return "req/sample.req.ts\nuser.ts\n";
    if (a[0] === "diff" && a.includes("--name-only")) return `${changed.join("\n")}\n`;
    if (a[0] === "diff") return `diff --git a/user.ts b/user.ts\n--- a/user.ts\n+++ b/user.ts\n@@ -1 +1 @@\n+changed\n`;
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

type JudgeCall = { point: string; evidence?: unknown; opts?: unknown; cwd?: string; env?: Record<string, string> };

/** ServerState（jev-judge ツール実装）を docs/06 契約のクライアントで包む */
function stubClient(server: ServerState, calls: JudgeCall[]): NonNullable<ObserveDeps["openClient"]> {
  return async (opts) => {
    const client: JevJudgeClient = {
      async judge(input) {
        calls.push({ ...input, cwd: opts.cwd, env: opts.env });
        const r = await server.call("judge", input);
        if (r.isError === true) throw new Error(r.content.map((c) => c.text).join(" "));
        return r.structuredContent as JudgeToolOutput;
      },
      async close() {},
    };
    return client;
  };
}

function stubProvider(answers: Record<string, unknown>): JudgeProvider {
  return async () => ({ answers: answers as never, usage: { input_tokens: 1, output_tokens: 1 }, model: "test-stub" });
}

/** a1: p 0.9 → true → block → observe で pass に変換。a23: warn */
const BLOCK_ANSWERS = {
  bypass: { type: "noul", noul: 0.9 },
  "basis-consistency": { type: "noul", noul: 0.7 },
  "input-path": { type: "noul", noul: 0.1 },
};
/** a1: p 0.5 → unknown → escalate（2 段判定の停止） */
const UNKNOWN_ANSWERS = { bypass: { type: "noul", noul: 0.5 } };

function observeDeps(repoDir: string, server: ServerState, calls: JudgeCall[], changed: string[], gitCalls: GitCall[] = []): ObserveDeps {
  return {
    git: fakeGit(repoDir, changed, gitCalls),
    openClient: stubClient(server, calls),
  };
}

function noP(text: string): void {
  expect(text).not.toMatch(/\bp\s*[=:]\s*0/);
  expect(text).not.toContain("confidence");
  expect(text).not.toContain("answers");
  expect(text).not.toContain("noul");
}

describe("jev-stop — Stop フック配線（#21 DoD）", () => {
  it("DoD 1: 触れた変更があると systemMessage に事実として載り、p を含まない", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false });
    const out = await runStop([], { cwd: repoDir }, observeDeps(repoDir, server, calls, ["user.ts"]));

    expect(out.systemMessage).toBeDefined();
    // 事実: 触れたアサーションと判定結果（判定語ではなく機械検出の事実 + jev-judge 契約の summary）
    expect(out.systemMessage).toContain("diff が触れたアサーション: adult-age");
    expect(out.systemMessage).toContain("req-assertion-a1: pass");
    expect(out.systemMessage).toContain("req-assertion-a23: warn");
    noP(out.systemMessage!);
    // 判定は jev-judge 経由（実行口は 1 か所）で a1 → a23 の両方
    expect(calls.map((c) => c.point)).toEqual(["req-assertion-a1", "req-assertion-a23"]);
    // Stop の差分（git diff HEAD）が evidence になっている（実行ごとの一意ディレクトリに置かれる）
    const evPaths = (calls[0]!.evidence as { kind: string; paths: string[] }).paths;
    expect(readFileSync(evPaths[0]!, "utf8")).toContain("+changed");
    expect(existsSync(evPaths[1]!)).toBe(true);
  });

  it("DoD 2: 触れた変更がなければ systemMessage を返さず判定も実行しない（静かに exit 0 相当）", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false });
    const out = await runStop([], { cwd: repoDir }, observeDeps(repoDir, server, calls, []));

    expect(out).toEqual({});
    expect(calls).toHaveLength(0);
    expect(stopHookOutput(out)).toBeUndefined();
  });

  it("DoD 2: a1 が would-block（observe で pass 変換）でも escalate でも throw しない。escalate なら a23 を止めた事実を載せる", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(UNKNOWN_ANSWERS), evidenceRoot: repoDir, log: false });
    const out = await runStop([], { cwd: repoDir }, observeDeps(repoDir, server, calls, ["user.ts"]));

    expect(calls.map((c) => c.point)).toEqual(["req-assertion-a1"]);
    expect(out.systemMessage).toContain("req-assertion-a23 は未実行");
    expect(out.systemMessage).toContain("escalate");
    noP(out.systemMessage!);
  });

  it("Stop 入力の cwd を git の実行起点にし、以降はリポジトリルートで実行する（サブディレクトリ起動のセッション）", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const gitCalls: GitCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false });
    await runStop([], { cwd: `${repoDir}/sub` }, observeDeps(repoDir, server, calls, ["user.ts"], gitCalls));

    expect(gitCalls[0]).toMatchObject({ cwd: `${repoDir}/sub` });
    for (const c of gitCalls.slice(1)) expect(c.cwd).toBe(repoDir);
  });

  it("stopHookOutput は Stop フック契約の JSON（systemMessage のみ）を返す", async () => {
    const line = stopHookOutput({ systemMessage: "事実" });
    expect(JSON.parse(line!.trim())).toEqual({ systemMessage: "事実" });
    expect(stopHookOutput({})).toBeUndefined();
  });
});

describe("parseStopInput — Stop フック stdin（#21）", () => {
  it("Stop イベント JSON から cwd を取り出す", () => {
    const raw = JSON.stringify({ session_id: "abc", hook_event_name: "Stop", stop_hook_active: true, cwd: "/repo/sub" });
    expect(parseStopInput(raw)).toEqual({ cwd: "/repo/sub" });
  });

  it("stdin が空・JSON でない・cwd が文字列でない場合も入力なしとして扱う（フックを落とさない）", () => {
    expect(parseStopInput("")).toEqual({});
    expect(parseStopInput("not json")).toEqual({});
    expect(parseStopInput('{"cwd": 42}')).toEqual({});
  });
});

describe("examples/age — 動作確認サンプルの検出可能性（README 手順が腐らないこと）", () => {
  it("サンプルは実ファイルのまま定義抽出と使用検出に掛かる", () => {
    const samplePath = fileURLToPath(new URL("../../../examples/age/sample.ts", import.meta.url));
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    project.addSourceFileAtPath(samplePath);
    const source = project.getSourceFiles()[0]!;

    expect(extractAssertionDefs(source)).toEqual([{ symbol: "AdultAge", id: "adult-age", file: samplePath }]);
    const usages = findAssertionUsages(project.getSourceFiles(), "AdultAge").filter((u) => u.file === samplePath);
    expect(usages.length).toBeGreaterThan(0);
  });
});
