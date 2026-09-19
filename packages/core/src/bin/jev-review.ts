#!/usr/bin/env node
/**
 * jev-review — tp/fp 分類 CLI（docs/05「ログ・ゴールデン・tp/fp 分類」・#4 PR 2）。
 *
 * サブコマンド:
 *   jev-review list [--dir <log-dir>]
 *     block / would-block の判定ログを走査順（ファイル名・行番号）で連番表示。
 *     未分類は [?]、分類済みは [tp] / [fp] / [unclear]
 *   jev-review <番号> tp|fp|unclear [メモ...] [--dir <log-dir>]
 *     対応するログ行への分類を追記する（後勝ち。覆した経過も reviews.jsonl に残る）。
 *     tp はゴールデン化の材料
 *   jev-review report [--dir <log-dir>]
 *     label 接頭辞別（golden- / mj- 等はテスト由来。接頭辞なしは実運用）と
 *     point 別の tp/fp 表。数値のみ（p・confidence は含まない）
 *
 * log-dir の既定は ~/.jev/logs（JEV_LOG_DIR で上書き可）。分類ファイル
 * reviews.jsonl は判定ログと同じ機密扱い（0600 — AGENTS.md）。
 */
import {
  loadClassifications,
  loadReviewTargets,
  recordClassification,
  reviewReport,
  type Classification,
  type ReviewCounts,
  type ReviewEntry,
} from "../review.js";
import type { LogEntry } from "../log.js";

/** フラグの値を取り出す。フラグがあるのに値が欠落・別フラグならエラーにする */
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return v;
}

/** 位置引数（flags とその値を除いた引数）を取り出す */
function positional(args: string[], flags: string[]): string[] {
  const skip = new Set<number>();
  for (const f of flags) {
    // 同一フラグが複数回現れても全部スキップする（誤用時に残片が位置引数に混ざらないように）
    for (let i = args.indexOf(f); i >= 0; i = args.indexOf(f, i + 1)) {
      skip.add(i);
      skip.add(i + 1);
    }
  }
  return args.filter((_, i) => !skip.has(i));
}

const CLASSES: readonly Classification[] = ["tp", "fp", "unclear"];

/** 1 行の説明。事実文のみ（reason は docs/05 どおり判定語を含まない） */
function describe(e: LogEntry): string {
  if (e.would_block !== undefined) {
    return `would-block (returned ${e.action}): ${e.would_block.reason}`;
  }
  return `${e.action}: ${e.reasons[0] ?? ""}`;
}

function printList(targets: ReviewEntry[], latest: Map<string, { classification: Classification; note?: string }>): void {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const rec = latest.get(t.ref);
    const mark = rec ? `[${rec.classification}]` : "[?]";
    const label = t.entry.label === undefined ? "" : ` [${t.entry.label}]`;
    const note = rec?.note === undefined ? "" : `  # ${rec.note}`;
    console.log(
      `${String(i + 1).padStart(4)} ${mark} ${t.ref} ${t.entry.point_id}${label} ${describe(t.entry)}${note}`,
    );
  }
}

function printCounts(key: string, c: ReviewCounts): void {
  console.log(
    `  ${key.padEnd(24)} total=${String(c.total).padEnd(5)} unclassified=${String(c.unclassified).padEnd(4)} tp=${String(c.tp).padEnd(4)} fp=${String(c.fp).padEnd(4)} unclear=${c.unclear}`,
  );
}

async function main(): Promise<number> {
  const [first, ...rest] = process.argv.slice(2);
  const logDir = argValue(rest, "--dir");

  if (first === "list") {
    const targets = loadReviewTargets(logDir);
    printList(targets, loadClassifications(logDir));
    console.log(`${targets.length} entries (block / would-block)`);
    return 0;
  }

  if (first === "report") {
    const report = reviewReport(logDir);
    console.log("by prefix (golden- / mj- 等はテスト由来。接頭辞なしは production):");
    for (const r of report.by_prefix) printCounts(r.prefix, r.counts);
    console.log("by point:");
    for (const r of report.by_point) printCounts(r.point_id, r.counts);
    return 0;
  }

  // <番号> tp|fp|unclear [メモ...]
  const num = Number(first);
  if (!Number.isInteger(num) || num < 1) {
    console.error("usage: jev-review <list|report|<番号> tp|fp|unclear [メモ...]>");
    return 1;
  }
  const args = positional(rest, ["--dir"]);
  const cls = args[0] as Classification | undefined;
  if (cls === undefined || !CLASSES.includes(cls)) {
    console.error(`classification must be one of ${CLASSES.join("|")} (got: ${cls ?? "(missing)"})`);
    return 1;
  }
  const note = args.slice(1).join(" ");
  const targets = loadReviewTargets(logDir);
  const target = targets[num - 1];
  if (!target) {
    console.error(`no such entry: ${num} (run "jev-review list" first, ${targets.length} entries now)`);
    return 1;
  }
  recordClassification(logDir, target.ref, cls, note === "" ? undefined : note);
  console.log(`classified ${cls}: ${target.ref} (${target.entry.point_id})`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
