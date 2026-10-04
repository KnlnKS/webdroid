import binaryen from "binaryen";
import { chromium } from "playwright";
export function wat(text, { gc = true } = {}) {
  const m = binaryen.parseText(text);
  const F=binaryen.Features; m.setFeatures(F.All & ~(F.CompactImports|F.StackSwitching|F.SharedEverything|F.FP16|F.CustomPageSizes|F.WideArithmetic|F.RelaxedAtomics|F.AcquireReleaseAtomics|F.Strings));
  if (!m.validate()) throw new Error("invalid wasm");
  const bytes = m.emitBinary(); m.dispose(); return bytes;
}
export async function inChrome(fn, args) {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const p = await b.newPage(); await p.goto("about:blank");
  try { return await p.evaluate(`(${fn})(${JSON.stringify(args)})`); } finally { await b.close(); }
}
