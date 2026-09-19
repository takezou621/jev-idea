#!/usr/bin/env node
/**
 * jev-judge — 判定の実行口となる stdio MCP サーバー（docs/06・#5）。
 *
 * Claude Code（.mcp.json）と goose（extensions 登録）の両方から同じ設定で
 * 起動する。判定ポイント定義は 1 か所で、ホスト差分は配線だけ（docs/06）。
 *
 * プロバイダは TYPESAFE_API_KEY（または TYPESAFE_BASE_URL）で解決される
 * jevProvider()。キーが無い場合も例外にはならず、judge が status: "failed"
 * + failMode に従う action を返す（fail-open はツール契約・docs/06）。
 */
import { createJevJudgeServer } from "../mcp/server.js";
import { runStdio } from "../mcp/protocol.js";

runStdio(createJevJudgeServer())
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    // stdin 断以外の異常。stdout は汚さない（stderr のみ）
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
