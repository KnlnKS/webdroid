// The copied-control wire allowlist is safe to import before JVM or rendering initialization.
export const workerControlMethods = ["snapshot", "aotProfile", "codeReadiness", "alive", "uiTree", "tap", "swipe", "type", "enter", "imeState", "pointer", "back", "frame", "testFrame"] as const;
