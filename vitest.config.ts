import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // packages/core/vitest.config.ts と同一の分離（#46）。ルートから直接
    // npx vitest を実行したときも setup が効くようにする。setup の実体と
    // 理由は packages/core/scripts/vitest-setup.mjs を参照
    setupFiles: ["./packages/core/scripts/vitest-setup.mjs"],
  },
});
