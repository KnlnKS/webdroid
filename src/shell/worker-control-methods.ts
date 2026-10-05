// The copied-control wire allowlist is safe to import before JVM or rendering initialization.
export const workerControlMethods = ["snapshot", "uiTree", "tap", "pointer", "back", "frame", "testFrame"] as const;
