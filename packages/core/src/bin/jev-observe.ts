#!/usr/bin/env node
/**
 * jev-observe — PR 判定 (a)（宣言と実装の整合）を observe モードで実行する
 * CLI（docs/01 3-2・#18）。CI（GitHub Actions）とローカルの両方で動く。
 *
 *   jev-observe --base <ref> [--log-dir DIR] [--evidence-root DIR]
 *     <base>...HEAD の diff が触れたアサーションを決定的に特定し、
 *     jev-judge MCP サーバー経由で判定する（判定の実行口は 1 か所 — docs/06）。
 *     observe 中は実 block しない（would_block は判定ログのみ）。
 *     summary（markdown・p を含まない）を stdout に書く。
 *
 * - 質問 1（req-assertion-a1）が escalate（unknown）/ failed / block のとき
 *   質問 2・3（req-assertion-a23）に進まない（docs/01「2 段判定」。配線による
 *   action ベースの制御であり判定ではない）
 * - 判定できなかった（配線エラー）と判定の結果（failMode に従う failed action）
 *   を混ぜない: 配線エラーは exit 1、判定結果は observe 中ゆえ exit 0
 * - evidence の paths は evidence root 配下のみ読める（docs/06 原則 3）ため、
 *   root はリポジトリルートとし、組立てた diff・使用箇所一覧は
 *   <root>/.git/jev-observe/（git 追跡外）に置く
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { Project } from "ts-morph";
import { findTouchedAssertions, type TouchedAssertion } from "../assertions/touched.js";
import { REQ_ASSERTION_A1, REQ_ASSERTION_A23 } from "../points/req-assertion-a.js";
import { startJevJudgeClient, type JevJudgeClient, type JudgeToolOutput } from "../mcp/client.js";
import { argValue } from "./cli-util.js";

const USAGE = "usage: jev-observe --base <ref> [--log-dir DIR] [--evidence-root DIR]";

/** 多数決は同一 evidence で 3 回判定（docs/05） */
const JUDGE_REPEATS = 3;

export type ObserveJudged = {
  point: string;
  status: string;
  actionKind: string;
  summary: string;
};

export type ObserveResult = {
  /** markdown。p・confidence・answers を含まない（jev-judge 出力契約の転記のみ） */
  summary: string;
  /** diff が触れるアサーションがなく判定を実行しなかった場合 true */
  skipped: boolean;
  judged: ObserveJudged[];
};

export type ObserveDeps = {
  /** git コマンド実行（決定的配線。テストで仮化する）。stdout を返す */
  git?: (args: string[]) => string;
  openClient?: (opts: { cwd: string; env: Record<string, string> }) => Promise<JevJudgeClient>;
  /** 組立てた evidence ファイル（diff・使用箇所一覧）の置き場。既定 <repoRoot>/.git/jev-observe */
  evidenceDir?: string;
};

export async function runObserve(args: string[], deps: ObserveDeps = {}): Promise<ObserveResult> {
  // core.quotePath=false: 既定では非 ASCII パスが "\346..." 形式にクォートされ、
  // 実パスと一致しなくなって touched 検出が漏れる（検出漏れは過検出より危険）
  const git = deps.git ?? ((a: string[]) => execFileSync("git", ["-c", "core.quotePath=false", ...a], { encoding: "utf8" }));
  const base = argValue(args, "--base");
  if (base === undefined) throw new Error(USAGE);
  const logDir = argValue(args, "--log-dir");
  const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
  const root = (rel: string) => `${repoRoot}/${rel}`;

  const changedRel = git(["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`])
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const tsFiles = git(["ls-files", "*.ts"])
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(tsFiles.map(root));
  const touched = findTouchedAssertions(project.getSourceFiles(), changedRel.map(root));

  if (touched.length === 0) {
    return {
      summary: [
        "# jev observe — PR 判定 (a)（observe 中。実 block なし）",
        "",
        "diff が触れるアサーション定義の使用箇所がないため判定を実行しなかった。",
      ].join("\n"),
      skipped: true,
      judged: [],
    };
  }

  const evidenceDir = deps.evidenceDir ?? `${repoRoot}/.git/jev-observe`;
  const paths = writeEvidenceFiles(git, evidenceDir, base, touched);

  const env: Record<string, string> = { JEV_EVIDENCE_ROOT: repoRoot };
  if (logDir !== undefined) env.JEV_LOG_DIR = logDir;
  const openClient = deps.openClient ?? startJevJudgeClient;
  const client = await openClient({ cwd: repoRoot, env });
  try {
    const evidence = { kind: "paths", paths };
    const a1 = await client.judge({ point: REQ_ASSERTION_A1.id, evidence, opts: { repeats: JUDGE_REPEATS } });
    const judged: ObserveJudged[] = [toJudged(REQ_ASSERTION_A1.id, a1)];

    // 2 段判定の制御（docs/01）。action ベースの決定的配線で、判定ではない:
    // a1 が escalate（unknown・回答欠落）/ failed（判定失敗）/ block（#19 以降の
    // 実 block。observe 中は pass に変換され現れない）なら a23 に進まない。
    // a1 が pass（observe 中の would-block を含む）なら a23 も判定して
    // 両観点の記録を積む（observe の目的 = fp 率測定に必要なデータが両方取れる）
    const a1Action = a1.action.kind;
    if (a1.status === "failed" || a1Action === "escalate" || a1Action === "block") {
      return {
        summary: buildSummary(touched, judged, `${REQ_ASSERTION_A23.id} は未実行（${REQ_ASSERTION_A1.id} が ${a1Action} / status ${a1.status} のため 2 段判定を停止）`),
        skipped: false,
        judged,
      };
    }
    const a23 = await client.judge({ point: REQ_ASSERTION_A23.id, evidence, opts: { repeats: JUDGE_REPEATS } });
    judged.push(toJudged(REQ_ASSERTION_A23.id, a23));
    return { summary: buildSummary(touched, judged), skipped: false, judged };
  } finally {
    await client.close();
  }
}

function toJudged(point: string, out: JudgeToolOutput): ObserveJudged {
  return { point, status: out.status, actionKind: out.action.kind, summary: out.summary };
}

function buildSummary(touched: TouchedAssertion[], judged: ObserveJudged[], tail?: string): string {
  const ids = [...new Set(touched.map((t) => t.id))];
  const lines = [
    "# jev observe — PR 判定 (a)（observe 中。実 block なし）",
    "",
    `diff が触れたアサーション: ${ids.join(", ")}`,
    "",
  ];
  for (const j of judged) {
    lines.push(`- ${j.point}: ${j.actionKind}（${j.summary}）`);
  }
  if (tail !== undefined) lines.push(`- ${tail}`);
  return lines.join("\n");
}

/** diff 全文・使用箇所一覧（事実のみの機械検出結果）を evidence root 配下に書く（0600） */
function writeEvidenceFiles(
  git: (args: string[]) => string,
  evidenceDir: string,
  base: string,
  touched: TouchedAssertion[],
): string[] {
  mkdirSync(evidenceDir, { recursive: true });
  const files: { name: string; text: string }[] = [
    { name: "diff.patch", text: git(["diff", `${base}...HEAD`]) },
    { name: "usages.txt", text: formatUsages(touched) },
  ];
  for (const f of files) {
    const p = `${evidenceDir}/${f.name}`;
    writeFileSync(p, f.text, { mode: 0o600 });
    chmodSync(p, 0o600);
  }
  const defFiles = [...new Set(touched.map((t) => t.defFile))];
  return [`${evidenceDir}/diff.patch`, `${evidenceDir}/usages.txt`, ...defFiles];
}

function formatUsages(touched: TouchedAssertion[]): string {
  const lines = ["# diff が触れたアサーションの使用箇所（機械検出結果。生のまま・評価語なし）", ""];
  for (const t of touched) {
    lines.push(`## ${t.id} (symbol: ${t.symbol}, defined in ${t.defFile})`);
    for (const u of t.usages) {
      lines.push(`- ${u.file}${u.enclosing === null ? "" : ` (in ${u.enclosingKind} ${u.enclosing})`}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const rest = process.argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const result = await runObserve(rest);
  console.log(result.summary);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
