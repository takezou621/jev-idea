/**
 * 合成ゴールデン（docs/05「ログ・ゴールデン・tp/fp 分類」・#4）。
 *
 * closed ゲートの導入検証は本番データで行わない（docs/05「フェイルオープンと
 * observe」。overview 原則 7 の例外）。合成ゴールデンは合成 evidence +
 * 記録済み（合成）応答を再生して judge を実行し、人手確定の expected_action
 * と比較する回帰。
 *
 * - ゴールデンは判定ポイントごとに `<golden-dir>/<point-id>/cases.jsonl`
 *   （1 行 1 ケース。expected_action は人手で確定する — ツール・テストが
 *   expected を自動生成・上書きしない。作成コマンドは "UNSET" を書くだけ）
 * - 境界で block/pass が揺れる同一入力は `flaky.jsonl` に登録し、回帰の
 *   分母から外す（docs/05 FLAKY 規定）
 * - 実データのゴールデンは機密を含みうるためリポジトリに入れず、既定の
 *   golden-dir は ~/.jev/golden（リポジトリ内の fixtures は合成データのみ）
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { judge } from "./judge.js";
import type { Action, Evidence, JudgmentPoint, RawSdkAnswer } from "./types.js";

export type GoldenCase = {
  /** ケース名。ポイント内で一意（重複作成は拒否する） */
  case: string;
  /** 判定対象の evidence（合成データ。実データを入れた場合はリポジトリに入れない） */
  evidence: Evidence;
  /** 試行ごとの SDK 生応答。試行数 = judge の repeats（多数決 helper の入力） */
  attempts: Record<string, RawSdkAnswer>[];
  /** この試行（1 始まり）で provider が失敗する（failMode 経路のゴールデン） */
  fail_attempt?: number;
  /** 人手確定の期待アクション。"UNSET" は expected 未確定（回帰では fail に数える） */
  expected_action: Action | "UNSET";
  note?: string;
};

export type GoldenResult = {
  point_id: string;
  case: string;
  status: "pass" | "fail" | "unset" | "flaky";
  expected?: Action;
  actual?: Action;
  error?: string;
};

export type GoldenReport = {
  results: GoldenResult[];
  summary: { total: number; pass: number; fail: number; unset: number; flaky: number };
};

const casesFile = (goldenDir: string, pointId: string): string =>
  join(goldenDir, pointId, "cases.jsonl");

export function listGoldenPoints(goldenDir: string): string[] {
  if (!existsSync(goldenDir)) return [];
  return readdirSync(goldenDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** jsonl を 1 行 1 レコードでパースする。壊れた行はファイル名・行番号付きで報告する
 *  （expected は人手編集の対象。編集ミス時に該当箇所が特定できないと回帰が進まない） */
function parseJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l, i) => ({ l, line: i + 1 }))
    .filter(({ l }) => l.trim().length > 0)
    .map(({ l, line }) => {
      try {
        return JSON.parse(l) as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${file}:${line}: invalid JSON (${msg})`);
      }
    });
}

export function loadGoldenCases(goldenDir: string, pointId: string): GoldenCase[] {
  return parseJsonl<GoldenCase>(casesFile(goldenDir, pointId));
}

/** FLAKY リスト（docs/05）。ref は "point-id/case" */
export function loadFlaky(goldenDir: string): Set<string> {
  return new Set(
    parseJsonl<{ ref: string }>(join(goldenDir, "flaky.jsonl")).map((r) => r.ref),
  );
}

/**
 * ケースのスケルトンを作成する。expected_action は常に "UNSET"（人手確定を
 * 強制する — 既存ケースの上書き・同 case 名の再作成は拒否する）
 */
export function createGoldenCase(
  goldenDir: string,
  pointId: string,
  input: Omit<GoldenCase, "expected_action">,
): void {
  if (loadGoldenCases(goldenDir, pointId).some((c) => c.case === input.case)) {
    throw new Error(`golden case already exists: ${pointId}/${input.case}`);
  }
  const dir = join(goldenDir, pointId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: GoldenCase = { ...input, expected_action: "UNSET" };
  appendFileSync(casesFile(goldenDir, pointId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function markFlaky(goldenDir: string, ref: string, note?: string): void {
  if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true, mode: 0o700 });
  const record = note === undefined ? { ref } : { ref, note };
  appendFileSync(join(goldenDir, "flaky.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function actionEqual(a: Action, b: Action): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "block" && b.kind === "block") return a.reason === b.reason;
  if (a.kind === "warn" && b.kind === "warn") return a.note === b.note;
  if (a.kind === "escalate" && b.kind === "escalate") return a.question === b.question;
  return true;
}

/**
 * 全ゴールデンケースを回帰実行する。判定ポイントの decision・しきい値は
 * points から point_id で引き、evidence と応答はケースから再生する
 * （実 API を叩かない。AGENTS.md テスト方針）。
 *
 * 回帰の比較対象は呼び出し側から見た action（observe 変換後・failMode 経路を
 * 含む）。expected_action が "UNSET" のケースは回帰不能として fail 扱い —
 * expected を人手で確定するまで回帰は緑にならない。
 */
export async function runGolden(
  goldenDir: string,
  points: readonly JudgmentPoint[],
): Promise<GoldenReport> {
  const pointMap = new Map(points.map((p) => [p.id, p]));
  const flaky = loadFlaky(goldenDir);
  const results: GoldenResult[] = [];
  for (const pointId of listGoldenPoints(goldenDir)) {
    const point = pointMap.get(pointId);
    for (const c of loadGoldenCases(goldenDir, pointId)) {
      const base: Omit<GoldenResult, "status"> = { point_id: pointId, case: c.case };
      // UNSET を先に数える（expected 未確定を flaky 登録で隠せないようにする）。
      // unknown point も flaky より先（FLAKY に載せても実ポイント誤りは検知する）
      if (!point) {
        results.push({ ...base, status: "fail", error: "unknown point id" });
        continue;
      }
      if (c.expected_action === "UNSET") {
        results.push({ ...base, status: "unset" });
        continue;
      }
      if (flaky.has(`${pointId}/${c.case}`)) {
        results.push({ ...base, status: "flaky" });
        continue;
      }
      let attempt = 0;
      const run = await judge(
        { ...point, evidence: () => c.evidence },
        {
          provider: async () => {
            attempt++;
            if (c.fail_attempt === attempt) {
              throw new Error(`golden simulated failure (attempt ${attempt})`);
            }
            const raw = c.attempts[attempt - 1];
            if (!raw) throw new Error(`golden missing attempt ${attempt}`);
            return { answers: raw, model: "golden-stub" };
          },
          repeats: c.attempts.length,
          log: false,
          label: `golden-${pointId}/${c.case}`,
        },
      );
      const expected = c.expected_action as Action;
      const actual = run.action;
      results.push({
        ...base,
        status: actionEqual(expected, actual) ? "pass" : "fail",
        expected,
        actual,
      });
    }
  }
  const count = (s: GoldenResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    results,
    summary: { total: results.length, pass: count("pass"), fail: count("fail"), unset: count("unset"), flaky: count("flaky") },
  };
}
