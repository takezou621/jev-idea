/**
 * DoD 1（Issue #1）: 互換確認。
 * jev-claude verify-done.mjs の完了判定（isTrue/isFalse・probability・段番号
 * 分布）を、jev-core 経由（fromSdkAnswers → verdict / massBelow → decision）
 * で書き直した版と、合成 answers の境界ケース 28 件で比較する。
 * 同一入力（同一 criteria・同一回答）で同一 decision・同一理由カテゴリ列になること。
 *
 * 範囲判断（PR 本文に明記する内容）:
 * - transcript → state の組立てはアダプタ固有の決定的前処理であり、core には
 *   置かない（設計違反防止）。本テストの互換範囲は「同一 state + 同一 criteria +
 *   同一回答で同一判定・同一ログ形状」まで。transcript 由来 state の実配線は
 *   #18 / #21（MVP 統合）で行う
 * - 理由文の文字列そのものは比較しない。jev-claude の理由文は p を含むが、
 *   jev-mcp の最重要原則 2（p をツール出力に載せない）により、core 経由の
 *   理由文は事実のみにする意図的な差異。比較対象は decision と理由カテゴリ列
 * - しきい値は jev-claude verify-done の実値（true 0.6 / false 0.25 /
 *   minScoreConfidence 0.3 / minIncompleteMass 0.6 / completenessMin 0.6）で比較
 */
import { describe, expect, it } from "vitest";
import { judge } from "../src/judge.js";
import { fromSdkAnswers } from "../src/sdk-answers.js";
import { massBelow, resolveThresholds, verdict } from "../src/thresholds.js";
import type {
  Action,
  Answer,
  Criterion,
  JudgmentPoint,
  JudgeProvider,
} from "../src/types.js";
import type { LogEntry } from "../src/log.js";

// === jev-claude verify-done.mjs の criteria と同構成 ===
const COMPLETENESS: Criterion = {
  type: "score",
  id: "completeness",
  question: "完了度",
  rubric: [
    "何も実装されていない",
    "部分的にしか実装されていない",
    "実装は済んでいるが、必要な検証が行われていない",
    "実装済みだが検証に失敗した箇所や未確認事項が残る",
    "変更は実装・検証済み（その変更に検証が不要な場合も含む）",
  ],
};
const BOOLEAN_IDS = [
  "verificationRan",
  "verificationRequired",
  "leftoverWork",
  "verificationFailed",
  "changesVisible",
  "claimsDone",
] as const;
const CRITERIA: Criterion[] = [
  COMPLETENESS,
  ...BOOLEAN_IDS.map((id): Criterion => ({ type: "boolean", id, question: id })),
];

// === legacy: jev-claude verify-done.mjs 263-360 行の移植（ロジックそのまま） ===
const isTrue = (answer: unknown, threshold = 0.6): boolean | null =>
  typeof (answer as { probability?: unknown })?.probability === "number"
    ? (answer as { probability: number }).probability >= threshold
    : null;
const isFalse = (answer: unknown, threshold = 0.25): boolean =>
  typeof (answer as { probability?: unknown })?.probability === "number"
    ? (answer as { probability: number }).probability <= threshold
    : false;

type LegacyAnswers = Record<string, unknown>;

/** テストケースの入力（確率は boolean、score は段・confidence・段別分布） */
type Case = {
  claimsDone?: number;
  verificationRan?: number;
  verificationRequired?: number;
  leftoverWork?: number;
  verificationFailed?: number;
  changesVisible?: number;
  completeness?: {
    score: number;
    confidence?: number;
    probabilities?: Record<string, number>;
  };
};

function toLegacy(c: Case): LegacyAnswers {
  const out: LegacyAnswers = {};
  for (const id of BOOLEAN_IDS) {
    const p = c[id];
    if (p !== undefined) out[id] = { probability: p };
  }
  if (c.completeness) {
    out.completeness = {
      score: c.completeness.score,
      ...(c.completeness.confidence === undefined ? {} : { confidence: c.completeness.confidence }),
      ...(c.completeness.probabilities === undefined ? {} : { probabilities: c.completeness.probabilities }),
    };
  }
  return out;
}

function toRaw(c: Case): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of BOOLEAN_IDS) {
    const p = c[id];
    if (p !== undefined) out[id] = { type: "noul", noul: p };
  }
  if (c.completeness) {
    out.completeness = {
      type: "score",
      score: c.completeness.score,
      ...(c.completeness.confidence === undefined ? {} : { confidence: c.completeness.confidence }),
      ...(c.completeness.probabilities === undefined ? {} : { probabilities: c.completeness.probabilities }),
    };
  }
  return out;
}

const LEGACY_S = {
  trueThreshold: 0.6,
  falseThreshold: 0.25,
  minScoreConfidence: 0.3,
  minIncompleteMass: 0.6,
  completenessMin: 0.6,
};

/** jev-claude verify-done.mjs の判断部分。category を付けて返す以外は移植元どおり。 */
function legacyStop(a: LegacyAnswers): { decision: "pass" | "block"; categories: string[] } {
  const th = LEGACY_S.trueThreshold;
  const fth = LEGACY_S.falseThreshold;
  const compMin = LEGACY_S.completenessMin;
  const scoreMax = 4;
  const claims = isTrue(a.claimsDone, th);
  const reasons: string[] = [];
  const categories: string[] = [];
  const comp = a.completeness as
    | { score?: number; confidence?: number; probabilities?: Record<string, number> }
    | undefined;
  const rawScore = comp?.score;
  const norm =
    typeof rawScore === "number" && Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= scoreMax
      ? rawScore / scoreMax
      : null;
  const conf = comp?.confidence;
  const probs = comp?.probabilities ?? {};
  const requiredTrue = isTrue(a.verificationRequired, th);
  const requiredLast = Math.min(scoreMax - 1, Math.ceil(compMin * scoreMax - 1e-9) - 1);
  let pIncomplete = 0;
  for (let i = 0; i <= requiredLast; i++) {
    if (i === 2 && !requiredTrue) continue;
    pIncomplete += Number(probs[String(i)]) || 0;
  }
  pIncomplete = Math.min(1, pIncomplete);
  const confident =
    typeof conf === "number" && conf >= LEGACY_S.minScoreConfidence && pIncomplete >= LEGACY_S.minIncompleteMass;

  if (claims) {
    if (norm !== null && norm < compMin && confident) {
      reasons.push("completeness");
      categories.push("completeness");
    }
    if (isTrue(a.verificationRequired, th) && isFalse(a.verificationRan, fth)) {
      reasons.push("verification-ran");
      categories.push("verification-ran");
    }
    if (isTrue(a.leftoverWork, th)) {
      reasons.push("leftover");
      categories.push("leftover");
    }
    if (isTrue(a.verificationFailed, th)) {
      reasons.push("verification-failed");
      categories.push("verification-failed");
    }
    if (isFalse(a.changesVisible, fth)) {
      reasons.push("changes-invisible");
      categories.push("changes-invisible");
    }
  }
  return { decision: reasons.length ? "block" : "pass", categories };
}

// === core: jev-core の回答層で書いた同等の判定ポイント ===
// jev-claude verify-done のしきい値を、回答層しきい値の上書き（docs/05）で表現:
// boolean 型（SDK noul）は confidence を持たないため minConfidence: null。
// score 型の確信ゲート（conf >= 0.3 かつ P(未完了) >= 0.6）は decision 内で
// verdict / massBelow を使って決定的に書く。
// しきい値は point.thresholds に 1 か所だけ定義し、decision は judge が渡す
// 解決済み th を使う（宣言と使用のズレを型で防ぐ）。
const COMPLETION_MIN = 0.6;
const MIN_SCORE_CONFIDENCE = 0.3;
const MIN_INCOMPLETE_MASS = 0.6;
/** 段 2「実装は済んでいるが、必要な検証が行われていない」の norm（rubric 5 段 → 2/4） */
const STAGE_2_NORM = "0.5";

const compatStopPoint: JudgmentPoint = {
  id: "compat-stop",
  criteria: CRITERIA,
  thresholds: { trueMin: 0.6, falseMax: 0.25, minConfidence: null },
  evidence: () => ({ meta: [], data: [{ text: "transcript 由来の生データ" }] }),
  decision: (answers: Record<string, Answer>, th): Action => {
    const isT = (id: string) => verdict(answers[id], th) === "true";
    const isF = (id: string) => verdict(answers[id], th) === "false";
    const categories: string[] = [];
    const reasons: string[] = [];

    if (isT("claimsDone")) {
      const comp = answers.completeness;
      const requiredTrue = isT("verificationRequired");
      // norm < COMPLETION_MIN の段の質量。段 2 は検証が「必要だった」ときだけ
      // 未完了側に数える（verify-done.mjs の実ブロック事例の学習を継承）
      const pIncomplete = requiredTrue
        ? massBelow(comp, COMPLETION_MIN)
        : massBelow(comp, COMPLETION_MIN, [STAGE_2_NORM]);
      const confident =
        typeof comp?.confidence === "number" &&
        comp.confidence >= MIN_SCORE_CONFIDENCE &&
        pIncomplete !== undefined &&
        pIncomplete >= MIN_INCOMPLETE_MASS;

      if (comp !== undefined && comp.p < COMPLETION_MIN && confident) {
        categories.push("completeness");
        reasons.push("completeness: 完了度の回答が完了基準を下回る（未完了側に確率が集中）");
      }
      if (isT("verificationRequired") && isF("verificationRan")) {
        categories.push("verification-ran");
        reasons.push("verification-ran: 検証が要るとの回答がある一方、検証実行の痕跡・実行済みとの回答がない");
      }
      if (isT("leftoverWork")) {
        categories.push("leftover");
        reasons.push("leftover: TODO/スタブが残っているとの回答");
      }
      if (isT("verificationFailed")) {
        categories.push("verification-failed");
        reasons.push("verification-failed: 検証が失敗しているとの回答");
      }
      if (isF("changesVisible")) {
        categories.push("changes-invisible");
        reasons.push("changes-invisible: 主張された変更が作業ツリーにもコミットにも現れていないとの回答");
      }
    }
    return categories.length
      ? { kind: "block", reason: reasons.join(" / ") }
      : { kind: "pass" };
  },
  failMode: "open",
};

// === 境界ケース 28 件（境界・中間帯・欠落・敵対入力・実事例） ===
const CASES: { name: string; c: Case }[] = [
  { name: "完了（score 4・段 4 に集中）は pass", c: { claimsDone: 0.9, completeness: { score: 4, confidence: 0.9, probabilities: { 4: 0.95, 3: 0.05 } } } },
  { name: "完了度 0 に確信（P(未完了)=1）で block", c: { claimsDone: 0.9, completeness: { score: 0, confidence: 0.9, probabilities: { 0: 1 } } } },
  { name: "段 2 集中 + required true は未完了側に数えて block", c: { claimsDone: 0.9, verificationRequired: 0.9, completeness: { score: 2, confidence: 0.9, probabilities: { 2: 0.9, 3: 0.1 } } } },
  { name: "段 2 集中 + required false は数えず pass（検証不要と主張）", c: { claimsDone: 0.9, verificationRequired: 0.1, verificationRan: 0.1, completeness: { score: 2, confidence: 0.9, probabilities: { 2: 0.9, 3: 0.1 } } } },
  { name: "段 2 集中 + required 中間帯（実ブロック事例 2026-09-18）は pass", c: { claimsDone: 0.9, verificationRequired: 0.49, completeness: { score: 2, confidence: 0.68, probabilities: { 2: 0.68, 3: 0.32 } } } },
  { name: "confidence 0.1・散らばった分布は抑止して pass（誤検知事例）", c: { claimsDone: 0.9, completeness: { score: 2, confidence: 0.1, probabilities: { 0: 0.13, 1: 0.46, 2: 0.04, 3: 0.19, 4: 0.18 } } } },
  { name: "検証要 + 実行痕跡なし（ran p=0.2）で block", c: { claimsDone: 0.9, verificationRequired: 0.9, verificationRan: 0.2 } },
  { name: "検証不要なら ran だけでは block しない", c: { claimsDone: 0.9, verificationRequired: 0.1, verificationRan: 0.2 } },
  { name: "required 中間帯なら ran だけでは block しない（!isTrue の継承）", c: { claimsDone: 0.9, verificationRequired: 0.49, verificationRan: 0.2 } },
  { name: "TODO あり（p=0.9）で block", c: { claimsDone: 0.9, leftoverWork: 0.9 } },
  { name: "TODO 中間帯（p=0.5）は pass", c: { claimsDone: 0.9, leftoverWork: 0.5 } },
  { name: "検証失敗（p=0.9）で block", c: { claimsDone: 0.9, verificationFailed: 0.9 } },
  { name: "変更不可視（p=0.1）で block", c: { claimsDone: 0.9, changesVisible: 0.1 } },
  { name: "changesVisible 中間帯（p=0.5）は pass", c: { claimsDone: 0.9, changesVisible: 0.5 } },
  { name: "複数理由は順序を保って block", c: { claimsDone: 0.9, leftoverWork: 0.9, verificationFailed: 0.9 } },
  { name: "claims 欠落は理由を作らず pass", c: {} },
  { name: "claims 中間帯（p=0.5）は理由を作らず pass", c: { claimsDone: 0.5, leftoverWork: 0.9 } },
  { name: "score 範囲外 99 は完了度理由なしで pass", c: { claimsDone: 0.9, completeness: { score: 99, confidence: 0.9, probabilities: { 4: 1 } } } },
  { name: "score 負 -3 は完了度理由なしで pass", c: { claimsDone: 0.9, completeness: { score: -3, confidence: 0.9, probabilities: { 0: 1 } } } },
  { name: "score 1 + 確信 + 未完了側集中で block", c: { claimsDone: 0.9, completeness: { score: 1, confidence: 0.5, probabilities: { 0: 0.2, 1: 0.7, 2: 0.1 } } } },
  { name: "score 1 でも未完了側の質量が閾値未満（0.4 < 0.6）なら抑止して pass", c: { claimsDone: 0.9, completeness: { score: 1, confidence: 0.5, probabilities: { 1: 0.4, 2: 0.1, 3: 0.3, 4: 0.2 } } } },
  { name: "confidence 0.2（< 0.3）なら未完了集中でも抑止して pass", c: { claimsDone: 0.9, completeness: { score: 1, confidence: 0.2, probabilities: { 0: 0.9 } } } },
  { name: "境界: claims/leftover ともに p=0.6 ちょうどは block", c: { claimsDone: 0.6, leftoverWork: 0.6 } },
  { name: "境界: leftover p=0.26 は true にならず pass", c: { claimsDone: 0.6, leftoverWork: 0.26 } },
  { name: "境界: changesVisible p=0.25 ちょうどは false 判定で block", c: { claimsDone: 0.6, changesVisible: 0.25 } },
  { name: "境界: ran p=0.25 ちょうど + required 0.9 で block", c: { claimsDone: 0.6, verificationRequired: 0.9, verificationRan: 0.25 } },
  { name: "分布合計が 1 を超える応答は回答ごと欠落で pass", c: { claimsDone: 0.9, completeness: { score: 4, confidence: 0.9, probabilities: { 0: 0.6, 4: 0.6 } } } },
  { name: "score 3（norm 0.75 ≥ 0.6）のみは pass", c: { claimsDone: 0.9, completeness: { score: 3, confidence: 0.9, probabilities: { 3: 0.9, 4: 0.1 } } } },
];

describe("互換確認: verify-done.mjs の判断ロジック vs jev-core 経由", () => {
  for (const { name, c } of CASES) {
    it(name, () => {
      const legacy = legacyStop(toLegacy(c));
      // 同一回答を jev-core の検証・正規化に通す（provider 応答 → Answer）
      const normalized = fromSdkAnswers(CRITERIA, toRaw(c));
      // judge がやるのと同じ解決を通して decision に渡す（point.thresholds が唯一の定義元）
      const action = compatStopPoint.decision(normalized, resolveThresholds(compatStopPoint.thresholds));
      const coreDecision = action.kind === "pass" ? "pass" : "block";
      const coreCategories =
        action.kind === "block"
          ? action.reason
              .split(" / ")
              .map((r) => r.split(":")[0]!)
          : [];
      expect(coreDecision).toBe(legacy.decision);
      expect(coreCategories).toEqual(legacy.categories);
    });
  }
});

describe("互換確認: state → judge の E2E（ゴールデン由来の state 形状）", () => {
  it("evidence の生データが state に入り、回答が検証・正規化されて decision まで流れる", async () => {
    const states: string[] = [];
    const provider: JudgeProvider = async (req) => {
      states.push(req.state);
      return {
        answers: {
          claimsDone: { type: "noul", noul: 0.9 },
          completeness: { type: "score", score: 1, confidence: 0.9, probabilities: { 0: 0.9 } },
        },
        usage: { input_tokens: 100, output_tokens: 5 },
        model: "stub",
      };
    };
    // verify-done の state に相当する形状（transcript 由来の生テキスト + 事実列）
    const r = await judge(
      {
        ...compatStopPoint,
        evidence: () => ({
          meta: [
            {
              title: "機械検出の事実列",
              text: "git status: clean / git log -1: Add tests / transcript 行数: 120",
              source: "/tmp/fixture/transcript.jsonl",
              sourceTime: "2026-09-19T01:23:45Z",
              command: "node transcript.mjs /tmp/fixture/transcript.jsonl --max 12000",
            },
          ],
          data: [
            {
              title: "transcript（生のまま）",
              text: '["assistant","コード変更とテスト追加が完了しました"]\n["tool_use","Bash","npm test"]',
            },
          ],
        }),
      },
      { provider, log: false },
    );

    expect(r.status).toBe("judged");
    expect(states).toHaveLength(1);
    // 生データが加工されず state に入っている（メタ分離は #2 の境界マーカーで強化）
    expect(states[0]).toContain('["tool_use","Bash","npm test"]');
    expect(states[0]).toContain("機械検出の事実列");
    if (r.status === "judged") {
      expect(r.action.kind).toBe("block");
      expect((r.action as { reason: string }).reason).toContain("completeness");
    }
  });
});

describe("互換確認: ログ形状（jev-claude の log エントリ必須フィールド）", () => {
  it("judge 経由のログに jev-claude と対応する必須フィールドが揃う", async () => {
    const entries: LogEntry[] = [];
    const provider: JudgeProvider = async () => ({
      answers: { claimsDone: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    await judge(compatStopPoint, {
      provider,
      log: (e) => entries.push(e),
      label: "stop",
      project: "compat",
      sessionId: "compat-session",
    });
    const e = entries[0]!;
    // jev-claude: { label, project, session_id, decision, reasons, answers, ms, costUsd }
    // jev-core : label / project / session_id / action / reasons / answers /
    //            ms_total + ms_try / usage（コスト換算は省きトークン数を記録）
    for (const key of [
      "label",
      "project",
      "session_id",
      "status",
      "action",
      "reasons",
      "answers",
      "ms_total",
      "ms_try",
      "usage",
      "evidence",
      "point_id",
      "at",
    ] as const) {
      expect(e, `ログに ${key} が無い`).toHaveProperty(key);
    }
    expect(e.status).toBe("judged");
    expect(e.action).toBe("pass");
  });
});
