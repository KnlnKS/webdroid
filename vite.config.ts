// first, as for every script: the dev server's modules import the generated ones
import "./scripts/preload.ts";
import { defineConfig } from "vite-plus";
import { NODE_FLAGS } from "./scripts/node.ts";

export default defineConfig(({ command }) => ({
  plugins: [
    // each loads the runtime's modules, so only the command that uses it does
    command === "serve" && !process.env.VITEST && import("./server.ts").then((m) => m.devServer()),
    command === "build" && import("./scripts/build-prod.ts").then((m) => m.prodAssets()),
  ],
  // index.html names public/ by its path, so it is an ordinary directory whose files the build hashes
  publicDir: false,
  // the dev server's routes serve the page (server.ts); anything else they and Vite do not know is a 404
  appType: "custom",
  server: {
    host: "127.0.0.1", port: Number(process.env.PORT ?? 4080), strictPort: true, ws: false,
    // only the page's sources change under a running server; the package and reference-build trees are large
    watch: { ignored: (path: string) => !/\/(src|public)(\/|$)|\/index\.html$/.test(path.slice(import.meta.dirname.length)) && path !== import.meta.dirname },
  },
  // the workspace's sql.js is a CommonJS package, which only a pre-bundle can hand a page
  optimizeDeps: { include: ["sql.js"] },
  // production fetches /native-core.wasm in place of the base64 cores the other environments import
  build: { rolldownOptions: { external: [/core(\.safe)?\.wasm\.ts$/] } },
  test: {
    include: ["{src,tests}/**/*.test.ts"],
    execArgv: NODE_FLAGS,
    setupFiles: ["tests/platform.ts"],
    // node imports the sources as the scripts do: Vite's runner would rewrite the import() of functions tests hand a page
    experimental: { viteModuleRunner: false, nodeLoader: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
