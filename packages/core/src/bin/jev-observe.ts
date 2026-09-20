#!/usr/bin/env node
/**
 * jev-observe — PR 判定 (a)（宣言と実装の整合）を observe モードで実行する
 * CLI（docs/01 3-2・#18）。CI（GitHub Actions）とローカルの両方で動く。
 *
 *   jev-observe --base <ref> [--log-dir DIR]
 *     <base>...HEAD の diff が触れたアサーションを決定的に特定し、
 *     jev-judge MCP サーバー経由で判定する（判定の実行口は 1 か所 — docs/06）。
 *     observe 中は実 block しない（would_block は判定ログのみ）。
 *     summary（markdown・p を含まない）を stdout に書く。
 *
 * 同じ判定を未コミット変更（git diff HEAD）に対して回すのが observeWorkingTree
 * （jev-stop・#21 Stop フックから使う）。差分は diff の範囲（refspec）だけで、
 * 判定ポイント・evidence 組立て・2 段判定の制御は同一（docs/06「定義は
 * 1 か所、ホスト差分は配線だけ」）。
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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Project } from "ts-morph";
import { findTouchedAssertions, type TouchedAssertion } from "../assertions/touched.js";
import { REQ_ASSERTION_A1, REQ_ASSERTION_A23 } from "../points/req-assertion-a.js";
import { startJevJudgeClient, type JevJudgeClient, type JudgeToolOutput } from "../mcp/client.js";
import { argValue } from "./cli-util.js";

const USAGE = "usage: jev-observe --base <ref> [--log-dir DIR]";

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
  git?: (args: string[], opts?: { cwd?: string }) => string;
  openClient?: (opts: { cwd: string; env: Record<string, string> }) => Promise<JevJudgeClient>;
  /** evidence ファイル置き場の親ディレクトリ（実行ごとに一意のサブディレクトリを作る）。既定 <repoRoot>/.git/jev-observe */
  evidenceDir?: string;
};

/** observeChanges への要求。refspec と文脈のみで、判定の中身は共通（docs/06） */
type ObserveRequest = {
  /** git diff の範囲。jev-observe: "<base>...HEAD"、jev-stop: "HEAD"（未コミット変更） */
  refspec: string;
  /** summary 見出しの文脈（"PR 判定 (a)" / "Stop 判定 (a)"） */
  label: string;
  logDir?: string;
  /** git の実行起点（既定: プロセス cwd。Stop フックでは stdin の cwd） */
  cwd?: string;
};

export async function runObserve(args: string[], deps: ObserveDeps = {}): Promise<ObserveResult> {
  const base = argValue(args, "--base");
  if (base === undefined) throw new Error(USAGE);
  return observeChanges({ refspec: `${base}...HEAD`, label: "PR 判定 (a)", logDir: argValue(args, "--log-dir") }, deps);
}

/** 未コミット変更（git diff HEAD・tracked のみ）を「このターンで触れた」の近似として判定する */
export async function observeWorkingTree(
  args: string[],
  deps: ObserveDeps = {},
  opts: { cwd?: string } = {},
): Promise<ObserveResult> {
  return observeChanges({ refspec: "HEAD", label: "Stop 判定 (a)", logDir: argValue(args, "--log-dir"), cwd: opts.cwd }, deps);
}

async function observeChanges(req: ObserveRequest, deps: ObserveDeps): Promise<ObserveResult> {
  // core.quotePath=false: 既定では非 ASCII パスが "\346..." 形式にクォートされ、
  // 実パスと一致しなくなって touched 検出が漏れる（検出漏れは過検出より危険）
  const git = deps.git ?? ((a: string[], o?: { cwd?: string }) => execFileSync("git", ["-c", "core.quotePath=false", ...a], { encoding: "utf8", cwd: o?.cwd }));
  const gitOpts = req.cwd === undefined ? undefined : { cwd: req.cwd };
  const repoRoot = git(["rev-parse", "--show-toplevel"], gitOpts).trim();
  // 初回 commit 前のリポジトリでは diff のとりようがない。毎回の配線エラー
  // （Stop フックでは hook error が毎ターン続く）にせず「変更なし」扱いにする
  try {
    git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: repoRoot });
  } catch {
    return { summary: skipSummary(req.label, "初回 commit 前で diff（HEAD）が取れない"), skipped: true, judged: [] };
  }
  const root = (rel: string) => `${repoRoot}/${rel}`;

  const changedRel = git(["diff", "--name-only", "--diff-filter=d", req.refspec], { cwd: repoRoot })
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const tsFiles = git(["ls-files", "*.ts"], { cwd: repoRoot })
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(tsFiles.map(root));
  const touched = findTouchedAssertions(project.getSourceFiles(), changedRel.map(root));

  if (touched.length === 0) {
    return {
      summary: skipSummary(req.label, "diff が触れるアサーション定義の使用箇所がない"),
      skipped: true,
      judged: [],
    };
  }

  const evidenceDir = deps.evidenceDir ?? `${repoRoot}/.git/jev-observe`;
  const paths = writeEvidenceFiles(git, repoRoot, evidenceDir, req.refspec, touched);
  const env: Record<string, string> = { JEV_EVIDENCE_ROOT: repoRoot };
  if (req.logDir !== undefined) env.JEV_LOG_DIR = req.logDir;
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
        summary: buildSummary(req.label, touched, judged, `${REQ_ASSERTION_A23.id} は未実行（${REQ_ASSERTION_A1.id} が ${a1Action} / status ${a1.status} のため 2 段判定を停止）`),
        skipped: false,
        judged,
      };
    }
    const a23 = await client.judge({ point: REQ_ASSERTION_A23.id, evidence, opts: { repeats: JUDGE_REPEATS } });
    judged.push(toJudged(REQ_ASSERTION_A23.id, a23));
    return { summary: buildSummary(req.label, touched, judged), skipped: false, judged };
  } finally {
    await client.close();
  }
}

function toJudged(point: string, out: JudgeToolOutput): ObserveJudged {
  return { point, status: out.status, actionKind: out.action.kind, summary: out.summary };
}

function skipSummary(label: string, reason: string): string {
  return [`# jev observe — ${label}（observe 中。実 block なし）`, "", `${reason}ため判定を実行しなかった。`].join("\n");
}

function buildSummary(label: string, touched: TouchedAssertion[], judged: ObserveJudged[], tail?: string): string {
  const ids = [...new Set(touched.map((t) => t.id))];
  const lines = [
    `# jev observe — ${label}（observe 中。実 block なし）`,
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

/**
 * diff 全文・使用箇所一覧（事実のみの機械検出結果）を evidence root 配下に書く。
 * 実行ごとに一意のサブディレクトリ（0700）に置く — 固定名だと jev-stop と
 * jev-observe・複数セッションが同時に走ったとき a1 と a23 の間で別実行が
 * ファイルを差し替え、同一 evidence での多数決・2 段判定が崩れる
 */
function writeEvidenceFiles(
  git: (args: string[], opts?: { cwd?: string }) => string,
  repoRoot: string,
  baseDir: string,
  refspec: string,
  touched: TouchedAssertion[],
): string[] {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  chmodSync(baseDir, 0o700);
  pruneOldRuns(baseDir);
  const evidenceDir = mkdtempSync(`${baseDir}/`);
  chmodSync(evidenceDir, 0o700);
  // diff は repoRoot を cwd にして取る（既定の baseDir は .git 配下。
  // .git 内を cwd にすると worktree 解決が変わるため流用しない）
  const files: { name: string; text: string }[] = [
    { name: "diff.patch", text: git(["diff", refspec], { cwd: repoRoot }) },
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

/** 24 時間より古い実行ディレクトリの掃除。best-effort（競合・失敗は判定に影響させない） */
function pruneOldRuns(baseDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const e of entries) {
    try {
      const p = `${baseDir}/${e}`;
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
    } catch {
      // 他実行が使っている等。無視して続行
    }
  }
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

// bin として直接実行されたときだけ main を動かす（jev-stop がこのモジュールを
// import する。ガードがないと import 時に jev-observe 側の main も argv で走り、
// usage エラーの出力と exitCode 汚染、テストでの実 git 実行が起きる）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
