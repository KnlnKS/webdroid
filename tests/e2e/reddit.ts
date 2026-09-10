// Opt-in authenticated smoke diagnostic; never records the credential screens.
import { mkdir, rm } from "node:fs/promises";
import { WebdroidDriver } from "./drivers/webdroid";
import { observeDrawnText } from "./lib/drawn-text";
import { BASE_URL, E2E_DIR, sleep } from "./lib/util";

const username = process.env.REDDIT_USERNAME;
const password = process.env.REDDIT_PASSWORD;
if (!username || !password) throw new Error("Set REDDIT_USERNAME and REDDIT_PASSWORD to run the authenticated diagnostic");
const secrets = [username, password].map(secret => new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
const redact = (text: string) => secrets.reduce((value, secret) => value.replace(secret, "[redacted]"), text);
const out = process.env.REDDIT_OUT_DIR ?? `${E2E_DIR}actual/reddit`;
const timeoutMs = 120_000;
const runTimeoutMs = Number(process.env.REDDIT_TIMEOUT_MS ?? 600_000);
if (!Number.isFinite(runTimeoutMs) || runTimeoutMs <= 0) throw new Error("REDDIT_TIMEOUT_MS must be positive");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
let driver: WebdroidDriver;
let closing: Promise<void> | undefined;
let timedOut = false;
const close = () => driver ? closing ??= driver.close() : Promise.resolve();
const pageErrors: string[] = [];
const runs: unknown[] = [];
let authenticated = false;
let seenMissing = new Set<string>();
let seenErrors = new Set<string>();
let stage = "login";
let failure: string | undefined;
declare global { var __redditGesture: { done: boolean; error?: string }; }

async function waitFor(label: string, ready: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ready()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function drawn(): Promise<string[]> {
  return driver.page.evaluate(() => globalThis.__e2eDrawnText?.texts ?? []);
}

const contains = (text: string, label: string) => text.toLowerCase().includes(label.toLowerCase());

async function waitText(...labels: string[]): Promise<void> {
  await waitFor(labels.join(" / "), async () => {
    const texts = await drawn();
    return labels.every((label) => texts.some((text) => contains(text, label)));
  });
}

async function loginField(name: string, x: number, y: number, text: string): Promise<void> {
  stage = `login-${name}`;
  await driver.tapNorm(x, y);
  await waitFor(`${name} input connection`, () => driver.page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>("#kbd");
    return !!input && document.activeElement === input && input.value === "";
  }));
  const frame = await driver.page.evaluate(() => globalThis.__e2eDrawnText.frame);
  await driver.type(text);
  await waitFor(`${name} input rendered`, () => driver.page.evaluate(({ frame, text, visible }) => {
    const input = document.querySelector<HTMLTextAreaElement>("#kbd"), drawn = globalThis.__e2eDrawnText;
    return input?.value === text && drawn.frame > frame && (!visible || drawn.texts.some(value => value.includes(text)));
  }, { frame, text, visible: name === "username" }));
}

async function loginFailure(error: string): Promise<void> {
  const [texts, logs, missing, perf] = await Promise.all([drawn(), driver.logs(), driver.missing(), driver.perf()]);
  runs.push({ id: stage, error, authenticated: false, texts: texts.map(redact), logs: logs.map(redact),
    missing: missing.map(redact), perf });
}

async function scrollComments(): Promise<void> {
  await driver.page.evaluate(({ width, height }) => {
    const state: { done: boolean; error?: string } = { done: false };
    globalThis.__redditGesture = state;
    void wd.swipe(width * 0.5, height * 0.8, width * 0.5, height * 0.3).then(
      () => { state.done = true; },
      (error: unknown) => { state.error = String(error); state.done = true; });
  }, driver.screen);
  await waitFor("comment swipe completion", () => driver.page.evaluate(() => {
    if (globalThis.__redditGesture.error) throw new Error(globalThis.__redditGesture.error);
    return globalThis.__redditGesture.done;
  }));
}

async function capture(id: string, start: number, error?: string, contentMs?: number): Promise<void> {
  const captureStart = Date.now();
  const snapshot = await driver.snapshot();
  const missing = await driver.missing();
  const logs = await driver.logs();
  const warnings = logs.filter(line => /^error: \[logcat\] E\/stderr: \[[^\]:]+:(?:WARNING|INFO|DEBUG):/.test(line));
  const errors = [...logs.filter(line => /^(error:|window\.error:|unhandledrejection:)/.test(line) && !warnings.includes(line)), ...pageErrors];
  const texts = await drawn();
  const perf = await driver.perf();
  const nativeFault = await driver.page.evaluate(() => wd.native.lastFault.regs);
  const newErrors = errors.filter((item) => !seenErrors.has(item)).map(redact);
  const issues = [snapshot.wedged && "main loop wedged", newErrors.length && `${newErrors.length} errors`,
    nativeFault && "native fault", perf.layoutErrors && `${perf.layoutErrors} layout errors`,
    perf.drawErrors && `${perf.drawErrors} draw errors`, perf.glErrors && `${perf.glErrors} GL errors`].filter(Boolean);
  const record = {
    id, ms: Date.now() - start, contentMs, captureMs: Date.now() - captureStart, mainLoopWedged: snapshot.wedged,
    texts: texts.map(redact), perf, nativeFault, warnings: warnings.map(redact), logs: logs.map(redact),
    newMissing: missing.filter((item) => !seenMissing.has(item)).map(redact), newErrors,
    nativeRequired: await driver.nativeRequired(), error: error ?? (issues.length ? issues.join(", ") : undefined),
  };
  seenMissing = new Set(missing);
  seenErrors = new Set(errors);
  await Bun.write(`${out}/${id}.png`, snapshot.png);
  runs.push(record);
  console.log(`${id}: ${record.ms}ms${snapshot.wedged ? " MAIN LOOP WEDGED" : ""}${error ? ` ${error}` : ""}`);
  if (issues.length) throw new Error(`${id}: ${issues.join(", ")}`);
}

const newProse = (texts: string[], before: Set<string>) => texts.filter(text => text.trim().length >= 24 && /[a-z]{3}/i.test(text) && !before.has(text));
async function step(id: string, action: () => Promise<void>, labels: string[], absent: string[] = [], content = (_texts: string[]) => true): Promise<void> {
  stage = id;
  await driver.perfReset();
  const start = Date.now();
  const frame = await driver.page.evaluate(() => globalThis.__e2eDrawnText.frame);
  await action();
  await waitFor(id, async () => {
    const next = await driver.page.evaluate(() => globalThis.__e2eDrawnText);
    return next.frame > frame && labels.every((label) => next.texts.some((text) => contains(text, label))) &&
      absent.every((label) => !next.texts.some((text) => contains(text, label))) && content(next.texts);
  });
  await capture(id, start, undefined, Date.now() - start);
}

async function run(): Promise<void> {
  driver = await WebdroidDriver.launch();
  if (timedOut) { await close(); throw new Error("Browser launched after the run deadline"); }
  driver.page.removeAllListeners("pageerror");
  driver.page.on("pageerror", error => pageErrors.push("pageerror: " + error.message));
  driver.page.on("crash", () => pageErrors.push("pageerror: renderer crashed"));
  await driver.page.clock.setSystemTime(Date.now());
  await driver.reset({ width: 1080, height: 2424, densityDpi: 480 });
  await driver.page.evaluate(observeDrawnText);
  await driver.boot("Reddit.xapk");
  await waitText("The most real");
  console.log("login: intro rendered");
  await driver.settle();
  await driver.tapNorm(0.5, 0.926);
  await waitText("Use email or username");
  console.log("login: sheet rendered");
  await driver.settle();
  await driver.tapNorm(0.5, 0.8);
  await waitText("Forgot password?");
  console.log("login: form rendered");
  await driver.settle();
  await loginField("username", 0.5, 0.434, username!);
  await loginField("password", 0.4, 0.518, password!);
  stage = "login-submit";
  await driver.tapNorm(0.5, 0.92);
  await waitText("Home");
  authenticated = true;
  console.log("login: authenticated Home rendered");
  stage = "feed";
  await waitFor("loaded feed", async () => (await drawn()).some((text) => /^[ru]\//.test(text)));
  await waitFor("login confirmation dismissed", async () => !(await drawn()).some(text => contains(text, username!)));
  await capture("feed", Date.now());
  await step("drawer", () => driver.tapNorm(0.076, 0.0625), ["Popular", "Your Communities"]);
  await step("drawer-back", () => driver.back(), ["Home"], ["Your Communities"]);
  if ((await drawn()).some((text) => text.includes("Join the conversation"))) {
    throw new Error("Post marker is already on the feed; cannot measure a detail transition");
  }
  const feedTexts = new Set(await drawn());
  await step("post", () => driver.tapNorm(0.5, 0.2), ["Join the conversation"], [],
    texts => !texts.some(text => text.trim() === "Home") && newProse(texts, feedTexts).length >= 2);
  const postTexts = new Set(await drawn());
  const commentsReady = async () => {
    const texts = await drawn();
    return texts.some(text => contains(text, "Reply")) && newProse(texts, postTexts).length > 0;
  };
  for (let i = 0; i < 5 && !await commentsReady(); i++) {
    await step(`comments-scroll-${i + 1}`, scrollComments, ["Join the conversation"]);
  }
  await waitFor("comment text and Reply", commentsReady);
  await capture("comments", Date.now());
  await driver.settle();
  await step("composer", () => driver.tapNorm(0.48, 0.95), ["Commenting on"]);
  await step("composer-back", () => driver.back(), ["Join the conversation", "Reply"], ["Commenting on"]);
  await driver.settle();
  await step("post-back", () => driver.back(), ["Home"], ["Join the conversation"]);
}

let timer: ReturnType<typeof setTimeout>;
try {
  await Promise.race([run(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void close().catch(() => {});
      reject(new Error(`Whole-run deadline exceeded (${runTimeoutMs}ms) at ${stage}`));
    }, runTimeoutMs);
  })]);
} catch (error) {
  const message = redact(error instanceof Error ? error.message : String(error));
  failure = message;
  if (authenticated && !timedOut) await capture(`${stage}-failed`, Date.now(), message).catch(() => {});
  if (!authenticated && !timedOut) await Promise.race([loginFailure(message), sleep(5000)]).catch(() => {});
  console.error(message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer!);
  try {
    await Bun.write(`${out}/run.json`, redact(JSON.stringify({
      url: BASE_URL, jsFlags: process.env.WEBDROID_JS_FLAGS ?? "", timeoutMs: runTimeoutMs, timedOut,
      failedAt: failure ? stage : undefined, error: failure, pageErrors: pageErrors.map(redact), runs,
    }, null, 2)));
  } finally { await close(); }
}
