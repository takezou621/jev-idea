/**
 * jev-observe CLI（src/bin/jev-observe.ts・#18 配線）。
 *
 * - git は仮化（deps.git。決定的な配線部分は差し替え可能にするが、走査対象は
 *   実ファイルシステムの fixture — ts-morph の走査は本物を通す）
 * - 判定は jev-judge MCP サーバー経由（DoD 2 前半）: in-process の ServerState
 *   を docs/06 の judge ツール契約で包んだクライアントを注入する。judge ツール
 *   実装（server.ts → jev-judge.ts → judge）がそのまま走る
 * - DoD 2 後半「CI 側に p が現れない」: summary（stdout 相当）に p・confidence・
 *   answers・noul 数値が現れないことを stub 応答（p 0.9 など）に対して検査する
 * - 実 jev-judge bin プロセスとの E2E はビルド後の smoke で実施（dist 依存を
 *   テストに入れない）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { observeWorkingTree, runObserve, type ObserveDeps } from "../src/bin/jev-observe.js";
import { REQ_ASSERTION_A1 } from "../src/points/req-assertion-a.js";
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
  const dir = tempDir("jev-observe-repo-");
  mkdirSync(join(dir, "req"), { recursive: true });
  writeFileSync(join(dir, "req", "sample.req.ts"), REQ_FILE);
  writeFileSync(join(dir, "user.ts"), USER_FILE);
  return dir;
}

function fakeGit(repoDir: string, changed: string[]): ObserveDeps["git"] {
  return (args: string[]) => {
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
function stubClient(
  server: ServerState,
  calls: JudgeCall[],
): NonNullable<ObserveDeps["openClient"]> {
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

/** a1: p 0.9 → true → block → observe で pass。a23: basis 0.7（true）/ input 0.1（false）→ warn */
const BLOCK_ANSWERS = {
  bypass: { type: "noul", noul: 0.9 },
  "basis-consistency": { type: "noul", noul: 0.7 },
  "input-path": { type: "noul", noul: 0.1 },
};
/** a1: p 0.5 → unknown → escalate */
const UNKNOWN_ANSWERS = { bypass: { type: "noul", noul: 0.5 } };

const BASE_ARGS = ["--base", "origin/main"];

/** evidenceDir は注入しない（既定 <repoDir>/.git/jev-observe。evidence root 配下の実経路をテストする） */
function observeDeps(repoDir: string, server: ServerState, calls: JudgeCall[], changed: string[] = ["user.ts"]): ObserveDeps {
  return {
    git: fakeGit(repoDir, changed),
    openClient: stubClient(server, calls),
  };
}

function noP(text: string): void {
  expect(text).not.toMatch(/\bp\s*[=:]\s*0/);
  expect(text).not.toContain("confidence");
  expect(text).not.toContain("answers");
  expect(text).not.toContain("noul");
}

describe("jev-observe — 配線ロジック（#18 DoD 2）", () => {
  it("diff が触れるアサーションがなければ判定を実行しない（skipped。API 呼び出しなし）", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false });
    const r = await runObserve(BASE_ARGS, observeDeps(repoDir, server, calls, ["req/sample.req.ts"]));
    expect(r.skipped).toBe(true);
    expect(r.judged).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(r.summary).toContain("判定を実行しなかった");
  });

  it("初回 commit 前（HEAD 不在）は配線エラーにせず skipped で終わる（Stop フックの毎ターン error を避ける）", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false });
    const inner = fakeGit(repoDir, ["user.ts"])!;
    const git: ObserveDeps["git"] = (args) => {
      if (args[1] === "--verify") throw new Error("fatal: ambiguous argument 'HEAD'");
      return inner(args);
    };
    const r = await observeWorkingTree([], { git, openClient: stubClient(server, calls) }, { cwd: repoDir });

    expect(r.skipped).toBe(true);
    expect(r.judged).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(r.summary).toContain("初回 commit 前");
  });

  it("touched を特定し、jev-judge 経由で a1 → a23 を判定する。summary に p が現れない（DoD 2）", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false });
    const r = await runObserve(BASE_ARGS, observeDeps(repoDir, server, calls));

    expect(r.skipped).toBe(false);
    expect(r.judged.map((j) => j.point)).toEqual(["req-assertion-a1", "req-assertion-a23"]);
    // a1 は observe 中のため would-block 化した pass を返す（judge ツールの契約）
    expect(r.judged[0]).toMatchObject({ status: "judged", actionKind: "pass" });
    expect(r.judged[0]!.summary).toContain("bypass=true → pass");
    expect(r.judged[1]).toMatchObject({ status: "judged", actionKind: "warn" });
    // 多数決（同一 evidence 3 回）を指定している
    expect(calls.map((c) => c.opts)).toEqual([{ repeats: 3 }, { repeats: 3 }]);
    // DoD 2 後半: summary（CI に出るテキスト全体）に p・confidence・answers が現れない
    noP(r.summary);
    for (const j of r.judged) noP(j.summary);
    expect(r.summary).toContain("diff が触れたアサーション: adult-age");
    expect(r.summary).toContain("req-assertion-a1: pass");
  });

  it("a1 が escalate（unknown）なら 2 段判定を停止する（docs/01。判定ではなく action ベースの配線制御）", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(UNKNOWN_ANSWERS), evidenceRoot: repoDir, log: false });
    const r = await runObserve(BASE_ARGS, observeDeps(repoDir, server, calls));

    expect(calls.map((c) => c.point)).toEqual(["req-assertion-a1"]);
    expect(r.judged).toHaveLength(1);
    expect(r.summary).toContain("req-assertion-a23 は未実行");
    expect(r.summary).toContain("escalate");
    noP(r.summary);
  });

  it("a1 が status: failed（プロバイダ故障・fail-open で pass action）でも 2 段判定を停止する（CI でキーが無いときの実運用経路）", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: async () => { throw new Error("provider down"); }, evidenceRoot: repoDir, log: false });
    const r = await runObserve(BASE_ARGS, observeDeps(repoDir, server, calls));

    expect(calls.map((c) => c.point)).toEqual(["req-assertion-a1"]);
    expect(r.judged).toHaveLength(1);
    expect(r.judged[0]).toMatchObject({ status: "failed", actionKind: "pass" });
    expect(r.summary).toContain("req-assertion-a23 は未実行");
    expect(r.summary).toContain("status failed");
    noP(r.summary);
  });

  it("a1 が block を返す場合（#19 有効化後。observe 無効のポイントで再現）も 2 段判定を停止する", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    // observe を外した a1 は would-block 変換なしで block を返す（判定ポイント定義自体は変えない）
    const a1NoObserve = { ...REQ_ASSERTION_A1, observe: false };
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false, points: [a1NoObserve] });
    const r = await runObserve(BASE_ARGS, observeDeps(repoDir, server, calls));

    expect(calls.map((c) => c.point)).toEqual(["req-assertion-a1"]);
    expect(r.judged).toHaveLength(1);
    expect(r.judged[0]).toMatchObject({ status: "judged", actionKind: "block" });
    expect(r.summary).toContain("req-assertion-a23 は未実行");
    noP(r.summary);
  });

  it("evidence は paths（diff.patch・usages.txt・定義ファイル）で渡され、実行ごとの一意ディレクトリ（0700/0600）に置かれる", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false });
    await runObserve(BASE_ARGS, observeDeps(repoDir, server, calls));

    // 既定の evidenceBase は <repoDir>/.git/jev-observe（git 追跡外。evidence root 配下）。
    // 実行ごとに一意のサブディレクトリが作られる（並行実行が a1/a23 間でファイルを差し替えない）
    const evidenceBase = join(repoDir, ".git", "jev-observe");
    expect(calls).toHaveLength(2);
    const paths = (calls[0]!.evidence as { kind: string; paths: string[] }).paths;
    expect(paths[0]!.startsWith(`${evidenceBase}/`)).toBe(true);
    expect(paths[0]!.endsWith("/diff.patch")).toBe(true);
    expect(paths[1]!.endsWith("/usages.txt")).toBe(true);
    expect(paths[2]).toBe(`${repoDir}/req/sample.req.ts`);
    for (const p of paths) expect(existsSync(p)).toBe(true);
    // 機密（diff 全文）を含むためディレクトリ 0700・ファイル 0600
    const { statSync } = await import("node:fs");
    const runDir = paths[0]!.slice(0, paths[0]!.lastIndexOf("/"));
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths[0]!).mode & 0o777).toBe(0o600);
    // usages.txt は事実のみの機械検出結果
    const usages = readFileSync(paths[1]!, "utf8");
    expect(usages).toContain("adult-age");
    expect(usages).toContain("AdultAge");
    expect(usages).toContain("function register");
    // クライアントには evidence root（リポジトリルート）が渡る
    expect(calls[0]!.env).toMatchObject({ JEV_EVIDENCE_ROOT: repoDir });
    expect(calls[0]!.cwd).toBe(repoDir);
    // 次の実行は別ディレクトリを使う（前の実行の evidence を上書きしない）
    await runObserve(BASE_ARGS, observeDeps(repoDir, server, calls));
    const paths2 = (calls[2]!.evidence as { kind: string; paths: string[] }).paths;
    expect(paths2[0]).not.toBe(paths[0]);
  });

  it("--base 欠落は配線エラー（usage で reject。黙って間違った diff を判定しない）", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: repoDir, log: false });
    await expect(runObserve([], observeDeps(repoDir, server, calls))).rejects.toThrow(/usage: jev-observe --base/);
    expect(calls).toHaveLength(0);
  });

  it("judge ツールが isError を返す入力不正（evidence root 外の paths）は配線エラーとして伝播する", async () => {
    const repoDir = makeRepo();
    const calls: JudgeCall[] = [];
    // evidence root を別ディレクトリにする（paths が root 外 → isError。配線の誤りを黙って通さない）
    const wrongRoot = tempDir("jev-observe-wrongroot-");
    const server = createJevJudgeServer({ provider: stubProvider(BLOCK_ANSWERS), evidenceRoot: wrongRoot, log: false });
    await expect(runObserve(BASE_ARGS, observeDeps(repoDir, server, calls))).rejects.toThrow(/evidence path outside allowed root/);
  });
});
