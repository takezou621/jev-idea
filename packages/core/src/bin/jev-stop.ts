#!/usr/bin/env node
/**
 * jev-stop — Claude Code Stop フック（docs/01 3-2・#21）。
 *
 * stdin の Stop イベント JSON を受け取り、未コミット変更（git diff HEAD・
 * tracked のみ）を「このターンで触れた」の近似として PR 判定 (a) を observe
 * 実行する。判定ポイント・evidence 組立て・2 段判定の制御は CI の jev-observe
 * と同一（docs/06「定義は 1 か所、ホスト差分は配線だけ」。差分は diff の
 * 範囲だけ）。ターン単位の正確な抽出は transcript 収集（#22・docs/02）の範囲。
 *
 * - observe 中は常に exit 0 で終わり停止を妨げない（実 block は #19 以降）。
 *   検出事実は {"systemMessage": ...} でユーザーに表示する。Stop では exit 0 +
 *   素の stdout は誰にも表示されないため JSON で返す
 * - stop_hook_active は無視してよい（停止を妨げないためフック起因のループに
 *   なり得ない）
 * - 配線エラー（git 不在・jev-judge 起動失敗など）は stderr + exit 1 の
 *   非ブロックのフックエラー。判定の結果（failMode に従う failed を含む）と
 *   混ぜない（jev-observe と同じ分け方）
 * - stdin の cwd を git の実行起点にする（サブディレクトリで始めたセッションでも
 *   リポジトリルートを正しく特定する）。stdin が空・不正でも落とさない
 *
 * 判定ログは jev-observe と同じ（--log-dir / JEV_LOG_DIR / ~/.jev/logs。
 * 0700/0600・p はここでだけ人間が見る）
 */
import { pathToFileURL } from "node:url";

import { observeWorkingTree, type ObserveDeps } from "./jev-observe.js";

// --base は対象外: この CLI の判定対象は常に未コミット変更（git diff HEAD）。
// base との比較は CI の jev-observe --base <ref> が担う
const USAGE = "usage: jev-stop [--log-dir DIR]";

export type StopInput = {
  /** Stop イベントの cwd（セッションの作業ディレクトリ）。git の実行起点にする */
  cwd?: string;
};

/** Stop フックの stdin JSON を緩く解釈する。空・不正 JSON・型違いは入力なし扱い
 *  （フックを落とす理由にしない。この CLI が使うのは cwd のみ） */
export function parseStopInput(raw: string): StopInput {
  if (raw.trim().length === 0) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return typeof v.cwd === "string" && v.cwd.length > 0 ? { cwd: v.cwd } : {};
  } catch {
    return {};
  }
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => {
      s += c;
    });
    process.stdin.on("end", () => resolve(s));
    // Claude Code は JSON を書いて stdin を閉じる。閉じない環境でも滞留させない
    const t = setTimeout(() => resolve(s), 5000);
    t.unref();
  });
}

export type StopOutcome = {
  /** Stop 時にユーザーへ表示する事実（summary）。触れた変更がなければ undefined */
  systemMessage?: string;
};

/** Stop フック本体。判定結果で throw しない（DoD 2: observe 中は exit 0 で終わる） */
export async function runStop(args: string[], input: StopInput, deps: ObserveDeps = {}): Promise<StopOutcome> {
  const result = await observeWorkingTree(args, deps, { cwd: input.cwd });
  // 触れた変更がなければ黙って終わる（変更のない Stop ごとの表示はノイズ）
  return result.skipped ? {} : { systemMessage: result.summary };
}

/** フック出力行。Stop では exit 0 + 素の stdout は表示されないため systemMessage JSON で返す */
export function stopHookOutput(outcome: StopOutcome): string | undefined {
  return outcome.systemMessage === undefined ? undefined : `${JSON.stringify({ systemMessage: outcome.systemMessage })}\n`;
}

async function main(): Promise<number> {
  const rest = process.argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const input = parseStopInput(await readStdin());
  const outcome = await runStop(process.argv.slice(2), input);
  const out = stopHookOutput(outcome);
  if (out !== undefined) process.stdout.write(out);
  return 0;
}

// bin として直接実行されたときだけ main を動かす（テストがこのモジュールを
// import する。ガードがないと import 時に main が走り、stdin 読みと実 git
// 実行がテストプロセス内で起きる）
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
