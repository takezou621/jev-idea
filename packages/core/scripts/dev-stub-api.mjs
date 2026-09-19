#!/usr/bin/env node
/**
 * 開発用スタブ API — POST /v1/systemone に固定 answers を返す（#5 検証用）。
 *
 * 両ホスト（Claude Code / goose）からの同一 point・同一 evidence → 同一 action
 * を API 無しで確認するためのもの。実 API を叩らない検証（AGENTS.md テスト方針）
 * と同じ位置づけで、リポジトリには入れない実データは使わない。
 *
 * 使い方:
 *   node scripts/dev-stub-api.mjs [port] [answers.json]
 *     port          既定 8787
 *     answers.json  { "<criterion-id>": <RawSdkAnswer> } 形式。既定は
 *                   completion=未完了（score 0, confidence 0.9）→ block 側
 *
 * jev-judge 側の環境変数: TYPESAFE_BASE_URL=http://127.0.0.1:<port>
 * （TYPESAFE_API_KEY は未設定でよい。jevProvider が stub-key を使う）
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 8787);
const answersFile = process.argv[3];
const answers = answersFile !== undefined ? JSON.parse(readFileSync(answersFile, "utf8")) : {
  completion: { type: "score", score: 0, confidence: 0.9 },
};

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers, usage: { input_tokens: 1, output_tokens: 1 }, model: "dev-stub" }));
  });
}).listen(port, "127.0.0.1", () => {
  console.error(`dev-stub-api listening on http://127.0.0.1:${port} (answers: ${JSON.stringify(answers)})`);
});
