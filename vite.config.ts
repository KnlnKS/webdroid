import { defineConfig } from "vite-plus";
import { ensureGenerated } from "./scripts/generated.ts";

export default defineConfig({
  plugins: [{ name: "webdroid:generated", configResolved: () => ensureGenerated() }],
  test: {
    include: ["{src,tests}/**/*.test.ts"],
    // Java runs on the Wasm tier, which suspends through JSPI; --expose-gc lets heap limits be judged on live data
    execArgv: ["--experimental-wasm-jspi", "--expose-gc"],
    setupFiles: ["tests/platform.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
