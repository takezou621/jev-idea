/**
 * DoD 2（Issue #1）: 確定規則のユニットテスト。
 * 正規化・境界値・中間帯・confidence 欠落が docs/05「回答層の確定規則」の
 * 表どおりに動くこと。ネットワークなし（AGENTS.md テスト方針）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  massBelow,
  normScore,
  resolveThresholds,
  verdict,
} from "../src/thresholds.js";
import type { Answer, Thresholds } from "../src/types.js";

const a = (p: number, confidence?: number): Answer => ({
  criterion: "c1",
  p,
  ...(confidence === undefined ? {} : { confidence }),
});

describe("normScore — docs/05「score の正規化」", () => {
  it("p_norm = score / (length - 1)", () => {
    expect(normScore(0, 5)).toBe(0);
    expect(normScore(1, 5)).toBe(0.25);
    expect(normScore(2, 5)).toBe(0.5);
    expect(normScore(3, 5)).toBe(0.75);
    expect(normScore(4, 5)).toBe(1);
    expect(normScore(1, 2)).toBe(1); // 2 段の最大
  });

  it("criteria 1 件（length === 1）のときは 1", () => {
    expect(normScore(0, 1)).toBe(1);
  });
});

describe("verdict — docs/05 の確定規則（初期値しきい値）", () => {
  it("境界値: true は p ≥ 0.75 かつ confidence ≥ 0.5", () => {
    expect(verdict(a(0.75, 0.5))).toBe("true");
    expect(verdict(a(0.76, 0.5))).toBe("true");
    expect(verdict(a(1, 1))).toBe("true");
    expect(verdict(a(0.7499, 0.5))).toBe("unknown"); // p が境界未満
    expect(verdict(a(0.75, 0.4999))).toBe("unknown"); // confidence が境界未満
  });

  it("境界値: false は p ≤ 0.25 かつ confidence ≥ 0.5", () => {
    expect(verdict(a(0.25, 0.5))).toBe("false");
    expect(verdict(a(0, 0.5))).toBe("false");
    expect(verdict(a(0.2501, 0.5))).toBe("unknown"); // 中間帯
    expect(verdict(a(0.25, 0.4999))).toBe("unknown");
  });

  it("中間帯（0.25 < p < 0.75）は confidence があっても unknown", () => {
    expect(verdict(a(0.5, 1))).toBe("unknown");
    expect(verdict(a(0.6, 0.9))).toBe("unknown");
    expect(verdict(a(0.26, 1))).toBe("unknown");
    expect(verdict(a(0.74, 1))).toBe("unknown");
  });

  it("confidence 欠落は常に unknown（docs/05 鉄則。p が明確でも潰さない）", () => {
    expect(verdict(a(1))).toBe("unknown");
    expect(verdict(a(0.99))).toBe("unknown");
    expect(verdict(a(0))).toBe("unknown");
    expect(verdict(a(0.9, NaN))).toBe("unknown");
  });

  it("回答の欠落は unknown", () => {
    expect(verdict(undefined)).toBe("unknown");
  });
});

describe("verdict — しきい値上書き（docs/05「判定ポイントが上書きできる」）", () => {
  it("trueMin / falseMax の上書き（例: docs/01「p > 0.6 で警告」の略記）", () => {
    const th = resolveThresholds({ trueMin: 0.6, falseMax: 0.25 });
    expect(verdict(a(0.6, 0.5), th)).toBe("true");
    expect(verdict(a(0.59, 0.5), th)).toBe("unknown");
    expect(verdict(a(0.25, 0.5), th)).toBe("false");
  });

  it("minConfidence: null で confidence ゲート無効（boolean 型の p ベース二値化）", () => {
    const th = resolveThresholds({ trueMin: 0.6, falseMax: 0.25, minConfidence: null });
    expect(verdict({ criterion: "c", p: 0.9 }, th)).toBe("true");
    expect(verdict({ criterion: "c", p: 0.1 }, th)).toBe("false");
    // boolean は confidence を持たないが、欠落が unknown にならない
    expect(verdict({ criterion: "c", p: 0.6 }, th)).toBe("true");
    // 中間帯は相変わらず unknown
    expect(verdict({ criterion: "c", p: 0.5 }, th)).toBe("unknown");
  });

  it("minConfidence の上書き（score 型の確信ゲート調整）", () => {
    const th = resolveThresholds({ minConfidence: 0.3 });
    expect(verdict(a(0.8, 0.3), th)).toBe("true");
    expect(verdict(a(0.8, 0.29), th)).toBe("unknown");
  });
});

describe("resolveThresholds — 未指定フィールドは既定値", () => {
  it("既定値は docs/05 の初期値", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ trueMin: 0.75, falseMax: 0.25, minConfidence: 0.5 });
  });

  it("部分上書き・undefined スキップ・null 明示の区別", () => {
    expect(resolveThresholds()).toEqual(DEFAULT_THRESHOLDS);
    expect(resolveThresholds({ trueMin: 0.6 })).toEqual({
      trueMin: 0.6,
      falseMax: 0.25,
      minConfidence: 0.5,
    });
    expect(resolveThresholds({ minConfidence: null })).toEqual({
      trueMin: 0.75,
      falseMax: 0.25,
      minConfidence: null,
    });
    // undefined プロパティは「未指定」と同じ扱い（null とは違う）
    const t: Thresholds = { trueMin: undefined, minConfidence: undefined };
    expect(resolveThresholds(t)).toEqual(DEFAULT_THRESHOLDS);
  });

  it("falseMax ≥ trueMin の逆転設定は falseMax = trueMin - 0.05 に強制する（jev-claude の学習継承）", () => {
    // jev-claude verify-done: fth = min(fth, th - 0.05)。p=0.5 が true になる
    // 自壊した設定を静かに通さない（throw にはしない）
    const th = resolveThresholds({ trueMin: 0.3, falseMax: 0.6 });
    expect(th.trueMin).toBe(0.3);
    expect(th.falseMax).toBeCloseTo(0.25);
    // 強制後は trueMin 0.3 > falseMax 0.25 で狭い中間帯が存在する
    expect(verdict(a(0.27, 0.9), th)).toBe("unknown");
    expect(verdict(a(0.2, 0.9), th)).toBe("false");
    expect(verdict(a(0.5, 0.9), th)).toBe("true");
  });

  it("trueMin が 0.05 以下のとき falseMax は 0 で下がらない", () => {
    const th = resolveThresholds({ trueMin: 0.04 });
    expect(th.falseMax).toBe(0);
  });
});

describe("massBelow — score 型の分布集計（jev-claude の pIncomplete の一般化）", () => {
  const withDist = (distribution: Record<string, number>, p = 0.5, confidence = 0.9): Answer => ({
    criterion: "completeness",
    p,
    confidence,
    distribution,
  });

  it("norm がしきい値未満の段の質量を合計する", () => {
    // 5 段 rubric の分布（norm キー: 0, 0.25, 0.5, 0.75, 1）
    const ans = withDist({ "0": 0.13, "0.25": 0.46, "0.5": 0.04, "0.75": 0.19, "1": 0.18 });
    expect(massBelow(ans, 0.6)).toBeCloseTo(0.13 + 0.46 + 0.04);
  });

  it("境界: norm === しきい値の段は含めない（norm < しきい値のみ）", () => {
    const ans = withDist({ "0.5": 0.5, "0.6": 0.5 });
    expect(massBelow(ans, 0.6)).toBeCloseTo(0.5);
  });

  it("合計は 1 で頭打ちする", () => {
    const ans = withDist({ "0": 0.7, "0.25": 0.7 });
    expect(massBelow(ans, 0.6)).toBe(1);
  });

  it("分布が無ければ undefined（集計できない = 確信ゲートは通さない）", () => {
    expect(massBelow(a(0.5, 0.9), 0.6)).toBeUndefined();
    expect(massBelow(undefined, 0.6)).toBeUndefined();
  });

  it("exclude で指定した norm 段を集計から除く（jev-claude の段 2 要否依存の継承）", () => {
    // 5 段 rubric: 段 2「実装済み検証なし」は norm 0.5。検証が不要だった場合は
    // 未完了側に数えない（verify-done.mjs の実ブロック事例 2026-09-18 から）
    const ans = withDist({ "0": 0.2, "0.25": 0.3, "0.5": 0.5 });
    expect(massBelow(ans, 0.6)).toBeCloseTo(1);
    expect(massBelow(ans, 0.6, ["0.5"])).toBeCloseTo(0.5);
  });

  it("非数キー・不正値は無視する", () => {
    const ans = withDist({ "0": 0.3, junk: 0.2, bad: Number.NaN, "0.25": 0.4 });
    expect(massBelow(ans, 0.6)).toBeCloseTo(0.3 + 0.4);
  });

  it("非整数の norm キー（3 段 rubric など）も数値として扱う", () => {
    // 3 段 rubric の norm: 段 1 → 1/2 = 0.5。4 段なら 1/3 = 0.3333…（非整数の繰り返し小数）
    const ans = withDist({
      "0.3333333333333333": 0.5,
      "0.6666666666666666": 0.5,
    });
    expect(massBelow(ans, 0.6)).toBeCloseTo(0.5);
    expect(massBelow(ans, 0.7)).toBeCloseTo(0.5 + 0.5);
  });
});
