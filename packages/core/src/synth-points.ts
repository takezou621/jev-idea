/**
 * 合成ゴールデン用の判定ポイント（#4）。
 *
 * closed ゲートの導入検証は本番データで行わない（docs/05「フェイルオープンと
 * observe」）。このポイント群は合成 evidence + 合成応答での回帰専用で、
 * 実データ・実運用には使わない。decision は回答層の verdict だけを見る
 * 最小形（docs/05「判定層は決定的に書く」）。
 */
import { verdict } from "./thresholds.js";
import type { Action, Answer, Criterion, JudgmentPoint, ResolvedThresholds } from "./types.js";

const completionCriterion: Criterion = {
  type: "score",
  id: "completion",
  question: "タスクは完了しているか",
  rubric: ["未完了", "一部完了", "完了"],
};

const bypassCriterion: Criterion = {
  type: "boolean",
  id: "bypass",
  question: "検証を迂回する経路があるか",
};

/** 1 件でも false verdict があれば block、unknown があれば escalate、すべて true なら pass */
function synthDecision(answers: Record<string, Answer>, th: ResolvedThresholds): Action {
  const falses: string[] = [];
  let unknown = false;
  for (const [id, a] of Object.entries(answers)) {
    const v = verdict(a, th);
    if (v === "false") falses.push(id);
    else if (v === "unknown") unknown = true;
  }
  if (falses.length > 0) {
    return { kind: "block", reason: `false しきい値を満たした criterion: ${falses.join(", ")}` };
  }
  if (unknown) {
    return { kind: "escalate", question: "unknown または回答欠落の criterion がある。確認してください" };
  }
  return { kind: "pass" };
}

export const SYNTH_POINTS: readonly JudgmentPoint[] = [
  {
    id: "synth-closed",
    criteria: [completionCriterion],
    evidence: () => ({ meta: [], data: [] }),
    decision: synthDecision,
    failMode: "closed",
    gate: "irreversible",
  },
  {
    id: "synth-observe",
    criteria: [completionCriterion],
    evidence: () => ({ meta: [], data: [] }),
    decision: synthDecision,
    failMode: "open",
    gate: "reversible",
    observe: true,
  },
  {
    id: "synth-open",
    criteria: [completionCriterion],
    evidence: () => ({ meta: [], data: [] }),
    decision: synthDecision,
    failMode: "open",
  },
  {
    id: "synth-boolean",
    criteria: [bypassCriterion],
    thresholds: { minConfidence: null },
    evidence: () => ({ meta: [], data: [] }),
    decision: synthDecision,
    failMode: "open",
  },
];
