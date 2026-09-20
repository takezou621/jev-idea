#!/usr/bin/env node
/**
 * jev-review — tp/fp 分類 CLI（docs/05「ログ・ゴールデン・tp/fp 分類」・#4 PR 2）。
 *
 * サブコマンド:
 *   jev-review list [--dir <log-dir>]
 *     block / would-block の判定ログを走査順（ファイル名・行番号）で連番表示。
 *     未分類は [?]、分類済みは [tp] / [fp] / [unclear]
 *   jev-review <番号|ref> tp|fp|unclear [--feeling ok|annoy|ignore] [メモ...] [--dir <log-dir>]
 *     対応するログ行への分類を追記する（後勝ち。覆した経過も reviews.jsonl に残る）。
 *     --feeling は体感タグ（docs/07 R3: ok=納得 / annoy=邪魔 / ignore=無関心。#28）。
 *     feeling 未指定の再分類では前の feeling を引き継ぐ。
 *     番号は list の走査順。list と分類の間にログが追記されて番号がずれうる
 *     場合は ref 形式（jev-YYYY-MM-DD.jsonl:<行番号>）で指定する。
 *     tp はゴールデン化の材料
 *   jev-review report [--dir <log-dir>]
 *     label 接頭辞別（golden- / mj- 等はテスト由来。接頭辞なしは実運用）と
 *     point 別の tp/fp 表。prefix 別には feeling の内訳（#28 週次サマリの
 *     「邪魔」割合を含む）も出す。数値のみ（p・confidence は含まない）
 *
 * log-dir の既定は ~/.jev/logs（JEV_LOG_DIR で上書き可）。分類ファイル
 * reviews.jsonl は判定ログと同じ機密扱い（0600 — AGENTS.md）。
 */
import {
  FEELINGS,
  loadClassifications,
  loadReviewTargets,
  recordClassification,
  reviewReport,
  type Classification,
  type Feeling,
  type FeelingCounts,
  type ReviewCounts,
  type ReviewEntry,
} from "../review.js";
import { pathToFileURL } from "node:url";
import type { LogEntry } from "../log.js";
import { argValue, positional } from "./cli-util.js";

const CLASSES: readonly Classification[] = ["tp", "fp", "unclear"];

/** 1 行の説明。事実文のみ（reason は docs/05 どおり判定語を含まない） */
function describe(e: LogEntry): string {
  if (e.would_block !== undefined) {
    return `would-block (returned ${e.action}): ${e.would_block.reason}`;
  }
  return `${e.action}: ${e.reasons[0] ?? ""}`;
}

function printList(targets: ReviewEntry[], latest: Map<string, { classification: Classification; feeling?: Feeling; note?: string }>): void {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const rec = latest.get(t.ref);
    const mark = rec ? `[${rec.classification}${rec.feeling === undefined ? "" : `:${rec.feeling}`}]` : "[?]";
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

/**
 * feeling の内訳行。annoy の割合は docs/07 R3 と同じ分母 — 体感を**記録した**
 * 介入（ok + annoy + ignore）に対する annoy。未記録（unrecorded）を分母に
 * 入れると記録が進む前の期間で過小表示になる。数値のみ（p 等を含まない）
 */
function printFeelings(f: FeelingCounts): void {
  const recorded = f.ok + f.annoy + f.ignore;
  const pct = recorded === 0 ? "" : ` (annoy ${((f.annoy / recorded) * 100).toFixed(1)}%)`;
  console.log(`    feeling ok=${f.ok} annoy=${f.annoy} ignore=${f.ignore} unrecorded=${f.unrecorded}${pct}`);
}

/** 引数は既定で process.argv.slice(2)。テストからは argv を直接渡す */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [first, ...rest] = argv;
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
    for (const r of report.by_prefix) {
      printCounts(r.prefix, r.counts);
      printFeelings(r.feelings);
    }
    console.log("by point:");
    for (const r of report.by_point) printCounts(r.point_id, r.counts);
    return 0;
  }

  // <番号|ref> tp|fp|unclear [--feeling ok|annoy|ignore] [メモ...]
  const key = first ?? "";
  const isNumber = /^\d+$/.test(key);
  if (!isNumber && !/^\S+\.jsonl:\d+$/.test(key)) {
    console.error("usage: jev-review <list|report|<番号|ref> tp|fp|unclear [--feeling ok|annoy|ignore] [メモ...]>");
    return 1;
  }
  const args = positional(rest, ["--dir", "--feeling"]);
  const cls = args[0] as Classification | undefined;
  if (cls === undefined || !CLASSES.includes(cls)) {
    console.error(`classification must be one of ${CLASSES.join("|")} (got: ${cls ?? "(missing)"})`);
    return 1;
  }
  const feelingRaw = argValue(rest, "--feeling");
  let feeling: Feeling | undefined;
  if (feelingRaw !== undefined) {
    if (!(FEELINGS as readonly string[]).includes(feelingRaw)) {
      console.error(`feeling must be one of ${FEELINGS.join("|")} (got: ${feelingRaw})`);
      return 1;
    }
    feeling = feelingRaw as Feeling;
  }
  const note = args.slice(1).join(" ");
  const targets = loadReviewTargets(logDir);
  const target = isNumber
    ? targets[Number(key) - 1]
    : targets.find((t) => t.ref === key);
  if (!target) {
    console.error(
      isNumber
        ? `no such entry: ${key} (run "jev-review list" first, ${targets.length} entries now)`
        : `no such ref: ${key} (run "jev-review list" first, ${targets.length} entries now)`,
    );
    return 1;
  }
  recordClassification(logDir, target.ref, cls, note === "" ? undefined : note, feeling);
  console.log(`classified ${cls}${feeling === undefined ? "" : ` (${feeling})`}: ${target.ref} (${target.entry.point_id}) ${describe(target.entry)}`);
  return 0;
}

// bin として直接実行されたときだけ main を動かす（テストがこのモジュールを
// import する。ガードがないと import 時に main が走り、usage エラーの出力と
// exitCode 汚染が起きる — jev-stop / jev-observe と同じガード）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
