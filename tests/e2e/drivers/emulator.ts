// Emulator driver — adb + uiautomator. Imported ONLY by capture-emulator.ts.
// Nothing on the diff path may reach this file; `bun run e2e` must work with no Android SDK.
// The recorder DEFINES the geometry a golden set is captured at, so it reads the device profile
// directly rather than a manifest — the manifest is what it writes.
import { device } from "../../../src/shell/config";
import { type UiNode } from "../types";
import { sleep, settleOn } from "../lib/util";

const ADB = process.env.ADB ?? "adb";

export async function sh(args: string[], opts: { quiet?: boolean } = {}): Promise<string> {
  const p = Bun.spawn([ADB, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0 && !opts.quiet) throw new Error(`adb ${args.join(" ")} failed (${code}): ${err || out}`);
  return out;
}

export const shell = (cmd: string, opts?: { quiet?: boolean }) => sh(["shell", cmd], opts);
export const shellArg = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Raw PNG bytes of the current screen. `exec-out` avoids the CRLF mangling of `shell`. */
async function screencap(): Promise<Buffer> {
  const p = Bun.spawn([ADB, "exec-out", "screencap", "-p"], { stdout: "pipe", stderr: "pipe" });
  const buf = Buffer.from(await new Response(p.stdout).arrayBuffer());
  await p.exited;
  if (buf.length < 8 || buf[1] !== 0x50) throw new Error("screencap did not return a PNG");
  return buf;
}

/**
 * Wait until the framebuffer stops changing. Returns the settled screenshot and whether we
 * gave up — a timeout is recorded, never thrown, so a stuck screen still produces a golden.
 */
export async function settle(
  { stableFrames = 4, intervalMs = 350, timeoutMs = 20000 } = {},
): Promise<{ png: Buffer; timedOut: boolean }> {
  return settleOn(screencap, { stableFrames, intervalMs, timeoutMs });
}

/**
 * True when a soft keyboard is actually on screen. Gating the dismiss key on this matters:
 * KEYCODE_ESCAPE closes dialogs too, so sending it unconditionally silently dismissed the
 * app's own dialogs before they could be captured.
 */
async function imeShown(): Promise<boolean> {
  const out = await shell("dumpsys input_method 2>/dev/null | grep -m1 -o 'mInputShown=[a-z]*'");
  return out.includes("mInputShown=true");
}

/** Close the soft keyboard if (and only if) one is up. webdroid has no IME to compare against. */
export async function dismissIme(): Promise<boolean> {
  if (!(await imeShown())) return false;
  await shell("input keyevent 111");
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    if (!(await imeShown())) return true;
  }
  return true;
}

/** Dump the accessibility hierarchy. Works for Compose too — Mihon exposes semantics. */
export async function dumpUi(): Promise<UiNode[]> {
  let xml = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    // Remove first: if the dump fails, a leftover file from an earlier screen would be
    // parsed as if it were the current one and quietly resolve taps to stale coordinates.
    await shell("rm -f /sdcard/wd-ui.xml");
    const r = await shell("uiautomator dump /sdcard/wd-ui.xml 2>&1 || true");
    if (r.includes("dumped to")) {
      xml = await shell("cat /sdcard/wd-ui.xml 2>/dev/null || true");
      if (xml.includes("<node")) break;
    }
    xml = "";
    await sleep(400 + attempt * 400);
  }
  if (!xml) throw new Error("uiautomator dump failed after 5 attempts");
  const nodes: UiNode[] = [];
  const re = /<node\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const get = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(attrs);
    if (!b) continue;
    nodes.push({
      text: decode(get("text")),
      desc: decode(get("content-desc")),
      cls: get("class"),
      resId: get("resource-id"),
      bounds: [+b[1], +b[2], +b[3], +b[4]],
      clickable: get("clickable") === "true",
      enabled: get("enabled") !== "false",
      editable: get("editable") === "true" || /EditText$/.test(get("class")),
      scrollable: get("scrollable") === "true",
    });
  }
  return nodes;
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");

/**
 * Find the best node matching `text` against its text or content-description.
 * Exact match wins over prefix wins over substring; clickable wins over not; smaller wins
 * over larger (a leaf label beats the whole scroll container that contains it).
 */
export function findNode(nodes: UiNode[], text: string): UiNode | null {
  const want = text.toLowerCase().trim();
  const scored: { n: UiNode; s: number }[] = [];
  for (const n of nodes) {
    const cands = [n.text, n.desc].map((v) => v.toLowerCase().trim()).filter(Boolean);
    let best = -1;
    for (const c of cands) {
      if (c === want) best = Math.max(best, 100);
      else if (c.startsWith(want)) best = Math.max(best, 70);
      else if (c.includes(want)) best = Math.max(best, 40);
    }
    if (best < 0) continue;
    const area = (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);
    if (area <= 0) continue;
    scored.push({ n, s: best + (n.clickable ? 15 : 0) - Math.min(14, area / (device.width * device.height) * 30) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored[0]?.n ?? null;
}

export const centerOf = (n: UiNode): [number, number] =>
  [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)];

export const tap = (x: number, y: number) => shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
export const back = () => shell("input keyevent 4");
export const swipe = (x1: number, y1: number, x2: number, y2: number, ms = 400) =>
  shell(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`);

/** `input text` cannot carry spaces or shell metacharacters unescaped. */
export const typeText = (s: string) =>
  shell(`input text ${JSON.stringify(s.replace(/ /g, "%s"))}`);

export const norm = (x: number, y: number) => ({ x: x / device.width, y: y / device.height });

export async function deviceInfo() {
  const [size, density, fp, sdk] = await Promise.all([
    shell("wm size"), shell("wm density"),
    shell("getprop ro.build.fingerprint"), shell("getprop ro.build.version.sdk"),
  ]);
  const s = /(\d+)x(\d+)\s*$/.exec(size.trim().split("\n").pop() ?? "");
  const d = /(\d+)\s*$/.exec(density.trim().split("\n").pop() ?? "");
  return {
    width: s ? +s[1] : 0, height: s ? +s[2] : 0, densityDpi: d ? +d[1] : 0,
    fingerprint: fp.trim(), sdk: sdk.trim(),
  };
}
