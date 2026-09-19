/**
 * judge() — 判定の実行（docs/05「インターフェース」）。
 *
 * 契約:
 * - 失敗時は例外を投げず status: "failed" を返す。action は failMode に従う
 *   （docs/06 契約: 呼び出し側に failMode の解釈をさせない）
 * - 総予算は budgetMs + AbortSignal で自前管理する（SDK のタイムアウトは
 *   1 試行あたり。AGENTS.md 罠リスト）
 * - 判定の実行と決定は core 内で完結し、ホストには action のみを返す
 *   （最重要原則 2。Judgment.action に p は含まれない）
 */
import { fileSink, toLogEvidence, toReasons, type LogEntry, type LogSink } from "./log.js";
import { fromSdkAnswers } from "./sdk-answers.js";
import { jevProvider } from "./jev-provider.js";
import { resolveThresholds } from "./thresholds.js";
import { evidenceToState } from "./state.js";
import { toSdkQuestions } from "./sdk-questions.js";
import type {
  Action,
  FailMode,
  Judgment,
  JudgmentPoint,
  JudgeProvider,
} from "./types.js";

export type JudgeOptions = {
  /** 総予算タイムアウト（ミリ秒）。超過で status: "failed" */
  budgetMs?: number;
  /** 判定の実行手段。省略時は Jev（@typesafe-ai/sdk）。テストは stub を注入 */
  provider?: JudgeProvider;
  /** ログシンク。false で無効。省略時は fileSink()（~/.jev/logs など） */
  log?: LogSink | false;
  /** ログの分類ラベル（"stop" など。テスト由来は golden- / mj- 接頭辞） */
  label?: string;
  project?: string;
  sessionId?: string;
  /** fileSink の書き込み先上書き（テスト用。opts.log 未指定時のみ有効） */
  logDir?: string;
};

/**
 * Jev 不通時（キー無し・ネットワーク断・タイムアウト・仕様変更）のアクション。
 * - open: 未判定として扱い、フローは続行（既定）
 * - closed: ゲートを閉じる。不可逆操作の前の判定のみに限る（docs/05）
 * - escalate: 人間の確認に乗せる
 * reason / question は事実のみ（エラー詳細はログに残す。生応答本文に p が
 * 含まれうるため、アクションの文言には載せない）
 */
function failureAction(point: JudgmentPoint, failMode: FailMode): Action {
  switch (failMode) {
    case "open":
      return { kind: "pass" };
    case "closed":
      return {
        kind: "block",
        reason: `判定を実行できなかったためゲートを閉じた (point: ${point.id})`,
      };
    case "escalate":
      return {
        kind: "escalate",
        question: `判定ポイント ${point.id} の判定を実行できなかったため、確認してください`,
      };
  }
}

export async function judge(
  point: JudgmentPoint,
  opts: JudgeOptions = {},
): Promise<Judgment> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer =
    opts.budgetMs !== undefined
      ? setTimeout(() => controller.abort(new Error(`budget exceeded (${opts.budgetMs}ms)`)), opts.budgetMs)
      : undefined;
  const sink = opts.log === false ? undefined : opts.log ?? fileSink(opts.logDir);
  // 失敗ログに段階を残す（provider 障害と decision の実装バグを区別する。
  // どちらも failMode 経路ではあるが、後追いの調査には段階が要る）
  let stage = "evidence";

  try {
    const provider = opts.provider ?? jevProvider();
    const evidence = point.evidence();
    const state = evidenceToState(evidence);
    const questions = toSdkQuestions(point.criteria);
    const th = resolveThresholds(point.thresholds);
    const tTry = Date.now();
    stage = "provider";
    const result = await provider({ state, questions, signal: controller.signal });
    const msTry = Date.now() - tTry;
    stage = "decision";

    const answers = fromSdkAnswers(point.criteria, result.answers);
    const action = point.decision(answers, th);
    const msTotal = Date.now() - t0;
    writeLog(sink, {
      at: new Date().toISOString(),
      ...(opts.label === undefined ? {} : { label: opts.label }),
      point_id: point.id,
      ...(opts.project === undefined ? {} : { project: opts.project }),
      ...(opts.sessionId === undefined ? {} : { session_id: opts.sessionId }),
      status: "judged",
      action: action.kind,
      reasons: toReasons(action),
      answers,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.model === undefined ? {} : { model: result.model }),
      ms_total: msTotal,
      ms_try: msTry,
      evidence: toLogEvidence(evidence),
      fail_mode: point.failMode,
    });
    return { status: "judged", answers, action };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const action = failureAction(point, point.failMode);
    writeLog(sink, {
      at: new Date().toISOString(),
      ...(opts.label === undefined ? {} : { label: opts.label }),
      point_id: point.id,
      ...(opts.project === undefined ? {} : { project: opts.project }),
      ...(opts.sessionId === undefined ? {} : { session_id: opts.sessionId }),
      status: "failed",
      action: action.kind,
      reasons: toReasons(action),
      ms_total: Date.now() - t0,
      fail_mode: point.failMode,
      error: `${stage}: ${error.message}`,
    });
    return { status: "failed", error, action };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function writeLog(sink: LogSink | undefined, entry: LogEntry): void {
  if (!sink) return;
  try {
    sink(entry);
  } catch {
    // ログ失敗は判定に影響させない
  }
}
