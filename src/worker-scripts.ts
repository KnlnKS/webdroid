// The page's Worker scripts: the path each is served at and the module bundled for it (server.ts,
// scripts/build-prod.ts).
export const WORKER_SCRIPTS = {
  compile: { url: "/wasm-compile-worker.js", entry: "src/wasm/host/compile-worker.ts" },
  warm: { url: "/wasm-warm-worker.js", entry: "src/wasm/host/warm-worker.ts" },
  process: { url: "/process-worker.js", entry: "src/process-worker.ts" },
} as const;
