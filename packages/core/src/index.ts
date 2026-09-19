/**
 * @jev/core — jev-core 共通判定レイヤー（docs/05）。
 * 判定の実行と決定はここで完結し、ホストにはアクションのみを返す
 * （最重要原則 2）。
 */
export * from "./types.js";
export {
  DEFAULT_THRESHOLDS,
  massBelow,
  normScore,
  resolveThresholds,
  verdict,
} from "./thresholds.js";
export { fromSdkAnswers } from "./sdk-answers.js";
export { toSdkQuestions, type JevQuestions } from "./sdk-questions.js";
export { evidenceToState, DATA_MARKER, DATA_NOTICE } from "./state.js";
export { jevProvider } from "./jev-provider.js";
export { majorityAnswers, MAJORITY_SPREAD_MAX } from "./majority.js";
export { fileSink, toLogEvidence, toReasons, type LogEntry, type LogEvidenceSection, type LogSink } from "./log.js";
export { judge, type JudgeOptions } from "./judge.js";
