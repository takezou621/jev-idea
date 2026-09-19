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
import { majorityAnswers } from "./majority.js";
import { resolveThresholds } from "./thresholds.js";
import { evidenceToState } from "./state.js";
import { toSdkQuestions } from "./sdk-questions.js";
import type {
  Action,
  FailMode,
  Judgment,
  JudgmentPoint,
  JudgeProvider,
  RawSdkAnswer,
} from "./types.js";

export type JudgeOptions = {
  /** 総予算タイムアウト（ミリ秒）。超過で status: "failed" */
  budgetMs?: number;
  /** 多数決 helper の試行回数（docs/05・#3。既定 1 = 多数決なし） */
  repeats?: number;
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
    // 多数決 helper（docs/05・#3）。同一 evidence を repeats 回判定し、
    // criterion ごとに p の幅 ≥ 0.3 なら unknown に倒す（majorityAnswers）。
    // 非有限数（NaN / Infinity / 0 / 負）の指定は設定ミスとして 1 に倒す
    // （0 試行で answers 空の judged を返さない）
    const repeats =
      opts.repeats !== undefined && Number.isFinite(opts.repeats)
        ? Math.max(1, opts.repeats)
        : 1;
    const raws: {
      answers: Record<string, RawSdkAnswer>;
      usage?: { input_tokens: number; output_tokens: number };
      model?: string;
    }[] = [];
    const msTries: number[] = [];
    stage = "provider";
    for (let i = 0; i < repeats; i++) {
      const tTry = Date.now();
      const result = await provider({ state, questions, signal: controller.signal });
      msTries.push(Date.now() - tTry);
      raws.push(result);
    }
    stage = "decision";

    const answers = majorityAnswers(
      point.criteria,
      raws.map((r) => fromSdkAnswers(point.criteria, r.answers)),
    );
    const action = point.decision(answers, th);
    // observe（docs/05「フェイルオープンと observe」・#3）:
    // gate: "reversible" の block 型に限定し、judged 成功時のみ適用する
    // （判定失敗の failMode 経路は would-block ではない）。block を記録して
    // pass を返す — 呼び出し側（フック・CI）の実挙動に影響させない
    let reported = action;
    let wouldBlock: { reason: string } | undefined;
    if (point.observe && point.gate === "reversible" && action.kind === "block") {
      wouldBlock = { reason: action.reason };
      reported = { kind: "pass" };
    }
    // usage は複数試行の総和（あるものだけ加算。全試行に無ければ省略）
    let usageSum: { input_tokens: number; output_tokens: number } | undefined;
    for (const r of raws) {
      if (r.usage === undefined) continue;
      usageSum = {
        input_tokens: (usageSum?.input_tokens ?? 0) + r.usage.input_tokens,
        output_tokens: (usageSum?.output_tokens ?? 0) + r.usage.output_tokens,
      };
    }
    const msTotal = Date.now() - t0;
    writeLog(sink, {
      at: new Date().toISOString(),
      ...(opts.label === undefined ? {} : { label: opts.label }),
      point_id: point.id,
      ...(opts.project === undefined ? {} : { project: opts.project }),
      ...(opts.sessionId === undefined ? {} : { session_id: opts.sessionId }),
      status: "judged",
      action: reported.kind,
      reasons: toReasons(reported),
      answers,
      ...(usageSum === undefined ? {} : { usage: usageSum }),
      ...(raws[raws.length - 1]?.model === undefined
        ? {}
        : { model: raws[raws.length - 1]!.model }),
      ms_total: msTotal,
      ms_try: msTries,
      evidence: toLogEvidence(evidence),
      fail_mode: point.failMode,
      ...(wouldBlock === undefined ? {} : { would_block: wouldBlock }),
    });
    return { status: "judged", answers, action: reported };
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
