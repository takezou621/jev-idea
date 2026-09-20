import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テスト由来の判定ログを実使用ディレクトリから分離する（#46・docs/05
    // 「実運用とテストの分離」）。個別テストが sink を検査するときは
    // log: / logDir: の注入を優先するので、ここでの向け先は既定値にすぎない
    setupFiles: ["./scripts/vitest-setup.mjs"],
  },
});
