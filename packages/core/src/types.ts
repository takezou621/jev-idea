/**
 * jev-core — 共通判定レイヤーの型（docs/05「インターフェース」の実装版）。
 *
 * docs/05 からの拡張（PR で設計書差分として説明する）:
 * - Criterion に type / rubric / meanings を足す（回答層が動くために質問型が要る）
 * - Answer に distribution を足す（score 型の分布。decision が分布集中の
 *   確信判定に使える。jev-claude の pIncomplete ゲートの継承）
 * - Section に source / sourceTime / command を足す（判定ログの
 *   「evidence の由来ファイルと時刻」「コマンド文字列先頭 200 文字」の出所）
 * - JudgmentPoint に thresholds を足す（docs/05「しきい値は各判定ポイントが
 *   上書きできる」の実装口）
 * - Judgment の failed に action を足す（docs/06 契約: failMode に従う
 *   アクションを返す。呼び出し側に failMode の解釈をさせない）
 */

/** 判定質問の型。choice は docs/05 で未規定のため本 PR では含めない（将来の PR で規定する）。 */
export type AnswerType = "score" | "boolean";

/**
 * 1 criterion = 1 質問（AGENTS.md「1 criterion 1 質問」。複数の判断を混ぜない）。
 */
export type Criterion =
  | {
      type: "score";
      id: string;
      question: string;
      /** 0..length-1 尺度の rubric（最低 2 段。SDK の score 質問と同じ制約）。norm = score / (length - 1) */
      rubric: readonly [string, string, ...string[]];
    }
  | {
      type: "boolean";
      id: string;
      question: string;
      /** true / false の各説明（SDK の noul criteria に渡る） */
      meanings?: { true?: string; false?: string };
    };

/**
 * 正規化済み回答。criterion は Criterion.id と一致する。
 * 検証で不正だった回答は回答ごと欠落する（unknown に倒す。フェイルオープン）。
 */
export type Answer = {
  criterion: string;
  /** 回答層の確率（score 型は 0..1 に正規化、boolean 型は SDK の noul 確率そのまま） */
  p: number;
  /** 0..1。欠落は常に unknown に倒す（docs/05 鉄則） */
  confidence?: number;
  /**
   * score 型のみ。rubric 段別の確率分布。キーは段の正規化値
   * （"0" / "0.25" / …、norm = 段 / (length - 1)）、値は 0..1。
   * 合計が 1 を超える分布は回答ごと捨てる（jev-claude の罠: 確信ある未完了の偽造）。
   * distribution を使う二次的な二値化（分布集中の確信ゲート）は
   * judge 内の massBelow と判定ポイント側の設定で行う。
   */
  distribution?: Record<string, number>;
};

export type Action =
  | { kind: "pass" }
  | { kind: "block"; reason: string } // reason は事実のみ。判定語を含めない
  | { kind: "warn"; note: string }
  | { kind: "escalate"; question: string };

export type Section = {
  title?: string;
  /** 生のまま。加工・要約・評価語を付けない（docs/05 メタ分離プロトコル） */
  text: string;
  /** evidence の由来（ファイルパスなど。判定ログに記録する） */
  source?: string;
  /** 由来の時刻（ファイル mtime など ISO 文字列。判定ログに記録する） */
  sourceTime?: string;
  /** 由来コマンド。判定ログには先頭 200 文字のみ記録する */
  command?: string;
};

export type Evidence = {
  /** 判定に必要な文脈（組立てた事実列。判定語を含めない） */
  meta: Section[];
  /** 対象データそのもの（diff、コード、イベント列など生のまま） */
  data: Section[];
};

export type FailMode = "open" | "closed" | "escalate";

/** 回答層しきい値の上書き。未指定フィールドは既定値を使う。 */
export type Thresholds = {
  trueMin?: number;
  falseMax?: number;
  /**
   * null で confidence ゲートを無効にする（minConfidence の上書き）。
   * boolean 型（SDK noul）は confidence を持たないため、p ベースの二値化に
   * 使う。score 型には既定の 0.5 を推奨（docs/05 の確定規則）。
   */
  minConfidence?: number | null;
};

export type ResolvedThresholds = {
  trueMin: number;
  falseMax: number;
  minConfidence: number | null;
};

export type JudgmentPoint = {
  /** ログとゴールデンの鍵 */
  id: string;
  criteria: readonly Criterion[];
  /** 回答層しきい値の上書き（省略時は既定値） */
  thresholds?: Thresholds;
  /** 状態テキストの組立て */
  evidence: () => Evidence;
  /**
   * 決定的に書く。回答層の true/false/unknown だけを使う（docs/05）。
   * 第 2 引数には judge が resolveThresholds(point.thresholds) で解決した
   * しきい値が渡る。verdict / confidence 比較はこの th を使う
   * （宣言と使用のズレを型で防ぐ。しきい値の定義は 1 か所）。
   */
  decision: (answers: Record<string, Answer>, th: ResolvedThresholds) => Action;
  /** Jev 不通時の挙動。省略しない（AGENTS.md） */
  failMode: FailMode;
  /** observe 適用可否の判定に使う（docs/05。observe 機能自体は #3） */
  gate?: "reversible" | "irreversible";
  /** block 型のみ有効（docs/05。observe 機能自体は #3） */
  observe?: boolean;
};

/** docs/06 契約: 呼び出し側は status と action のみを受け取る（p は含まれない）。 */
export type Judgment =
  | { status: "judged"; answers: Record<string, Answer>; action: Action }
  | { status: "failed"; error: Error; action: Action };

/** SDK 応答の生の形（Gateway 経路では type 名と確率の位置が揺れる。両方を受ける） */
export type RawSdkAnswer = {
  type?: unknown;
  noul?: unknown;
  probability?: unknown;
  score?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
  choice?: unknown;
};

/** SDK に送る質問（criterion から組立てたもの。id をキーにする。SDK 型への割当は provider 境界で行う） */
export type SdkQuestions = Record<string, unknown>;

/**
 * 判定実行の抽象。Jev への接続（@typesafe-ai/sdk）を差し替え可能にする。
 * テストは stub provider を注入し、実 API を叩かない（AGENTS.md テスト方針）。
 * 失敗は例外として投げる（judge が catch して status: "failed" にする）。
 */
export type JudgeProvider = (req: {
  state: string;
  questions: SdkQuestions;
  signal: AbortSignal;
}) => Promise<{
  answers: Record<string, RawSdkAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
}>;
