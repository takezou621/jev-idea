/**
 * judge ツール（docs/06「jev-judge のツール契約」・#5）。
 *
 * 入力 {point, evidence, opts} → 出力 {status, action, summary}。
 * - p・confidence・answers は出力のどこにも載せない（最重要原則 2）。
 *   summary は宣言済み criterion の verdict（true/false/unknown）と action のみ
 * - 呼び出し evidence は paths が基本（サーバーが読む。転写ミスと機密の
 *   二次送出を断つ）。inline は 1 セクション 4KB 上限の小さいもののみ
 * - 入力不正（未知 point・不正 evidence・不正 opts）は isError の結果。
 *   judge の失敗は isError を立てず status: "failed" + failMode に従う action
 *   （docs/06 契約どおりの結果。ホストはフローを止めない）
 * - label "mcp" でログ記録（review レポートで mcp グループに分離される）
 */
import { readFileSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { judge } from "../judge.js";
import { resolveThresholds, verdict } from "../thresholds.js";
import type { Evidence, Judgment, JudgmentPoint, JudgeProvider, Section } from "../types.js";
import type { ToolCallResult, ToolDef } from "./protocol.js";

export const JUDGE_TOOL_NAME = "judge";

/** inline は小さいもののみ（docs/06 原則 3）。1 セクションの上限文字数 */
export const INLINE_MAX_CHARS = 4096;

/** paths 1 ファイルの上限バイト数。判定対象の生データ（transcript 等）としては十分大きい */
export const PATHS_MAX_BYTES = 1048576;

/** opts 未指定時の総予算（ミリ秒）。ツール境界で既定を設け、1 件の遅い判定が stdio ループを専有しない */
export const DEFAULT_BUDGET_MS = 120000;

/** repeats の上限 */
export const MAX_REPEATS = 5;

export type JevJudgeDeps = {
  points: readonly JudgmentPoint[];
  /** テスト注入用。省略時は judge 内で jevProvider()（TYPESAFE_API_KEY / BASE_URL） */
  provider?: JudgeProvider;
  /** fileSink の書き込み先上書き（テスト用） */
  logDir?: string;
  log?: import("../log.js").LogSink | false;
  /** paths で読めるルート（docs/06 原則 3 の「リポジトリ内のパス」）。既定は JEV_EVIDENCE_ROOT ?? サーバーの cwd */
  evidenceRoot?: string;
};

export type JudgeToolInput = {
  point?: unknown;
  evidence?: unknown;
  opts?: unknown;
};

function inputError(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function textResult(output: unknown): ToolCallResult {
  const text = JSON.stringify(output);
  return { content: [{ type: "text", text }], structuredContent: output };
}

/**
 * 呼び出し evidence の読み込み（docs/06 原則 3）。paths はサーバー側で読んで
 * data セクションにする（生のまま。source にパスと mtime を残す）。読めるのは
 * evidence root 配下（symlink 実体で判定）で、1 ファイルの上限バイト数も設ける
 * —— ホスト LLM 指定の任意パスから機密（.env・~/.ssh 等）を読み外部 API に
 * 送出する経路を閉じる。meta は呼び出し側から受け取らない（meta の組立ては
 * point 定義のみ）
 */
function evidenceRootReal(explicit?: string): string {
  const root = explicit ?? process.env.JEV_EVIDENCE_ROOT ?? process.cwd();
  try {
    const real = realpathSync(root);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new Error(`evidence root is not a readable directory: ${root}`);
  }
}

function loadCallerEvidence(ev: unknown, root: () => string): Evidence {
  if (ev === undefined) return { meta: [], data: [] };
  if (typeof ev !== "object" || ev === null) throw new Error("evidence must be an object");
  const { kind, paths, inline } = ev as Record<string, unknown>;
  const data: Section[] = [];
  if (kind === "paths") {
    if (!Array.isArray(paths)) throw new Error("evidence.paths must be an array of strings");
    const rootReal = root();
    for (const p of paths) {
      if (typeof p !== "string" || p.length === 0) throw new Error("evidence.paths must be an array of non-empty strings");
      let real: string;
      let st;
      try {
        real = realpathSync(resolve(p));
        st = statSync(real);
      } catch {
        throw new Error(`evidence path not found: ${p}`);
      }
      if (!st.isFile()) throw new Error(`evidence path is not a file: ${p}`);
      const rel = relative(rootReal, real);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`evidence path outside allowed root (${rootReal}): ${p}`);
      }
      if (st.size > PATHS_MAX_BYTES) {
        throw new Error(`evidence file exceeds ${PATHS_MAX_BYTES} bytes: ${p}`);
      }
      data.push({ text: readFileSync(real, "utf8"), source: p, sourceTime: st.mtime.toISOString() });
    }
    return { meta: [], data };
  }
  if (kind === "inline") {
    if (!Array.isArray(inline)) throw new Error("evidence.inline must be an array of {title?, text}");
    for (const s of inline) {
      if (typeof s !== "object" || s === null) throw new Error("evidence.inline must be an array of {title?, text}");
      const { title, text } = s as Record<string, unknown>;
      if (typeof text !== "string") throw new Error("evidence.inline[].text must be a string");
      if (text.length > INLINE_MAX_CHARS) {
        throw new Error(`evidence.inline[].text exceeds ${INLINE_MAX_CHARS} chars (got: ${text.length})`);
      }
      data.push({
        text,
        source: "inline",
        ...(typeof title === "string" ? { title } : {}),
      });
    }
    return { meta: [], data };
  }
  throw new Error(`evidence.kind must be "paths" | "inline" (got: ${String(kind)})`);
}

function parseOpts(opts: unknown): { budgetMs?: number; repeats?: number } {
  if (opts === undefined) return {};
  if (typeof opts !== "object" || opts === null) throw new Error("opts must be an object");
  const { budgetMs, repeats } = opts as Record<string, unknown>;
  const out: { budgetMs?: number; repeats?: number } = {};
  if (budgetMs !== undefined) {
    if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new Error("opts.budgetMs must be a positive finite number");
    }
    out.budgetMs = budgetMs;
  }
  if (repeats !== undefined) {
    if (typeof repeats !== "number" || !Number.isInteger(repeats) || repeats < 1) {
      throw new Error("opts.repeats must be an integer >= 1");
    }
    if (repeats > MAX_REPEATS) throw new Error(`opts.repeats must be <= ${MAX_REPEATS}`);
    out.repeats = repeats;
  }
  return out;
}

/** summary は verdict と action のみ。p・confidence・回答の中身は出ない */
function summarize(point: JudgmentPoint, j: Judgment): string {
  if (j.status === "failed") {
    // エラー本文は出さない（生応答本文に p・confidence・answers が混入しうる。
    // 全文は判定ログ 0700/0600 で人間のみが見る — docs/05・06）
    return `${point.id}: 判定に失敗 (詳細は判定ログを参照)。failMode ${point.failMode} に従い ${j.action.kind} を返す`;
  }
  const th = resolveThresholds(point.thresholds);
  const vs = point.criteria.map((c) => `${c.id}=${verdict(j.answers[c.id], th)}`).join(", ");
  return `${point.id}: ${vs} → ${j.action.kind}`;
}

export function judgeTool(deps: JevJudgeDeps): { tool: ToolDef; call: (args: unknown) => Promise<ToolCallResult> } {
  const known = [...deps.points].map((p) => p.id).sort();
  const tool: ToolDef = {
    name: JUDGE_TOOL_NAME,
    description:
      "登録済み判定ポイント（JudgmentPoint）を実行し、アクション（pass / block / warn / escalate）のみを返す。" +
      "確率 p は返さない（返り値の action に従うこと）。evidence は paths 参照が基本。" +
      `known points: ${known.join(", ")}`,
    inputSchema: {
      type: "object",
      required: ["point"],
      properties: {
        point: { type: "string", description: "登録済み JudgmentPoint の id" },
        evidence: {
          type: "object",
          description: "判定対象データ。paths が基本（サーバーが読む。evidence root 配下のみ）。inline は 1 セクション 4KB 上限",
          properties: {
            kind: { enum: ["paths", "inline"] },
            paths: { type: "array", items: { type: "string" } },
            inline: {
              type: "array",
              items: {
                type: "object",
                required: ["text"],
                properties: { title: { type: "string" }, text: { type: "string" } },
              },
            },
          },
        },
        opts: {
          type: "object",
          properties: {
            budgetMs: { type: "number", description: "総予算（ミリ秒・既定 120000）" },
            repeats: { type: "number", description: "多数決の試行回数（既定 1・上限 5）" },
          },
        },
      },
    },
  };

  const call = async (args: unknown): Promise<ToolCallResult> => {
    if (typeof args !== "object" || args === null) return inputError("arguments must be an object");
    const { point, evidence, opts } = args as JudgeToolInput;
    if (typeof point !== "string" || point.length === 0) return inputError("point must be a non-empty string");
    const def = deps.points.find((p) => p.id === point);
    if (!def) return inputError(`unknown point: ${point} (known: ${known.join(", ")})`);
    try {
      // judge は point.evidence() を呼ぶため、呼び出し evidence を data に追記した
      // point に差し替える（meta は point 定義のみ。docs/06 原則 3）
      const base = def.evidence();
      const caller = loadCallerEvidence(evidence, () => evidenceRootReal(deps.evidenceRoot));
      const wired: JudgmentPoint = { ...def, evidence: () => ({ meta: base.meta, data: [...base.data, ...caller.data] }) };
      const opts2 = parseOpts(opts);
      const j = await judge(wired, {
        // ツール境界で既定予算を設ける（指定がなければ 1 件の遅い判定が
        // stdio ループ全体を専有する）
        budgetMs: opts2.budgetMs ?? DEFAULT_BUDGET_MS,
        ...(opts2.repeats === undefined ? {} : { repeats: opts2.repeats }),
        ...(deps.provider === undefined ? {} : { provider: deps.provider }),
        // log が指定されたらそれを優先（false で無効）。logDir 単独のときは
        // judge の fileSink(logDir) 経路に流す
        ...(deps.log !== undefined ? { log: deps.log } : deps.logDir !== undefined ? { logDir: deps.logDir } : {}),
        label: "mcp",
      });
      return textResult({ status: j.status, action: j.action, summary: summarize(def, j) });
    } catch (err) {
      // 入力不正（evidence・opts の検証）とテスト注入以外の予期しない失敗
      return inputError(err instanceof Error ? err.message : String(err));
    }
  };

  return { tool, call };
}
