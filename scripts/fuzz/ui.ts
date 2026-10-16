import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PNG } from "pngjs";
import { diffImages } from "../../tests/e2e/lib/diff.ts";
import { savePng, type Img } from "../../tests/e2e/lib/png.ts";
import { diagnosed, readProcesses } from "../../tests/e2e/lib/processes.ts";
import type { UiNode } from "../../tests/e2e/types.ts";
import { Random } from "./random.ts";
import { matchIdentity, semanticKeys, validateUiAction, type UiAction } from "./ui-model.ts";
import { UiExplorer, type UiPrefix } from "./ui-explorer.ts";
import { inspectUiApp, openUiTargets, type UiApp } from "./ui-targets.ts";
import { sameFailure, validateFailure, type Failure } from "./model.ts";
import { injectedUiFailure } from "./injected.ts";

const STEP_DEADLINE_MS = 5_000;

type UiStep = {
  index: number;
  action: UiAction;
  androidTreeHash?: string;
  webdroidTreeHash: string;
  androidFrameHash?: string;
  webdroidFrameHash: string;
  structuralDivergence?: string;
  pixel?: { strictPct: number; tolerantPct: number; contentDiffPct: number } | { sizeMismatch: string };
  diagnostics: { status: "ok"; alive: boolean; errors: string[]; processes: Awaited<ReturnType<typeof readProcesses>> }
    | { status: "action-failure"; message: string };
  signals: string[];
  state?: string;
  nextState?: string;
  discoveries?: number;
  artifacts?: { android?: string; webdroid: string; diff?: string };
};

export type UiOptions = { apks: string[]; seed: number; steps: number; oracle?: string; out: string };
type UiRunPlan = { kind: "explore"; explorer: UiExplorer; prefix: UiPrefix; artifactLabel: string }
  | { kind: "replay"; actions: readonly UiAction[]; artifactLabel?: string };
export type UiRun = { steps: UiStep[]; environment: Record<string, unknown>; replayDivergence?: string };
export type UiObservation = { actions: UiAction[]; failure: Failure; run: UiRun };
export type UiFailureBundle = {
  schemaVersion: 1;
  kind: "ui";
  seed: number;
  app: UiApp;
  original: UiObservation;
  minimized: UiObservation;
  reproductions: [UiObservation, UiObservation];
  injected?: true;
};

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex").slice(0, 20);
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
    if (diagnostics.status === "exited") continue;
    if (diagnostics.status !== "ok") { signals.push(`harness:${process.url}`); continue; }
    const prefix = diagnostics.pkg ?? process.url;
    for (const value of diagnostics.missing) signals.push(`missing:${prefix}:${value}`);
    for (const value of diagnostics.native) signals.push(`native:${prefix}:${value}`);
    for (const value of diagnostics.errors ?? []) signals.push(`error:${prefix}:${value}`);
    const perf = diagnostics.perf;
    if (perf?.drawErrors) signals.push(`draw:${prefix}`);
    if (perf?.glErrors) signals.push(`gl:${prefix}`);
  }
  return signals;
}

async function runApk(app: UiApp, options: UiOptions, apkIndex: number, plan: UiRunPlan): Promise<UiRun> {
  const random = new Random((options.seed ^ Math.imul(apkIndex + 1, 0x9e3779b1)) >>> 0);
  const targets = await openUiTargets(app, options.oracle);
  const web = targets.webdroid, android = targets.android;
  const environment: Record<string, unknown> = {};
  const seenSignals = new Set<string>(), seenTrees = new Set<string>(), seenFrames = new Set<string>();
  const steps: UiStep[] = [];
  let nextAndroidNodes: UiNode[] | undefined;
  try {
    environment.webdroid = { origin: web.origin, userAgent: await web.page.evaluate(() => navigator.userAgent) };
    if (android) environment.android = android.environment;
    const bootProcesses = await readProcesses(web.page);
    const bootSignals = [...processSignals(bootProcesses), ...web.errors.map((error) => `page-error:${error}`)];
    environment.bootSignals = bootSignals;
    for (const signal of bootSignals) seenSignals.add(signal);
    const stepCount = plan.kind === "replay" ? plan.actions.length : options.steps;
    for (let index = 0; index < stepCount; index++) {
      const webNodes = await web.tree();
      const androidNodes = android ? nextAndroidNodes ?? await android.tree() : undefined;
      const source = androidNodes ?? webNodes, sourceSize = screenSize(source);
      const path = steps.map((step) => step.action);
      const states = steps.flatMap((step) => step.state ? [step.state] : []);
      const state = plan.kind === "explore" ? plan.explorer.observeState(source, sourceSize.width, sourceSize.height,
        { actions: path, states, target: null }) : undefined;
      if (plan.kind === "explore") {
        if (index < plan.prefix.actions.length && state !== plan.prefix.states[index])
          return { steps, environment, replayDivergence: `prefix state ${index}: expected ${plan.prefix.states[index]}, observed ${state}` };
        if (index === plan.prefix.actions.length && plan.prefix.target && state !== plan.prefix.target)
          return { steps, environment, replayDivergence: `prefix destination: expected ${plan.prefix.target}, observed ${state}` };
      }
      const action = plan.kind === "replay" ? plan.actions[index] :
        plan.prefix.actions[index] ?? (state ? plan.explorer.choose(state, random) : null);
      if (!action) break;
      const missingTarget = "target" in action && !matchIdentity(webNodes, action.target);
      const preDivergence = androidNodes ? treeDivergence(androidNodes, webNodes) : undefined;
      const structuralDivergence = missingTarget ? `target absent: ${stable(action.target)}` : preDivergence;
      try {
        if (!structuralDivergence) await withDeadline(Promise.all([
          android ? android.act(action, sourceSize) : Promise.resolve(),
          web.act(action, webNodes),
        ]).then(() => undefined), `UI step ${index}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (state && plan.kind === "explore") {
          plan.explorer.observeAction(state, action, [`timeout-or-error:${message}`], index >= plan.prefix.actions.length);
          await plan.explorer.save();
        }
        steps.push({ index, action, webdroidTreeHash: hash(webNodes), webdroidFrameHash: "", structuralDivergence: message,
          diagnostics: { status: "action-failure", message }, signals: [`timeout-or-error:${message}`] });
        break;
      }
      await sleep(250);
      const [androidPng, webPng, relevant, alive, nextWebTree, postAndroidNodes] = await Promise.all([
        android?.screenshot(), web.screenshot(), readProcesses(web.page), web.alive(), web.tree(), android?.tree(),
      ]);
      nextAndroidNodes = postAndroidNodes;
      if (!relevant.length || relevant.some((process) => !diagnosed(process.diagnostics)))
        throw new Error(`missing process telemetry at UI step ${index}: ${relevant.map((process) =>
          `${process.url}: ${process.diagnostics.status === "failure" ? process.diagnostics.message : process.diagnostics.status}`).join("; ")}`);
      const signals = processSignals(relevant);
      for (const error of web.errors) signals.push(`page-error:${error}`);
      if (!alive) signals.push("wedge:foreground");
      const webTreeHash = hash(nextWebTree), webFrameHash = hash(webPng);
      const androidTreeHash = postAndroidNodes ? hash(postAndroidNodes) : undefined, androidFrameHash = androidPng ? hash(androidPng) : undefined;
      const newSignals = signals.filter((signal) => !seenSignals.has(signal));
      const novel = newSignals.length || !seenTrees.has(webTreeHash) || !seenFrames.has(webFrameHash) || structuralDivergence;
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
        diagnostics: { status: "ok", alive, errors: web.errors, processes: relevant }, signals: newSignals };
      if (state && plan.kind === "explore") {
        step.state = state;
        step.discoveries = plan.explorer.observeAction(state, action, newSignals, index >= plan.prefix.actions.length);
        if (!structuralDivergence && alive) {
          const nextSource = postAndroidNodes ?? nextWebTree;
          const nextSize = screenSize(nextSource);
          step.nextState = plan.explorer.observeState(nextSource, nextSize.width, nextSize.height,
            { actions: [...path, action], states: [...states, state], target: null });
        }
        if (index % 5 === 0) await plan.explorer.save();
      }
      if (novel && plan.artifactLabel) {
        const prefix = `${options.out}/${basename(app.apk).replace(/\.[^.]+$/, "")}-${plan.artifactLabel}-${String(index).padStart(3, "0")}`;
        const artifacts: NonNullable<UiStep["artifacts"]> = { webdroid: `${prefix}-webdroid.png` };
        writeFileSync(artifacts.webdroid, webPng);
        if (androidPng) { artifacts.android = `${prefix}-android.png`; writeFileSync(artifacts.android, androidPng); }
        if (diff) { artifacts.diff = `${prefix}-diff.png`; await savePng(artifacts.diff, diff); }
        step.artifacts = artifacts;
      }
      steps.push(step);
      for (const signal of signals) seenSignals.add(signal);
      seenTrees.add(webTreeHash); seenFrames.add(webFrameHash);
      if (uiFailure([step])) break;
    }
    return { steps, environment };
  } finally {
    try { if (plan.kind === "explore") await plan.explorer.save(); }
    finally {
      try { await android?.close(); }
      finally { await web.close(); }
    }
  }
}

function uiFailure(steps: readonly UiStep[]): Failure | null {
  for (const step of steps) {
    if (step.structuralDivergence) return {
      kind: step.structuralDivergence.includes("timed out") ? "timeout" : "harness-error",
      fingerprint: `ui:structure:${hash(step.structuralDivergence.replace(/UI step \d+/g, "UI step"))}`,
      detail: step.structuralDivergence,
    };
    const signal = step.signals.find((value) => /^(wedge|layout|draw|gl|error|page-error|timeout-or-error|harness):/.test(value));
    if (!signal) continue;
    const category = signal.slice(0, signal.indexOf(":"));
    const kind = category === "wedge" ? "wedge" : category === "layout" ? "layout-error" :
      category === "draw" ? "draw-error" : category === "gl" ? "gl-error" :
      category === "timeout-or-error" ? "timeout" : "harness-error";
    return { kind, fingerprint: `ui:${category}:${hash(signal)}`, detail: signal };
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

export async function minimizeUiActions(input: readonly UiAction[], reproduces: (candidate: UiAction[]) => Promise<boolean>): Promise<UiAction[]> {
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

async function observeUi(app: UiApp, actions: UiAction[], options: UiOptions, expected: Failure, artifactLabel?: string): Promise<UiObservation | null> {
  const run = await runApk(app, options, 0, { kind: "replay", actions, artifactLabel });
  const failure = uiFailure(run.steps);
  return sameFailure(expected, failure) ? { actions, failure: failure!, run } : null;
}

export async function runUi(options: UiOptions): Promise<void> {
  if (!options.apks.length) throw new Error("ui fuzzing requires at least one APK");
  if (!options.steps) throw new Error("--steps must be at least 1");
  mkdirSync(options.out, { recursive: true });
  const apps: UiApp[] = [], runs = [], summaries = [];
  for (const apk of options.apks) apps.push(await inspectUiApp(apk));
  for (let index = 0; index < apps.length; index++) {
    const app = apps[index]!;
    const explorer = await UiExplorer.open(options.out, app.pkg, app.apk);
    const attemptedPrefixes = new Set<string>();
    const retained = new Set<string>();
    const actionLimit = Math.min(Number.MAX_SAFE_INTEGER, options.steps * 3);
    const episodeLimit = Math.min(options.steps, 64);
    let usedActions = 0, replayedActions = 0, exploredActions = 0;
    let remaining = options.steps, episode = 0, prefix: UiPrefix | null = { actions: [], states: [], target: null };
    while (remaining > 0 && prefix !== null && episode < episodeLimit) {
      const available = actionLimit - usedActions - prefix.actions.length;
      if (available <= 0) break;
      const run = await runApk(app, { ...options, steps: prefix.actions.length + Math.min(remaining, available) }, index,
        { kind: "explore", explorer, prefix, artifactLabel: `episode-${episode}` });
      const explored = Math.max(0, run.steps.length - prefix.actions.length);
      const replayed = Math.min(run.steps.length, prefix.actions.length);
      usedActions += run.steps.length;
      replayedActions += replayed;
      exploredActions += explored;
      runs.push({ app, episode, prefix, replayedActions: replayed, exploredActions: explored, ...run });
      remaining -= explored;
      if (!explored) attemptedPrefixes.add(JSON.stringify(prefix));
      if (run.replayDivergence) explorer.rejectPrefix(prefix);
      const failure = uiFailure(run.steps);
      if (failure && !retained.has(failure.fingerprint)) {
        retained.add(failure.fingerprint);
        const bundlePath = `${options.out}/${app.pkg}-${explorer.apkDigest.slice(0, 12)}-${hash(failure.fingerprint)}.failure.json`;
        if (!existsSync(bundlePath)) {
          const input = run.steps.map((step) => step.action);
          const reproduces = async (actions: UiAction[]) => (await observeUi(app, actions, options, failure)) !== null;
          const minimized = await minimizeUiActions(input, reproduces);
          const first = await observeUi(app, minimized, options, failure, `minimized-${episode}`);
          const second = await observeUi(app, minimized, options, failure);
          if (first && second && first.failure.fingerprint === second.failure.fingerprint) {
            const bundle: UiFailureBundle = { schemaVersion: 1, kind: "ui", seed: options.seed, app,
              original: { actions: input, failure, run }, minimized: first, reproductions: [first, second] };
            writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + "\n");
          }
        }
      }
      prefix = explorer.nextPrefix(attemptedPrefixes);
      episode++;
    }
    await explorer.save();
    summaries.push({ app, requestedActions: options.steps, totalActionLimit: actionLimit, usedActions,
      replayedActions, exploredActions, episodes: episode, ...explorer.summary() });
    console.log(`${app.pkg}: ${JSON.stringify(explorer.summary())}`);
  }
  const visualPairs = new Set<string>();
  const visualCandidates = runs.flatMap((run) => run.steps.flatMap((step) => {
    const pixel = step.pixel;
    return pixel && "contentDiffPct" in pixel ? [{ kind: "observation" as const, app: run.app.pkg,
      episode: run.episode, step: step.index, contentDiffPct: pixel.contentDiffPct,
      tolerantPct: pixel.tolerantPct, framePair: `${step.androidFrameHash}:${step.webdroidFrameHash}`,
      artifacts: step.artifacts }] : [];
  })).sort((left, right) => right.contentDiffPct - left.contentDiffPct).filter((candidate) => {
    if (visualPairs.has(candidate.framePair)) return false;
    visualPairs.add(candidate.framePair);
    return true;
  }).slice(0, 10);
  writeFileSync(`${options.out}/ui-${options.seed}.campaign.json`, JSON.stringify({
    schemaVersion: 1, kind: "ui", seed: options.seed, requestedSteps: options.steps, summaries, visualCandidates, runs,
  }, null, 2) + "\n");
  console.log(`UI fuzzed ${apps.length} APK(s); retained artifacts in ${options.out}`);
}

export async function replayUiBundle(path: string, oracle?: string): Promise<boolean> {
  const bundle = validateUiFailureBundle(JSON.parse(readFileSync(path, "utf8")));
  if (bundle.injected) return sameFailure(bundle.minimized.failure, injectedUiFailure(bundle.minimized.actions)) &&
    sameFailure(bundle.minimized.failure, injectedUiFailure(bundle.minimized.actions));
  const options: UiOptions = { apks: [bundle.app.apk], seed: bundle.seed, steps: bundle.minimized.actions.length,
    oracle, out: `${path}.replay` };
  return (await observeUi(bundle.app, bundle.minimized.actions, options, bundle.minimized.failure)) !== null &&
    (await observeUi(bundle.app, bundle.minimized.actions, options, bundle.minimized.failure)) !== null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function uiApp(value: unknown): UiApp {
  const input = object(value, "UI failure bundle.app");
  if (typeof input.apk !== "string" || typeof input.pkg !== "string" || typeof input.activity !== "string")
    throw new Error("UI failure bundle.app is invalid");
  return { apk: input.apk, pkg: input.pkg, activity: input.activity };
}

function uiObservation(value: unknown, label: string): UiObservation {
  const input = object(value, label);
  if (!Array.isArray(input.actions)) throw new Error(`${label}.actions must be an array`);
  const run = object(input.run, `${label}.run`);
  if (!Array.isArray(run.steps)) throw new Error(`${label}.run.steps must be an array`);
  return {
    actions: input.actions.map((action, index) => validateUiAction(action, `${label}.actions[${index}]`)),
    failure: validateFailure(input.failure, `${label}.failure`),
    run: { steps: run.steps as UiStep[], environment: object(run.environment, `${label}.run.environment`) },
  };
}

function validateUiFailureBundle(value: unknown): UiFailureBundle {
  const input = object(value, "UI failure bundle");
  if (input.schemaVersion !== 1 || input.kind !== "ui" || typeof input.seed !== "number") throw new Error("invalid UI failure bundle");
  if (!Array.isArray(input.reproductions) || input.reproductions.length !== 2) throw new Error("UI failure bundle requires two reproductions");
  const original = uiObservation(input.original, "UI failure bundle.original");
  const minimized = uiObservation(input.minimized, "UI failure bundle.minimized");
  const reproductions: [UiObservation, UiObservation] = [
    uiObservation(input.reproductions[0], "UI failure bundle.reproductions[0]"),
    uiObservation(input.reproductions[1], "UI failure bundle.reproductions[1]"),
  ];
  if (reproductions.some((item) => item.failure.fingerprint !== minimized.failure.fingerprint))
    throw new Error("UI failure bundle reproductions disagree");
  const output: UiFailureBundle = { schemaVersion: 1, kind: "ui", seed: input.seed, app: uiApp(input.app), original, minimized, reproductions };
  if (input.injected === true) output.injected = true;
  return output;
}
