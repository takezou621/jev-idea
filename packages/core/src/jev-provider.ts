/**
 * Jev（TypeSafe AI）への既定プロバイダ（@typesafe-ai/sdk）。
 *
 * jev-claude jev-lib.mjs client() と同じ構成:
 * - logLevel off: フックの stderr を汚さない
 * - retry maxRetries 1: 既定 2 は対話をブロックするには長い
 * - 総予算は judge() が AbortSignal で管理する（SDK のタイムアウトは 1 試行あたり）。
 *   provider 側では予算を持たない
 *
 * テストは stub provider を注入するため、このファイルは実 API を叩かない
 * （AGENTS.md テスト方針）。
 */
import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import type { JudgeProvider } from "./types.js";

export function jevProvider(): JudgeProvider {
  const apiKey = process.env.TYPESAFE_API_KEY;
  // TYPESAFE_BASE_URL はスタブ（jev-claude stub-server.mjs）等の経路差し替え用
  const baseURL = process.env.TYPESAFE_BASE_URL ?? process.env.JEV_BASE_URL;
  if (!apiKey && !baseURL) throw new Error("TYPESAFE_API_KEY is not set");
  const client = new TypeSafeClient({
    apiKey: apiKey ?? "stub-key",
    ...(baseURL ? { baseURL } : {}),
    logLevel: "off",
    retry: { maxRetries: 1 },
  });
  return async ({ state, questions, signal }) => {
    const result = await client.systemOne(
      { state, questions: questions as Questions },
      { signal },
    );
    return {
      answers: result.answers as unknown as Record<string, Record<string, unknown>>,
      usage: result.usage,
      model: result.model,
    };
  };
}
