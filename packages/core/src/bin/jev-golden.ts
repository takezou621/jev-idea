#!/usr/bin/env node
/**
 * jev-golden — 合成ゴールデンの作成と回帰実行 CLI（docs/05・#4）。
 *
 * サブコマンド:
 *   jev-golden create <point-id> <case> --evidence <json> --attempts <json>
 *       [--fail-attempt N] [--note "..."]
 *     スケルトンを作成する。expected_action は常に "UNSET" で書き、人間が
 *     cases.jsonl を編集して確定する（expected の自動生成・上書きはしない）。
 *     evidence / attempts は JSON ファイルから読む（inline 転写の防止）
 *   jev-golden run [--dir <golden-dir>]
 *     全ゴールデンケースを回帰実行する。fail / unset があれば exit 1
 *   jev-golden flaky <point-id>/<case> [--note "..."]
 *     境界で揺れる同一入力を FLAKY に登録する（回帰の分母から外れる）
 *
 * golden-dir の既定は ~/.jev/golden（実データのゴールデンはリポジトリに
 * 入れない。AGENTS.md）。ディレクトリ 0700 / ファイル 0600。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createGoldenCase, markFlaky, runGolden } from "../golden.js";
import { SYNTH_POINTS } from "../synth-points.js";

const DEFAULT_GOLDEN_DIR = join(homedir(), ".jev", "golden");

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
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

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const dir = argValue(rest, "--dir") ?? DEFAULT_GOLDEN_DIR;
  const knownPoints = new Set(SYNTH_POINTS.map((p) => p.id));

  switch (cmd) {
    case "create": {
      const [pointId, caseName] = positional(rest, ["--evidence", "--attempts", "--fail-attempt", "--note", "--dir"]);
      const evidenceFile = argValue(rest, "--evidence");
      const attemptsFile = argValue(rest, "--attempts");
      if (!pointId || !caseName || !evidenceFile || !attemptsFile) {
        console.error("usage: jev-golden create <point-id> <case> --evidence <json> --attempts <json> [--fail-attempt N] [--note \"...\"]");
        return 1;
      }
      // タイポを create の時点で弾く（run まで気づかないと expected 確定が無駄になる）
      if (!knownPoints.has(pointId)) {
        console.error(`unknown point id: ${pointId} (known: ${[...knownPoints].sort().join(", ")})`);
        return 1;
      }
      const failAttemptRaw = argValue(rest, "--fail-attempt");
      let failAttempt: number | undefined;
      if (failAttemptRaw !== undefined) {
        failAttempt = Number(failAttemptRaw);
        if (!Number.isInteger(failAttempt) || failAttempt < 1) {
          console.error(`--fail-attempt must be an integer >= 1 (got: ${failAttemptRaw})`);
          return 1;
        }
      }
      try {
        const attempts: unknown = JSON.parse(readFileSync(attemptsFile, "utf8"));
        // attempts: [] は expected 確定後に failMode 経路へ静かに落ちるため作成時点で弾く
        if (!Array.isArray(attempts) || attempts.length < 1) {
          console.error(`--attempts must be a JSON array with at least 1 attempt (got: ${attemptsFile})`);
          return 1;
        }
        createGoldenCase(dir, pointId, {
          case: caseName,
          evidence: JSON.parse(readFileSync(evidenceFile, "utf8")),
          attempts,
          ...(failAttempt !== undefined ? { fail_attempt: failAttempt } : {}),
          ...(argValue(rest, "--note") !== undefined ? { note: argValue(rest, "--note") } : {}),
        });
        console.log(`created (expected_action は UNSET。人手で確定してください): ${dir}/${pointId}/cases.jsonl`);
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }
    case "run": {
      const report = await runGolden(dir, SYNTH_POINTS);
      for (const r of report.results) {
        const detail =
          r.status === "fail"
            ? [r.expected !== undefined ? `expected=${JSON.stringify(r.expected)}` : undefined,
               r.actual !== undefined ? `actual=${JSON.stringify(r.actual)}` : undefined,
               r.error].filter((x) => x !== undefined).join(" ")
            : (r.error ?? "");
        console.log(`${r.point_id}/${r.case}: ${r.status} ${detail}`);
      }
      const s = report.summary;
      console.log(`summary: ${s.total} cases — ${s.pass} pass, ${s.fail} fail, ${s.unset} unset, ${s.flaky} flaky`);
      return s.fail > 0 || s.unset > 0 ? 1 : 0;
    }
    case "flaky": {
      const ref = positional(rest, ["--note", "--dir"])[0];
      if (!ref) {
        console.error("usage: jev-golden flaky <point-id>/<case> [--note \"...\"]");
        return 1;
      }
      markFlaky(dir, ref, argValue(rest, "--note"));
      console.log(`marked flaky: ${ref}`);
      return 0;
    }
    default:
      console.error("usage: jev-golden <create|run|flaky> ...");
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
