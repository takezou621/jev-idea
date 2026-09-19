/**
 * sdk-answers — SDK 応答の検証・正規化（jev-claude の罠リスト継承）。
 * jev-claude jev-lib.mjs fromSdkAnswers の検証規則を jev-core の型に
 * 一般化したもの。ネットワークなし。
 */
import { describe, expect, it } from "vitest";
import { fromSdkAnswers } from "../src/sdk-answers.js";
import type { Criterion } from "../src/types.js";

const COMPLETENESS: Criterion = {
  type: "score",
  id: "completeness",
  question: "完了度",
  rubric: ["未実装", "部分的", "実装済み検証なし", "検証に失敗", "完了"],
};
const BOOLEAN: Criterion = {
  type: "boolean",
  id: "leftoverWork",
  question: "TODO が残っているか",
};
const criteria = [COMPLETENESS, BOOLEAN];

describe("fromSdkAnswers — 検証で不正な回答は落とす（フェイルオープン）", () => {
  it("score の範囲外（-3 / 99 / 非数）は回答ごと欠落にする（敵対テスト由来）", () => {
    for (const score of [-3, 99, Number.NaN, "2"]) {
      const out = fromSdkAnswers(criteria, {
        completeness: { type: "score", score, confidence: 0.9 },
        leftoverWork: { type: "noul", noul: 0.1 },
      });
      expect(out.completeness).toBeUndefined();
      expect(out.leftoverWork).toBeDefined();
    }
  });

  it("noul（boolean）の範囲外（確率 5・-0.1・非数）は回答ごと欠落にする", () => {
    for (const p of [5, -0.1, Number.NaN, "0.9"]) {
      const out = fromSdkAnswers(criteria, {
        completeness: { type: "score", score: 4, confidence: 0.9 },
        leftoverWork: { type: "noul", noul: p },
      });
      expect(out.leftoverWork).toBeUndefined();
      expect(out.completeness).toBeDefined();
    }
  });

  it("confidence が範囲外・非数なら confidence を欠落させる（unknown に倒す）", () => {
    for (const confidence of [1.5, -0.2, "high", Number.NaN]) {
      const out = fromSdkAnswers(criteria, {
        completeness: { type: "score", score: 1, confidence },
        leftoverWork: { type: "noul", noul: 0.9 },
      });
      expect(out.completeness?.confidence).toBeUndefined();
    }
  });

  it("分布の合計が 1 を超える（> 1 + 1e-6）応答は回答ごと捨てる", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: {
        type: "score",
        score: 1,
        confidence: 0.9,
        probabilities: { 0: 0.6, 1: 0.6 },
      },
      leftoverWork: { type: "noul", noul: 0.9 },
    });
    expect(out.completeness).toBeUndefined();
  });

  it("境界 1 + 1e-6 以下の分布は受け入れる", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: {
        type: "score",
        score: 1,
        confidence: 0.9,
        probabilities: { 0: 0.5, 1: 0.5, 2: 1e-9 },
      },
      leftoverWork: { type: "noul", noul: 0.9 },
    });
    expect(out.completeness).toBeDefined();
  });

  it("分布内の非数・範囲外の段だけを除去する", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: {
        type: "score",
        score: 0,
        confidence: 0.9,
        probabilities: { 0: 0.9, 3: 99, 4: "junk" },
      },
      leftoverWork: { type: "noul", noul: 0.9 },
    });
    expect(out.completeness?.distribution).toEqual({ "0": 0.9 });
  });

  it("範囲外の段に質量があっても、有効段の合計が 1 以下なら回答は捨てない（除去→合計の順）", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: {
        type: "score",
        score: 1,
        confidence: 0.9,
        // 生キー合計は 1.1 だが、有効段の合計は 0.9 → 受ける（docs/05: 除去して受け、回答は捨てない）
        probabilities: { 0: 0.5, 1: 0.4, 9: 0.2 },
      },
      leftoverWork: { type: "noul", noul: 0.9 },
    });
    expect(out.completeness?.distribution).toEqual({ "0": 0.5, "0.25": 0.4 });
  });

  it("有効段だけの合計が 1 を超える応答は回答ごと捨てる", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: {
        type: "score",
        score: 1,
        confidence: 0.9,
        probabilities: { 0: 0.6, 1: 0.6, 9: 0.5 },
      },
      leftoverWork: { type: "noul", noul: 0.9 },
    });
    expect(out.completeness).toBeUndefined();
  });

  it("score 型の criterion に noul（boolean）応答が来たら欠落にする（規約外の回答）", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: { type: "noul", noul: 0.9 },
      leftoverWork: { type: "noul", noul: 0.1 },
    });
    expect(out.completeness).toBeUndefined();
    expect(out.leftoverWork).toBeDefined();
  });

  it("応答がオブジェクトでない・未知の type は落とす", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: "broken",
      leftoverWork: { type: "matrix", noul: 0.5 },
      unknown_q: { type: "noul", noul: 0.5 }, // criteria に無い質問は取り込まない
    });
    expect(out).toEqual({});
  });
});

describe("fromSdkAnswers — 正規化（docs/05 の規則）", () => {
  it("score → p_norm = score / (length - 1)、distribution キーは norm 値", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: {
        type: "score",
        score: 3,
        confidence: 0.8,
        probabilities: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.6, 4: 0.1 },
      },
    });
    expect(out.completeness?.p).toBe(0.75);
    expect(out.completeness?.criterion).toBe("completeness");
    // キーの並びは JS の仕様（整数-like キーが先頭）で意味を持たないためソート比較
    expect(Object.keys(out.completeness?.distribution ?? {}).sort()).toEqual([
      "0",
      "0.25",
      "0.5",
      "0.75",
      "1",
    ]);
    expect(out.completeness?.distribution?.["0.75"]).toBeCloseTo(0.6);
  });

  it("noul / probability の両方の確率位置を受ける（経路で揺れる）", () => {
    const out1 = fromSdkAnswers(criteria, { leftoverWork: { type: "noul", noul: 0.7 } });
    const out2 = fromSdkAnswers(criteria, {
      leftoverWork: { type: "boolean", probability: 0.7 },
    });
    expect(out1.leftoverWork?.p).toBe(0.7);
    expect(out2.leftoverWork?.p).toBe(0.7);
    // boolean 型に confidence は付かない（SDK noul が持たないため）
    expect(out1.leftoverWork?.confidence).toBeUndefined();
    expect(out1.leftoverWork?.distribution).toBeUndefined();
  });

  it("score 4 ちょうど（rubric 最大）は p = 1", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: { type: "score", score: 4, confidence: 0.9 },
    });
    expect(out.completeness?.p).toBe(1);
  });

  it("confidence がない応答は confidence を付けない（欠落 = unknown へ）", () => {
    const out = fromSdkAnswers(criteria, {
      completeness: { type: "score", score: 4 },
    });
    expect(out.completeness?.confidence).toBeUndefined();
    expect(out.completeness?.p).toBe(1);
  });
});
