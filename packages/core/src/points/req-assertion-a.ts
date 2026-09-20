/**
 * PR 判定 (a)「宣言と実装の整合」の判定ポイント（docs/01・#18）。
 *
 * 質問 1（迂回・block）と質問 2・3（整合・warn）は**しきい値が違う**（docs/01:
 * 質問 1 は回答層の既定 true しきい値で block、質問 2・3 は true しきい値 0.6 に
 * 上書きして warn）。しきい値は判定ポイント単位（docs/05）のため、1 ポイントで
 * 質問別しきい値をやると decision 内で生 p を見ることになる（最重要原則 3 違反）。
 * よって docs/01「質問 1 と 2 を混ぜない理由」「2 段判定」のとおり 2 ポイントに
 * 分割する。質問 1 が unknown のとき質問 2・3 に進まない制御は呼び出し側（配線）が
 * action ベースで行う（判定ではなく決定的な配線制御）
 *
 * decision は回答層の verdict だけを見る（docs/05「判定層は決定的に書く」）。
 * reason・note は事実のみ（判定語の断定を書かない）。
 */
import { verdict } from "../thresholds.js";
import type { Action, Answer, Criterion, JudgmentPoint, ResolvedThresholds } from "../types.js";

const bypassCriterion: Criterion = {
  type: "boolean",
  id: "bypass",
  question:
    "この diff は、フィールドに付されたアサーションの制約を実行時に迂回しているか（検証前の値の使用、制約の無効化、検証器のスキップ）",
};

const basisConsistencyCriterion: Criterion = {
  type: "boolean",
  id: "basis-consistency",
  question: "変更後の実装は、アサーションの basis が表す業務上の制約と整合しているか",
};

const inputPathCriterion: Criterion = {
  type: "boolean",
  id: "input-path",
  question: "アサーションに違反しうる入力経路が diff 内に追加されていないか（直に構築されるオブジェクト、キャスト、as any）",
};

/**
 * evidence の base meta（docs/06 のマージ規則: data は呼び出し側の paths が追記する）。
 * 前提の説明のみで判定語を含めない。機械特定の限界も事実として述べる
 * （findAssertionUsages の限界。呼び出し側の evidence に限界を含める — #17 PR 2）
 */
const EVIDENCE_META = [
  {
    title: "判定の前提",
    text: [
      "この判定は PR 判定 (a)（宣言と実装の整合）である。",
      "data には PR の diff、diff が触れたアサーション定義（basis 含む）、使用箇所の機械検出結果が入る。",
      "機械特定は識別子照合ベースであり、エイリアス import（import { X as Y }）経由の使用は検出できない。",
      "同名シンボルが複数ファイルで別定義のとき、id の帰属は定義ファイルまで確定しない。",
    ].join(""),
  },
];

/**
 * 質問 1（迂回検出）。true / false しきい値は回答層の既定（0.75 / 0.25）。
 * minConfidence: null は docs/05 の運用どおり（SDK の noul 応答は confidence を
 * 持たないため、boolean 型 criterion の二値化は p ベースのみ）。
 * 既知限界（docs/05・majority.ts）: minConfidence: null では多数決の「ばらつき大
 * → unknown」が効かず、p の幅 ≥ 0.3 でも下側中央値の p で true/false が確定する
 * （ばらつき大の試行が would_block として計上されうる）。
 * observe: true・gate: reversible で導入検証中は would-block 記録 + pass 返却
 * （docs/05「フェイルオープンと observe」。block 有効化は #19）
 */
export const REQ_ASSERTION_A1: JudgmentPoint = {
  id: "req-assertion-a1",
  criteria: [bypassCriterion],
  thresholds: { minConfidence: null },
  evidence: () => ({ meta: EVIDENCE_META, data: [] }),
  decision: (answers: Record<string, Answer>, th: ResolvedThresholds): Action => {
    const v = verdict(answers[bypassCriterion.id], th);
    if (v === "true") {
      return {
        kind: "block",
        reason: `criterion "${bypassCriterion.id}"（アサーション制約の実行時迂回の有無を問う criterion）が true しきい値を満たした。PR の diff と触れたアサーション定義・使用箇所を人間の確認対象とする`,
      };
    }
    if (v === "unknown") {
      return {
        kind: "escalate",
        question: `criterion "${bypassCriterion.id}" が unknown（中間帯・回答欠落）。アサーション定義の使用箇所を含む diff の整合を確認してください`,
      };
    }
    return { kind: "pass" };
  },
  failMode: "open",
  gate: "reversible",
  observe: true,
};

/**
 * 質問 2（basis との整合）+ 質問 3（入力経路）。true しきい値を 0.6 に上書き
 * （docs/01 しきい値行。falseMax は resolveThresholds が 0.25 に維持）。
 * minConfidence: null は noul 応答の p ベース二値化（上記 A1 と同じ）。
 * block ではなく warn（docs/01: block ではない）。
 * warn 自体が実挙動に影響しないため observe は付けない（docs/05: observe は
 * block 型のみ有効）
 */
export const REQ_ASSERTION_A23: JudgmentPoint = {
  id: "req-assertion-a23",
  criteria: [basisConsistencyCriterion, inputPathCriterion],
  thresholds: { trueMin: 0.6, minConfidence: null },
  evidence: () => ({ meta: EVIDENCE_META, data: [] }),
  decision: (answers: Record<string, Answer>, th: ResolvedThresholds): Action => {
    const trues: string[] = [];
    const unknowns: string[] = [];
    for (const c of [basisConsistencyCriterion, inputPathCriterion]) {
      const v = verdict(answers[c.id], th);
      if (v === "true") trues.push(c.id);
      else if (v === "unknown") unknowns.push(c.id);
    }
    // unknown を先に返す（原則 5: 判断できない criterion を true があったことの
    // 副産物として黙って潰さない。unknown は escalate で人間の確認に乗せる）
    if (unknowns.length > 0) {
      return {
        kind: "escalate",
        question: `unknown または回答欠落の criterion: ${unknowns.join(", ")}。アサーション定義の使用箇所を含む diff の整合を確認してください`,
      };
    }
    if (trues.length > 0) {
      return {
        kind: "warn",
        note: `true しきい値を満たした criterion: ${trues.join(", ")}。アサーション定義の使用箇所を含む diff を人間の確認対象とする（block ではない）`,
      };
    }
    return { kind: "pass" };
  },
  failMode: "open",
};
