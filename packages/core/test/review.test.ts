/**
 * review コマンドのロジック（docs/05「ログ・ゴールデン・tp/fp 分類」・#4 DoD 2・3）。
 * - block / would-block のログだけが分類対象、ref は "jev-YYYY-MM-DD.jsonl:<行番号>"
 * - 分類は**追記・後勝ち**（覆した経過も reviews.jsonl に残る）
 * - golden- / mj- 接頭辞は実運用と分けて数える、tp/fp 表は point 別
 * - review の 1 サイクル（判定 → 人間分類 → ゴールデン化 → 回帰緑）が一巡する
 * 実 API を叩かない（stub provider — AGENTS.md テスト方針）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  labelPrefix,
  loadClassifications,
  loadReviewTargets,
  normalizeSince,
  recordClassification,
  reviewReport,
} from "../src/review.js";
import { createGoldenCase, loadGoldenCases, runGolden } from "../src/golden.js";
import { judge } from "../src/judge.js";
import { SYNTH_POINTS } from "../src/synth-points.js";
import type { LogEntry } from "../src/log.js";

function entryJson(overrides: Partial<LogEntry> & { point_id: string }): string {
  return JSON.stringify({
    at: "2026-09-19T00:00:00.000Z",
    status: "judged",
    action: "pass",
    reasons: [],
    ms_total: 1,
    fail_mode: "open",
    ...overrides,
  });
}

function entry(overrides: Partial<LogEntry> & { point_id: string }): LogEntry {
  return JSON.parse(entryJson(overrides)) as LogEntry;
}

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function writeLog(dir: string, name: string, lines: string[]): void {
  writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
}

describe("loadReviewTargets — 分類対象と ref", () => {
  it("block と would-block のログだけが分類対象（pass のみは対象外）。ref はファイル名:行番号", () => {
    const dir = tempDir("jev-review-targets-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      entryJson({ point_id: "synth-open", action: "pass" }),
      entryJson({
        point_id: "synth-observe",
        action: "pass",
        would_block: { reason: "false しきい値を満たした criterion: completion" },
      }),
      entryJson({ point_id: "synth-closed", action: "block", reasons: ["ゲートを閉じた (point: synth-closed)"] }),
    ]);
    const targets = loadReviewTargets(dir);
    expect(targets.map((t) => t.entry.point_id)).toEqual(["synth-observe", "synth-closed"]);
    expect(targets.map((t) => t.ref)).toEqual(["jev-2026-09-19.jsonl:2", "jev-2026-09-19.jsonl:3"]);
  });

  it("走査順はファイル名ソート・行番号順で決定的（連番が一意に対応する）", () => {
    const dir = tempDir("jev-review-order-");
    writeLog(dir, "jev-2026-09-17.jsonl", [entryJson({ point_id: "p-a", action: "block", reasons: ["r1"] })]);
    writeLog(dir, "jev-2026-09-18.jsonl", [
      entryJson({ point_id: "p-b", action: "block", reasons: ["r2"] }),
      entryJson({ point_id: "p-c", action: "block", reasons: ["r3"] }),
    ]);
    const targets = loadReviewTargets(dir);
    expect(targets.map((t) => t.ref)).toEqual([
      "jev-2026-09-17.jsonl:1",
      "jev-2026-09-18.jsonl:1",
      "jev-2026-09-18.jsonl:2",
    ]);
  });

  it("壊れたログ行は分類対象にせずスキップする（review を止めない）", () => {
    const dir = tempDir("jev-review-broken-");
    writeLog(dir, "jev-2026-09-19.jsonl", ["not json", entryJson({ point_id: "synth-open", action: "block", reasons: ["r"] })]);
    const targets = loadReviewTargets(dir);
    expect(targets.map((t) => t.ref)).toEqual(["jev-2026-09-19.jsonl:2"]);
  });

  it("status: failed の failMode 経路（closed のゲート閉鎖など）は分類対象外 — 判定の正誤ではなく故障", () => {
    const dir = tempDir("jev-review-failed-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      entryJson({
        point_id: "synth-closed",
        status: "failed",
        action: "block",
        reasons: ["判定を実行できなかったためゲートを閉じた (point: synth-closed)"],
        fail_mode: "closed",
        error: "provider: boom",
      }),
      entryJson({ point_id: "synth-open", status: "failed", action: "pass", fail_mode: "open" }),
    ]);
    expect(loadReviewTargets(dir)).toHaveLength(0);
  });
});

describe("recordClassification / loadClassifications — 追記・後勝ち", () => {
  const dir = tempDir("jev-review-classify-");

  it("tp → fp の覆しで fp が有効になり、経過は reviews.jsonl に残る", () => {
    const ref = "jev-2026-09-19.jsonl:2";
    recordClassification(dir, ref, "tp");
    recordClassification(dir, ref, "fp", "reason に判定語が入っていた");
    const latest = loadClassifications(dir);
    expect(latest.get(ref)?.classification).toBe("fp");
    expect(latest.get(ref)?.note).toBe("reason に判定語が入っていた");
    // 追記のみ — 覆した経過が残る（docs/05「追記・後勝ち」）
    const lines = readFileSync(join(dir, "reviews.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("分類していない ref は未分類（Map に載らない）", () => {
    expect(loadClassifications(dir).get("jev-2026-09-19.jsonl:3")).toBeUndefined();
  });

  it("reviews.jsonl の壊れた行は行番号付きで拒否する（黙ってスキップすると tp のはずの分類が消えたように見える）", () => {
    const dir = tempDir("jev-review-broken-cls-");
    writeFileSync(join(dir, "reviews.jsonl"), "not json\n");
    expect(() => loadClassifications(dir)).toThrow(/reviews\.jsonl:1: invalid JSON/);
  });

  it("ref 欠落・classification 不正の行も行番号付きで拒否する", () => {
    const dir = tempDir("jev-review-bad-cls-");
    writeFileSync(join(dir, "reviews.jsonl"), `${JSON.stringify({ at: "t", classification: "tp" })}\n`);
    expect(() => loadClassifications(dir)).toThrow(/reviews\.jsonl:1: ref must be a non-empty string/);
  });

  it("classification が tp|fp|unclear 以外の行も行番号付きで拒否する", () => {
    const dir = tempDir("jev-review-bad-cls-");
    writeFileSync(join(dir, "reviews.jsonl"), `${JSON.stringify({ at: "t", ref: "x.jsonl:1", classification: "maybe" })}\n`);
    expect(() => loadClassifications(dir)).toThrow(/reviews\.jsonl:1: classification must be tp\|fp\|unclear/);
  });
});

describe("reviewReport — 分離集計と tp/fp 表", () => {
  it("labelPrefix: golden- / mj- 接頭辞と接頭辞なし（production）を分ける", () => {
    expect(labelPrefix(entry({ point_id: "p", label: "golden-synth-open/x" }))).toBe("golden");
    expect(labelPrefix(entry({ point_id: "p", label: "mj-observe" }))).toBe("mj");
    // 接頭辞を持たない label（"stop" など実運用）も label なしも production グループ
    expect(labelPrefix(entry({ point_id: "p", label: "stop" }))).toBe("production");
    expect(labelPrefix(entry({ point_id: "p" }))).toBe("production");
  });

  it("golden- / mj- は実運用（接頭辞なし）と分けて数え、tp/fp 表が point 別に出る", () => {
    const dir = tempDir("jev-review-report-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      entryJson({ point_id: "synth-observe", action: "block", reasons: ["r1"] }),
      entryJson({ point_id: "synth-observe", action: "pass", would_block: { reason: "r2" } }),
      entryJson({ point_id: "synth-closed", action: "block", reasons: ["r3"], label: "golden-synth-closed/x" }),
      entryJson({ point_id: "synth-observe", action: "block", reasons: ["r4"], label: "mj-observe" }),
    ]);
    // ref は走査順（1..4）。1 を tp、2 を tp、3 を fp に。4（mj）と 2 のうち別 ref は未分類のまま
    recordClassification(dir, "jev-2026-09-19.jsonl:1", "tp");
    recordClassification(dir, "jev-2026-09-19.jsonl:2", "tp", "本来 block が正しい");
    recordClassification(dir, "jev-2026-09-19.jsonl:3", "fp");

    const report = reviewReport(dir);
    expect(report.by_prefix.map((r) => r.prefix)).toEqual(["golden", "mj", "production"]);
    expect(report.by_prefix.find((r) => r.prefix === "production")?.counts).toEqual({
      total: 2,
      unclassified: 0,
      tp: 2,
      fp: 0,
      unclear: 0,
    });
    expect(report.by_prefix.find((r) => r.prefix === "golden")?.counts).toEqual({
      total: 1,
      unclassified: 0,
      tp: 0,
      fp: 1,
      unclear: 0,
    });
    expect(report.by_prefix.find((r) => r.prefix === "mj")?.counts).toEqual({
      total: 1,
      unclassified: 1,
      tp: 0,
      fp: 0,
      unclear: 0,
    });
    // tp/fp 表（point 別）
    expect(report.by_point).toEqual([
      { point_id: "synth-closed", counts: { total: 1, unclassified: 0, tp: 0, fp: 1, unclear: 0 } },
      { point_id: "synth-observe", counts: { total: 3, unclassified: 1, tp: 2, fp: 0, unclear: 0 } },
    ]);
  });
});

describe("feeling — 体感タグ（#28。docs/07 R3: ok=納得 / annoy=邪魔 / ignore=無関心）", () => {
  it("feeling 付きで分類すると reviews.jsonl のレコードに feeling が残る", () => {
    const dir = tempDir("jev-review-feeling-");
    recordClassification(dir, "jev-2026-09-19.jsonl:1", "tp", "迂回は事実として検出", "annoy");
    const rec = loadClassifications(dir).get("jev-2026-09-19.jsonl:1");
    expect(rec?.classification).toBe("tp");
    expect(rec?.note).toBe("迂回は事実として検出");
    expect(rec?.feeling).toBe("annoy");
  });

  it("feeling 未指定の再分類では前の feeling を引き継ぐ（classification とメモは後勝ちのまま）", () => {
    const dir = tempDir("jev-review-feeling-inherit-");
    const ref = "jev-2026-09-19.jsonl:2";
    recordClassification(dir, ref, "tp", "まず tp で記録", "ok");
    recordClassification(dir, ref, "fp", "やはり false positive だった");
    const rec = loadClassifications(dir).get(ref);
    expect(rec?.classification).toBe("fp");
    expect(rec?.note).toBe("やはり false positive だった");
    expect(rec?.feeling).toBe("ok");
  });

  it("feeling 指定ありの再分類は上書きする", () => {
    const dir = tempDir("jev-review-feeling-overwrite-");
    const ref = "jev-2026-09-19.jsonl:3";
    recordClassification(dir, ref, "tp", undefined, "annoy");
    recordClassification(dir, ref, "tp", undefined, "ok");
    expect(loadClassifications(dir).get(ref)?.feeling).toBe("ok");
  });

  it("feeling が ok|annoy|ignore 以外の行は行番号付きで拒否する（黙って無視すると集計から消える）", () => {
    const dir = tempDir("jev-review-bad-feeling-");
    writeFileSync(
      join(dir, "reviews.jsonl"),
      `${JSON.stringify({ at: "t", ref: "x.jsonl:1", classification: "tp", feeling: "meh" })}\n`,
    );
    expect(() => loadClassifications(dir)).toThrow(/reviews\.jsonl:1: feeling must be ok\|annoy\|ignore/);
  });

  it("JSON オブジェクトでない行（null・文字列）も行番号付きで拒否する（r.ref 参照の TypeError にしない）", () => {
    const dir = tempDir("jev-review-non-object-");
    writeFileSync(join(dir, "reviews.jsonl"), "null\n\"x\"\n");
    expect(() => loadClassifications(dir)).toThrow(/reviews\.jsonl:1: record must be a JSON object/);
    const ok = JSON.stringify({ at: "t", ref: "x.jsonl:1", classification: "tp" });
    writeFileSync(join(dir, "reviews.jsonl"), `${ok}\n1\n`);
    expect(() => loadClassifications(dir)).toThrow(/reviews\.jsonl:2: record must be a JSON object/);
  });
});

describe("reviewReport — feeling 内訳（#28 週次サマリ。「邪魔」割合の素材）", () => {
  it("by_prefix に feeling 内訳（ok / annoy / ignore / 未記録）が付く。テスト由来は分離したまま", () => {
    const dir = tempDir("jev-review-feeling-report-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      entryJson({ point_id: "req-assertion-a1", action: "pass", would_block: { reason: "r1" } }),
      entryJson({ point_id: "req-assertion-a1", action: "pass", would_block: { reason: "r2" } }),
      entryJson({ point_id: "req-assertion-a1", action: "pass", would_block: { reason: "r3" }, label: "mj-x" }),
      entryJson({ point_id: "req-assertion-a23", action: "pass", would_block: { reason: "r4" } }),
    ]);
    recordClassification(dir, "jev-2026-09-19.jsonl:1", "tp", undefined, "annoy");
    recordClassification(dir, "jev-2026-09-19.jsonl:2", "fp"); // 分類済みだが feeling 未記録
    recordClassification(dir, "jev-2026-09-19.jsonl:3", "tp", undefined, "ok");
    // :4 は分類レコード自体が未作成（未分類）

    const report = reviewReport(dir);
    expect(report.by_prefix.find((r) => r.prefix === "production")?.feelings).toEqual({
      ok: 0,
      annoy: 1,
      ignore: 0,
      // feeling 未記録の分類済み（:2）と未分類（:4）の両方が unrecorded
      unrecorded: 2,
    });
    expect(report.by_prefix.find((r) => r.prefix === "mj")?.feelings).toEqual({
      ok: 1,
      annoy: 0,
      ignore: 0,
      unrecorded: 0,
    });
  });

  it("by_point は tp/fp 表のみで feeling を含めない（週次サマリの内訳は prefix 別に限定）", () => {
    const dir = tempDir("jev-review-feeling-by-point-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      entryJson({ point_id: "req-assertion-a1", action: "pass", would_block: { reason: "r1" } }),
    ]);
    recordClassification(dir, "jev-2026-09-19.jsonl:1", "tp", undefined, "annoy");
    const report = reviewReport(dir);
    expect(report.by_point).toEqual([
      {
        point_id: "req-assertion-a1",
        counts: { total: 1, unclassified: 0, tp: 1, fp: 0, unclear: 0 },
      },
    ]);
  });
});

describe("reviewReport — latency 集計（#28 週次サマリ。docs/07 R2 の素材）", () => {
  it("全エントリ（would-block 対象外・failed 含む）の ms_total で judged/failed 数と p50/p95/max を出す（最近傍ランク法）", () => {
    const dir = tempDir("jev-review-latency-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 300 }), // 分類対象外も分布に入る
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 100 }),
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 400 }),
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 200 }),
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 1000 }),
      entryJson({ point_id: "synth-closed", status: "failed", action: "block", ms_total: 5000, fail_mode: "closed" }),
    ]);
    // ソート済み ms: [100, 200, 300, 400, 1000, 5000]（N=6）
    //   p50 = ceil(0.50*6) = 3 番目 = 300 / p95 = ceil(0.95*6) = 6 番目 = 5000
    const report = reviewReport(dir);
    expect(report.latency).toEqual([
      {
        prefix: "production",
        stats: { judged: 5, failed: 1, p50_ms: 300, p95_ms: 5000, max_ms: 5000 },
      },
    ]);
  });

  it("golden- 等のテスト由来は production と分けて数える（by_prefix と同じ分離）", () => {
    const dir = tempDir("jev-review-latency-prefix-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 700 }),
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 10, label: "golden-synth-open/x" }),
    ]);
    const report = reviewReport(dir);
    expect(report.latency).toEqual([
      { prefix: "golden", stats: { judged: 1, failed: 0, p50_ms: 10, p95_ms: 10, max_ms: 10 } },
      { prefix: "production", stats: { judged: 1, failed: 0, p50_ms: 700, p95_ms: 700, max_ms: 700 } },
    ]);
  });

  it("ログがない（空のディレクトリ・未作成）は latency 空配列。件数 0 でパーセンタイルを捏造しない", () => {
    const dir = tempDir("jev-review-latency-empty-");
    expect(reviewReport(dir).latency).toEqual([]);
    expect(reviewReport(join(dir, "not-exist")).latency).toEqual([]);
  });

  it("JSON としては有効でもオブジェクトでない行（null・数値・配列）はスキップ — クラッシュも latency の失敗数汚染もしない", () => {
    const dir = tempDir("jev-review-latency-nonobject-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      "null",
      "42",
      "[1,2]",
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 100 }),
    ]);
    const report = reviewReport(dir);
    expect(report.latency).toEqual([
      { prefix: "production", stats: { judged: 1, failed: 0, p50_ms: 100, p95_ms: 100, max_ms: 100 } },
    ]);
    expect(loadReviewTargets(dir)).toHaveLength(0);
  });

  it("ms_total 欠落・非数値のエントリは judged/failed には数えるが分布からは除外する", () => {
    const dir = tempDir("jev-review-latency-no-ms-");
    writeLog(dir, "jev-2026-09-19.jsonl", [
      JSON.stringify({ at: "t", point_id: "p", status: "judged", action: "pass", reasons: [] }),
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 200 }),
    ]);
    const report = reviewReport(dir);
    expect(report.latency).toEqual([
      { prefix: "production", stats: { judged: 2, failed: 0, p50_ms: 200, p95_ms: 200, max_ms: 200 } },
    ]);
  });
});

describe("reviewReport — since フィルタ（docs/07 実使用期間の集計境界）", () => {
  it("since 以降のエントリのみ集計する（tp/fp 表・latency とも期間前を除外）", () => {
    const dir = tempDir("jev-review-since-");
    writeLog(dir, "jev-2026-09-22.jsonl", [
      entryJson({ point_id: "req-assertion-a1", action: "pass", ms_total: 100, at: "2026-09-22T01:00:00.000Z" }),
      entryJson({
        point_id: "req-assertion-a1",
        action: "pass",
        ms_total: 300,
        at: "2026-09-22T05:00:00.000Z",
        would_block: { reason: "r-期間内" },
      }),
    ]);
    recordClassification(dir, "jev-2026-09-22.jsonl:2", "tp");
    const report = reviewReport(dir, { since: "2026-09-22T04:07:00.000Z" });
    // :1（期間前・review 対象外）と :2 のうち期間前は除外され、期間内の would-block 1 件のみ
    expect(report.by_prefix).toEqual([
      {
        prefix: "production",
        counts: { total: 1, unclassified: 0, tp: 1, fp: 0, unclear: 0 },
        feelings: { ok: 0, annoy: 0, ignore: 0, unrecorded: 1 },
      },
    ]);
    expect(report.latency).toEqual([
      { prefix: "production", stats: { judged: 1, failed: 0, p50_ms: 300, p95_ms: 300, max_ms: 300 } },
    ]);
    // 未指定は全期間（期間前 1 件が latency に戻る）
    expect(reviewReport(dir).latency).toEqual([
      { prefix: "production", stats: { judged: 2, failed: 0, p50_ms: 100, p95_ms: 300, max_ms: 300 } },
    ]);
  });

  it("at が欠落・非文字列の行は since 指定時は除外する（期間の内外が決められないため）", () => {
    const dir = tempDir("jev-review-since-no-at-");
    writeLog(dir, "jev-2026-09-22.jsonl", [
      JSON.stringify({ point_id: "p", status: "judged", action: "pass", reasons: [], ms_total: 1 }),
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 2, at: "2026-09-22T06:00:00.000Z" }),
    ]);
    const report = reviewReport(dir, { since: "2026-09-22T04:07:00.000Z" });
    expect(report.latency).toEqual([
      { prefix: "production", stats: { judged: 1, failed: 0, p50_ms: 2, p95_ms: 2, max_ms: 2 } },
    ]);
  });

  it("since に ISO 8601 として不正な値を渡すと例外（黙って全期間に倒さない）", () => {
    const dir = tempDir("jev-review-since-invalid-");
    expect(() => reviewReport(dir, { since: "9月22日" })).toThrow(/--since must be an ISO 8601 timestamp/);
  });

  it("normalizeSince: 秒精度 Z 末尾・オフセット表記を正規形に揃える。非 ISO（Date.parse が通るもの含む）は拒否", () => {
    expect(normalizeSince("2026-09-22T04:07:00Z")).toBe("2026-09-22T04:07:00.000Z");
    expect(normalizeSince("2026-09-22T13:07:00+09:00")).toBe("2026-09-22T04:07:00.000Z");
    expect(normalizeSince("2026-09-22T04:07:00.500Z")).toBe("2026-09-22T04:07:00.500Z");
    // V8 の Date.parse が通る非 ISO 形式は無音の全除外を起こすため正規表現で落とす
    expect(() => normalizeSince("9/22/2026")).toThrow(/--since must be an ISO 8601 timestamp/);
    expect(() => normalizeSince("2026-09-22")).toThrow(/--since must be an ISO 8601 timestamp/);
    // 存在しない日付は Date.parse がロールオーバーで受けるため成分 round-trip で落とす
    // （拒否されないと期間起点が日単位で黙ってずれる）
    expect(() => normalizeSince("2026-02-30T00:00:00Z")).toThrow(/--since must be an ISO 8601 timestamp/);
    expect(() => normalizeSince("2026-04-31T00:00:00Z")).toThrow(/--since must be an ISO 8601 timestamp/);
    expect(() => normalizeSince("2026-02-29T00:00:00+09:00")).toThrow(/--since must be an ISO 8601 timestamp/); // 2026 年は平年
    // 24:00:00（end-of-day）・うるう秒表記も厳密さ優先で拒否（翌日 00:00 と書ける）
    expect(() => normalizeSince("2026-09-22T24:00:00Z")).toThrow(/--since must be an ISO 8601 timestamp/);
    expect(() => normalizeSince("2026-09-22T23:59:60Z")).toThrow(/--since must be an ISO 8601 timestamp/);
    // 実在する日付（閏日）は通す
    expect(normalizeSince("2024-02-29T00:00:00Z")).toBe("2024-02-29T00:00:00.000Z");
  });

  it("境界同時刻（at == since）は含める（>=）。秒精度の since でも起点秒のエントリを落とさない", () => {
    const dir = tempDir("jev-review-since-boundary-");
    writeLog(dir, "jev-2026-09-22.jsonl", [
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 100, at: "2026-09-22T04:07:00.000Z" }),
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 200, at: "2026-09-22T04:07:00.500Z" }),
      entryJson({ point_id: "synth-open", action: "pass", ms_total: 50, at: "2026-09-22T04:06:59.999Z" }),
    ]);
    // 秒精度 Z 末尾の since（正規形でない入力）。正規化されず辞書順比較のままなら
    // "." < "Z" により起点秒の 2 件が誤除外される
    const report = reviewReport(dir, { since: "2026-09-22T04:07:00Z" });
    expect(report.latency).toEqual([
      { prefix: "production", stats: { judged: 2, failed: 0, p50_ms: 100, p95_ms: 200, max_ms: 200 } },
    ]);
  });

  it("list は since で絞らない（list の番号 = 全ログの走査順で分類 ref が安定）", () => {
    const dir = tempDir("jev-review-since-list-");
    writeLog(dir, "jev-2026-09-22.jsonl", [
      entryJson({
        point_id: "req-assertion-a1",
        action: "pass",
        at: "2026-09-22T01:00:00.000Z",
        would_block: { reason: "r-期間前" },
      }),
      entryJson({
        point_id: "req-assertion-a1",
        action: "pass",
        at: "2026-09-22T06:00:00.000Z",
        would_block: { reason: "r-期間内" },
      }),
    ]);
    expect(loadReviewTargets(dir)).toHaveLength(2);
  });
});

describe("review の 1 サイクル（#4 DoD 2: 判定 → 人間分類 → ゴールデン化）", () => {
  const logDir = tempDir("jev-review-e2e-logs-");
  const goldenDir = tempDir("jev-review-e2e-golden-");

  it("judge（stub）で would-block 記録 → 未分類一覧 → tp 分類 → ゴールデン化 → 回帰が緑", async () => {
    const point = SYNTH_POINTS.find((p) => p.id === "synth-observe")!;

    // 1. 判定（observe 中の reversible ゲート。block を検知して pass を返す）
    const run = await judge(point, {
      provider: async () => ({
        answers: { completion: { type: "score", score: 0, confidence: 0.9 } },
        model: "review-e2e-stub",
      }),
      logDir,
      label: "mj-review-e2e",
      project: "review-test",
    });
    expect(run.action).toEqual({ kind: "pass" });

    // 2. 未分類の一覧（review list に相当）
    const targets = loadReviewTargets(logDir);
    expect(targets).toHaveLength(1);
    const ref = targets[0]!.ref;
    expect(targets[0]!.entry.would_block?.reason).toBe("false しきい値を満たした criterion: completion");
    expect(loadClassifications(logDir).get(ref)).toBeUndefined();

    // 3. 人間分類（jev-review <番号> tp に相当）
    recordClassification(logDir, ref, "tp", "完了していない block は正しい");
    expect(loadClassifications(logDir).get(ref)?.classification).toBe("tp");

    // 4. tp をゴールデン化（create は expected_action: UNSET のスケルトンのみ）
    createGoldenCase(goldenDir, "synth-observe", {
      case: "review-tp",
      evidence: point.evidence(),
      attempts: [{ completion: { type: "score", score: 0, confidence: 0.9 } }],
    });
    expect(loadGoldenCases(goldenDir, "synth-observe")[0]!.expected_action).toBe("UNSET");

    // 5. expected を人手で確定する（運用では cases.jsonl の手編集。テストはそれを模倣 —
    //    ツールが expected を自動生成するのではない）。runGolden の比較対象は
    //    呼び出し側から見た action なので、observe 変換後の pass が expected
    const file = join(goldenDir, "synth-observe", "cases.jsonl");
    const c = loadGoldenCases(goldenDir, "synth-observe")[0]!;
    writeFileSync(file, `${JSON.stringify({ ...c, expected_action: { kind: "pass" } })}\n`);

    // 6. 回帰が緑（jev-golden run に相当）
    const report = await runGolden(goldenDir, SYNTH_POINTS);
    expect(report.summary).toEqual({ total: 1, pass: 1, fail: 0, unset: 0, flaky: 0 });
  });
});
