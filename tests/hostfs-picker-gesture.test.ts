import { expect, test } from "bun:test";
import { pickFiles } from "../src/shell/hostfs";

test("a save picker waits for a fresh gesture when activation expires", async () => {
  const oldWindow = globalThis.window;
  const oldAdd = globalThis.addEventListener;
  let press: (() => void) | undefined;
  let calls = 0;
  const handle = { kind: "file", name: "backup.zip" } as FileSystemFileHandle;
  Object.assign(globalThis, {
    window: { showSaveFilePicker: async () => {
      if (++calls === 1) throw Object.assign(new Error(), { name: "SecurityError" });
      return handle;
    } },
    addEventListener: (_name: string, callback: () => void) => { press = callback; },
  });
  try {
    const picked = pickFiles({ save: "backup.zip" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(press).toBeDefined();
    press!();
    expect(await picked).toEqual([handle]);
    expect(calls).toBe(2);
  } finally {
    Object.assign(globalThis, { window: oldWindow, addEventListener: oldAdd });
  }
});
