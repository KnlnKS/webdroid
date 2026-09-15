import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import { androidTool } from "../android-sdk";
import { diffImages } from "../../tests/e2e/lib/diff";
import { savePng, type Img } from "../../tests/e2e/lib/png";
import { performAction } from "../../tests/e2e/lib/actions";
import type { Act } from "../../tests/e2e/lib/probe";
import { readProcesses } from "../../tests/e2e/lib/processes";
import type { UiNode } from "../../tests/e2e/types";
import { Random } from "./random";
import { generateUiAction, matchIdentity, semanticKeys, type UiAction } from "./ui-model";
import { startWebdroid } from "./webdroid-session";
import type { Failure } from "./model";

const STEP_DEADLINE_MS = 5_000;
type Metadata = { apk: string; pkg: string; activity: string };
type CommandResult = { stdout: Buffer; stderr: string };

type UiStep = {
  index: number;
  action: UiAction;
  androidTreeHash?: string;
  webdroidTreeHash: string;
  androidFrameHash?: string;
  webdroidFrameHash: string;
  structuralDivergence?: string;
  pixel?: { strictPct: number; tolerantPct: number; contentDiffPct: number } | { sizeMismatch: string };
  diagnostics: unknown;
  coverageDelta: string[];
  signals: string[];
  artifacts?: { android?: string; webdroid: string; diff?: string };
};

export type UiOptions = { apks: string[]; seed: number; steps: number; oracle?: string; out: string };
export type UiFailureBundle = {
  schemaVersion: 1;
  kind: "ui";
  seed: number;
  app: Metadata;
  input: UiAction[];
  minimized: UiAction[];
  failure: Failure;
  environment: unknown;
};

async function command(argv: string[], deadlineMs = STEP_DEADLINE_MS): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), deadlineMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`${argv.join(" ")} failed (${code}): ${stderr}`);
  return { stdout: Buffer.from(stdout), stderr };
}

function metadata(apkArg: string): Metadata {
  const apk = existsSync(apkArg) ? apkArg : `apks/${apkArg}`;
  if (!existsSync(apk)) throw new Error(`missing APK ${apkArg}`);
  const result = Bun.spawnSync([androidTool("aapt2"), "dump", "badging", apk]);
  if (result.exitCode !== 0) throw new Error(`aapt2 could not inspect ${apk}: ${result.stderr.toString()}`);
  const out = result.stdout.toString();
  const pkg = /^package: name='([^']+)'/m.exec(out)?.[1];
  const activity = /^launchable-activity: name='([^']+)'/m.exec(out)?.[1];
  if (!pkg || !activity) throw new Error(`${apk} has no launchable activity`);
  return { apk, pkg, activity };
}

function parseUi(xml: string): UiNode[] {
  const nodes: UiNode[] = [], re = /<node\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const attrs = match[1]!;
    const get = (key: string) => new RegExp(`${key}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(attrs);
    if (!bounds) continue;
    const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCharCode(Number(decimal))).replace(/&amp;/g, "&");
    nodes.push({
      text: decode(get("text")), desc: decode(get("content-desc")), cls: get("class"), resId: get("resource-id"),
      bounds: [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])],
      clickable: get("clickable") === "true", enabled: get("enabled") !== "false",
      editable: get("editable") === "true" || /EditText$/.test(get("class")), scrollable: get("scrollable") === "true",
    });
  }
  return nodes;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(typeof value === "string" ? value : stable(value));
  return hasher.digest("hex").slice(0, 20);
}

function image(bytes: Buffer): Img {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

function screenSize(nodes: readonly UiNode[]): { width: number; height: number } {
  return {
    width: Math.max(1, ...nodes.map((node) => node.bounds[2])),
    height: Math.max(1, ...nodes.map((node) => node.bounds[3])),
  };
}

function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${STEP_DEADLINE_MS}ms`)), STEP_DEADLINE_MS);
  })]).finally(() => clearTimeout(timer));
}

function adbFor(serial: string) {
  const adb = androidTool("adb");
  return (...args: string[]) => command([adb, "-s", serial, ...args]);
}

async function androidTree(adb: ReturnType<typeof adbFor>): Promise<UiNode[]> {
  await adb("shell", "uiautomator", "dump", "/sdcard/wd-fuzz-ui.xml");
  return parseUi((await adb("shell", "cat", "/sdcard/wd-fuzz-ui.xml")).stdout.toString());
}

function pixels(point: { x: number; y: number }, size: { width: number; height: number }): [string, string] {
  return [String(Math.round(point.x * size.width)), String(Math.round(point.y * size.height))];
}

async function androidAction(adb: ReturnType<typeof adbFor>, action: UiAction, size: { width: number; height: number }, app: Metadata): Promise<void> {
  switch (action.type) {
    case "tap":
    case "fallback-tap": await adb("shell", "input", "tap", ...pixels(action.at, size)); return;
    case "type":
      await adb("shell", "input", "tap", ...pixels(action.at, size));
      await adb("shell", "input", "text", action.text.replace(/ /g, "%s")); return;
    case "scroll": await adb("shell", "input", "swipe", ...pixels(action.from, size), ...pixels(action.to, size), String(action.durationMs)); return;
    case "back": await adb("shell", "input", "keyevent", "4"); return;
    case "enter": await adb("shell", "input", "keyevent", "66"); return;
    case "background":
      await adb("shell", "input", "keyevent", "3"); await Bun.sleep(action.durationMs);
      await adb("shell", "am", "start", "-n", `${app.pkg}/${app.activity}`); return;
    case "configuration":
      await adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
      await adb("shell", "settings", "put", "system", "user_rotation", action.orientation === "landscape" ? "1" : "0"); return;
  }
}

function webAction(action: UiAction, webNodes: readonly UiNode[], size: { width: number; height: number }): Act | null {
  const target = "target" in action ? matchIdentity(webNodes, action.target) : null;
  const at = target ? { x: ((target.bounds[0] + target.bounds[2]) / 2) / size.width,
    y: ((target.bounds[1] + target.bounds[3]) / 2) / size.height } : "at" in action ? action.at : undefined;
  switch (action.type) {
    case "tap": return target && at ? { type: "tap", ...at } : null;
    case "fallback-tap": return { type: "tap", ...action.at };
    case "type": return target && at ? { type: "type", ...at, text: action.text } : null;
    case "scroll": return target ? { type: "swipe", from: [action.from.x, action.from.y], to: [action.to.x, action.to.y], ms: action.durationMs } : null;
    case "back": return { type: "back" };
    case "enter": return { type: "enter" };
    case "background": return { type: "background", ms: action.durationMs };
    case "configuration": return null;
  }
}

async function runWebAction(page: Page, action: UiAction, webNodes: readonly UiNode[], size: { width: number; height: number }): Promise<void> {
  if (action.type === "configuration") {
    await page.evaluate((orientation) => globalThis.wd.configuration(orientation), action.orientation);
    return;
  }
  const act = webAction(action, webNodes, size);
  if (!act) throw new Error(`semantic target absent for ${action.type}`);
  await page.evaluate(performAction, { a: act, screen: { ...size, densityDpi: 480 }, deadlineMs: STEP_DEADLINE_MS });
}

async function webScreenshot(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => (document.getElementById("screen") as HTMLCanvasElement).toDataURL("image/png"));
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

function treeDivergence(android: readonly UiNode[], web: readonly UiNode[]): string | undefined {
  const expected = new Set(semanticKeys(android)), actual = new Set(semanticKeys(web));
  if (expected.size < 2) return undefined;
  const hits = [...expected].filter((key) => actual.has(key)).length;
  return hits / expected.size < 0.5 ? `semantic overlap ${hits}/${expected.size}` : undefined;
}

function processSignals(processes: Awaited<ReturnType<typeof readProcesses>>): string[] {
  const signals: string[] = [];
  for (const process of processes) {
    const diagnostics = process.diagnostics;
    if (!diagnostics || "failure" in diagnostics) { signals.push(`harness:${process.url}`); continue; }
    const prefix = String(diagnostics.pkg ?? process.url);
    for (const value of diagnostics.missing ?? []) signals.push(`missing:${prefix}:${value}`);
    for (const value of diagnostics.native ?? []) signals.push(`native:${prefix}:${value}`);
    for (const value of diagnostics.unreadAttrs ?? []) signals.push(`attr:${prefix}:${value}`);
    for (const value of diagnostics.errors ?? []) signals.push(`error:${prefix}:${value}`);
    const perf = diagnostics.perf as Record<string, number> | null;
    if (perf?.layoutErrors) signals.push(`layout:${prefix}`);
    if (perf?.drawErrors) signals.push(`draw:${prefix}`);
    if (perf?.glErrors) signals.push(`gl:${prefix}`);
  }
  return signals;
}

function coverage(processes: Awaited<ReturnType<typeof readProcesses>>): Set<string> {
  const out = new Set<string>();
  for (const process of processes) {
    const diagnostics = process.diagnostics;
    if (!diagnostics || "failure" in diagnostics) continue;
    const snapshot = diagnostics.coverage as { methods?: unknown } | null;
    if (!Array.isArray(snapshot?.methods)) continue;
    const pkg = String(diagnostics.pkg ?? process.url);
    for (const method of snapshot.methods) out.add(`${pkg}:${String(method)}`);
  }
  return out;
}

function compactDiagnostics(processes: Awaited<ReturnType<typeof readProcesses>>) {
  return processes.map((process) => {
    const diagnostics = process.diagnostics;
    if (!diagnostics || "failure" in diagnostics) return process;
    const snapshot = diagnostics.coverage as { enabled?: boolean; methods?: unknown[] } | null;
    return { ...process, diagnostics: { ...diagnostics,
      coverage: snapshot ? { enabled: snapshot.enabled === true, methodCount: snapshot.methods?.length ?? 0 } : null } };
  });
}

async function runApk(app: Metadata, options: UiOptions, apkIndex: number, fixedActions?: readonly UiAction[], retainArtifacts = true): Promise<{ steps: UiStep[]; environment: unknown }> {
  const random = new Random((options.seed ^ Math.imul(apkIndex + 1, 0x9e3779b1)) >>> 0);
  const session = await startWebdroid(app.apk, 4098 + apkIndex);
  const adb = options.oracle ? adbFor(options.oracle) : null;
  const environment: Record<string, unknown> = { webdroid: { userAgent: await session.page.evaluate(() => navigator.userAgent) } };
  const seenSignals = new Set<string>(), seenCoverage = new Set<string>(), seenTrees = new Set<string>(), seenFrames = new Set<string>();
  const steps: UiStep[] = [];
  try {
    if (adb) {
      const [sdk, fingerprint] = await Promise.all([adb("shell", "getprop", "ro.build.version.sdk"), adb("shell", "getprop", "ro.build.fingerprint")]);
      if (sdk.stdout.toString().trim() !== "33") throw new Error(`oracle ${options.oracle} is not API 33`);
      environment.android = { serial: options.oracle, fingerprint: fingerprint.stdout.toString().trim() };
      await adb("uninstall", app.pkg).catch(() => undefined);
      await adb("install", "-r", "-t", app.apk);
      await adb("shell", "am", "force-stop", app.pkg);
      await adb("shell", "am", "start", "-W", "-n", `${app.pkg}/${app.activity}`);
    }
    const stepCount = fixedActions?.length ?? options.steps;
    for (let index = 0; index < stepCount; index++) {
      let androidNodes: UiNode[] | undefined;
      const webNodes = await session.page.evaluate(() => globalThis.wd.uiTree() as UiNode[]);
      if (adb) androidNodes = await androidTree(adb);
      const source = androidNodes ?? webNodes, sourceSize = screenSize(source), webSize = { width: 1080, height: 2160 };
      const action = fixedActions?.[index] ?? generateUiAction(random, source, sourceSize.width, sourceSize.height);
      if (!action) break;
      const missingTarget = "target" in action && !matchIdentity(webNodes, action.target);
      const preDivergence = androidNodes ? treeDivergence(androidNodes, webNodes) : undefined;
      const structuralDivergence = missingTarget ? `target absent: ${stable(action.target)}` : preDivergence;
      try {
        if (!structuralDivergence) await withDeadline(Promise.all([
          adb ? androidAction(adb, action, sourceSize, app) : Promise.resolve(),
          runWebAction(session.page, action, webNodes, webSize),
        ]).then(() => undefined), `UI step ${index}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ index, action, webdroidTreeHash: hash(webNodes), webdroidFrameHash: "", structuralDivergence: message,
          diagnostics: null, coverageDelta: [], signals: [`timeout-or-error:${message}`] });
        break;
      }
      await Bun.sleep(250);
      const [androidPng, webPng, processes, alive, nextWebTree] = await Promise.all([
        adb ? adb("exec-out", "screencap", "-p").then((result) => result.stdout) : undefined,
        webScreenshot(session.page), readProcesses(session.page), session.page.evaluate(() => globalThis.wd.alive(2_000)),
        session.page.evaluate(() => globalThis.wd.uiTree() as UiNode[]),
      ]);
      const relevant = processes.filter((process) => process.url.startsWith(session.origin));
      if (!relevant.length || relevant.some((process) => !process.diagnostics || "failure" in process.diagnostics))
        throw new Error(`missing process telemetry at UI step ${index}`);
      const signals = processSignals(relevant);
      for (const error of session.errors) signals.push(`page-error:${error}`);
      if (!alive) signals.push("wedge:foreground");
      const currentCoverage = coverage(relevant);
      const coverageDelta = [...currentCoverage].filter((method) => !seenCoverage.has(method));
      const webTreeHash = hash(nextWebTree), webFrameHash = hash(webPng);
      const androidTreeHash = androidNodes ? hash(androidNodes) : undefined, androidFrameHash = androidPng ? hash(androidPng) : undefined;
      const newSignals = signals.filter((signal) => !seenSignals.has(signal));
      const novel = coverageDelta.length || newSignals.length || !seenTrees.has(webTreeHash) || !seenFrames.has(webFrameHash) || structuralDivergence;
      let pixel: UiStep["pixel"];
      let diff: Img | undefined;
      if (androidPng) {
        const androidImage = image(androidPng), webImage = image(webPng);
        if (androidImage.width === webImage.width && androidImage.height === webImage.height) {
          const result = diffImages(androidImage, webImage, { top: 0, bottom: 0, left: 0, right: 0 });
          pixel = { strictPct: result.strictPct, tolerantPct: result.tolerantPct, contentDiffPct: result.contentDiffPct };
          diff = result.diffImg;
        } else pixel = { sizeMismatch: `${androidImage.width}x${androidImage.height} != ${webImage.width}x${webImage.height}` };
      }
      const step: UiStep = { index, action, androidTreeHash, webdroidTreeHash: webTreeHash, androidFrameHash,
        webdroidFrameHash: webFrameHash, structuralDivergence, pixel,
        diagnostics: { alive, errors: session.errors, processes: compactDiagnostics(relevant) },
        coverageDelta, signals };
      if (novel && retainArtifacts) {
        const prefix = `${options.out}/${basename(app.apk).replace(/\.[^.]+$/, "")}-${String(index).padStart(3, "0")}`;
        const artifacts: NonNullable<UiStep["artifacts"]> = { webdroid: `${prefix}-webdroid.png` };
        await Bun.write(artifacts.webdroid, webPng);
        if (androidPng) { artifacts.android = `${prefix}-android.png`; await Bun.write(artifacts.android, androidPng); }
        if (diff) { artifacts.diff = `${prefix}-diff.png`; await savePng(artifacts.diff, diff); }
        step.artifacts = artifacts;
      }
      steps.push(step);
      for (const signal of signals) seenSignals.add(signal);
      for (const method of currentCoverage) seenCoverage.add(method);
      seenTrees.add(webTreeHash); seenFrames.add(webFrameHash);
      if (structuralDivergence || !alive) break;
    }
    return { steps, environment };
  } finally {
    await session.close();
  }
}

function uiFailure(steps: readonly UiStep[]): Failure | null {
  for (const step of steps) {
    if (step.structuralDivergence) return {
      kind: step.structuralDivergence.includes("timed out") ? "timeout" : "harness-error",
      fingerprint: step.structuralDivergence.includes("target absent") ? "ui:structure:target" :
        step.structuralDivergence.includes("semantic overlap") ? "ui:structure:tree" : "ui:action",
      detail: step.structuralDivergence,
    };
    const signal = step.signals.find((value) => /^(wedge|layout|draw|gl|error|page-error|timeout-or-error|harness):/.test(value));
    if (!signal) continue;
    const category = signal.slice(0, signal.indexOf(":"));
    const kind = category === "wedge" ? "wedge" : category === "layout" ? "layout-error" :
      category === "draw" ? "draw-error" : category === "gl" ? "gl-error" :
      category === "timeout-or-error" ? "timeout" : "harness-error";
    return { kind, fingerprint: `ui:${category}`, detail: signal };
  }
  return null;
}

function shrinkAction(action: UiAction): UiAction[] {
  switch (action.type) {
    case "type": return [
      { ...action, text: "" },
      { ...action, text: action.text.slice(0, 1) },
      { ...action, at: { x: 0, y: 0 } },
    ].filter((candidate) => stable(candidate) !== stable(action));
    case "tap":
    case "fallback-tap": return [{ ...action, at: { x: 0, y: 0 } }];
    case "scroll": return [{ ...action, durationMs: 1 }, { ...action, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } }];
    case "background": return action.durationMs ? [{ ...action, durationMs: 0 }] : [];
    case "configuration": return action.orientation === "landscape" ? [{ ...action, orientation: "portrait" }] : [];
    case "back":
    case "enter": return [];
  }
}

async function minimizeActions(input: readonly UiAction[], reproduces: (candidate: UiAction[]) => Promise<boolean>): Promise<UiAction[]> {
  let current = [...input], rounds = 0;
  for (let chunk = Math.floor(current.length / 2); chunk >= 1 && rounds < 4; chunk = Math.floor(chunk / 2)) {
    let changed = true;
    while (changed && rounds < 4) {
      changed = false;
      for (let start = 0; start < current.length; start += chunk) {
        const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
        if (!candidate.length || !(await reproduces(candidate))) continue;
        current = candidate; changed = true; rounds++; break;
      }
    }
  }
  for (let index = 0; index < current.length; index++) {
    for (const shrunk of shrinkAction(current[index]!)) {
      const candidate = current.map((action, at) => at === index ? shrunk : action);
      if (await reproduces(candidate)) { current = candidate; break; }
    }
  }
  return current;
}

async function reproduceUi(app: Metadata, actions: UiAction[], options: UiOptions, fingerprint: string): Promise<boolean> {
  const result = await runApk(app, { ...options, steps: actions.length }, 0, actions, false);
  return uiFailure(result.steps)?.fingerprint === fingerprint;
}

export async function runUi(options: UiOptions): Promise<void> {
  if (!options.apks.length) throw new Error("ui fuzzing requires at least one APK");
  if (!options.steps) throw new Error("--steps must be at least 1");
  mkdirSync(options.out, { recursive: true });
  const apps = options.apks.map(metadata), runs = [];
  for (let index = 0; index < apps.length; index++) {
    const app = apps[index]!, run = await runApk(app, options, index);
    runs.push({ app, ...run });
    const failure = uiFailure(run.steps);
    if (!failure) continue;
    const input = run.steps.map((step) => step.action);
    const reproduces = (actions: UiAction[]) => reproduceUi(app, actions, options, failure.fingerprint);
    const minimized = await minimizeActions(input, reproduces);
    if (!(await reproduces(minimized)) || !(await reproduces(minimized))) continue;
    const bundle: UiFailureBundle = { schemaVersion: 1, kind: "ui", seed: options.seed, app, input, minimized, failure, environment: run.environment };
    await Bun.write(`${options.out}/${basename(app.apk).replace(/\.[^.]+$/, "")}.failure.json`, JSON.stringify(bundle, null, 2) + "\n");
  }
  await Bun.write(`${options.out}/ui-${options.seed}.campaign.json`, JSON.stringify({
    schemaVersion: 1, kind: "ui", seed: options.seed, requestedSteps: options.steps, runs,
  }, null, 2) + "\n");
  console.log(`UI fuzzed ${apps.length} APK(s); retained artifacts in ${options.out}`);
}

export async function replayUiBundle(path: string, oracle?: string): Promise<boolean> {
  const bundle = JSON.parse(await Bun.file(path).text()) as UiFailureBundle;
  if (bundle.schemaVersion !== 1 || bundle.kind !== "ui" || !Array.isArray(bundle.minimized) || !bundle.failure?.fingerprint)
    throw new Error("invalid UI failure bundle");
  const options: UiOptions = { apks: [bundle.app.apk], seed: bundle.seed, steps: bundle.minimized.length,
    oracle, out: `${path}.replay` };
  return await reproduceUi(bundle.app, bundle.minimized, options, bundle.failure.fingerprint) &&
    await reproduceUi(bundle.app, bundle.minimized, options, bundle.failure.fingerprint);
}
