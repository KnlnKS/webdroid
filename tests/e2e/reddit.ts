// Opt-in authenticated smoke diagnostic; never records the credential screens.
import { mkdir, rm } from "node:fs/promises";
import { WebdroidDriver } from "./drivers/webdroid";
import { observeDrawnText } from "./lib/drawn-text";
import { BASE_URL, E2E_DIR, sleep } from "./lib/util";

const username = process.env.REDDIT_USERNAME;
const password = process.env.REDDIT_PASSWORD;
if (!username || !password) throw new Error("Set REDDIT_USERNAME and REDDIT_PASSWORD to run the authenticated diagnostic");
const secrets = [username, password];
const redact = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
const out = `${E2E_DIR}actual/reddit`;
const timeoutMs = 120_000;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const driver = await WebdroidDriver.launch();
const runs: unknown[] = [];
let authenticated = false;
let seenMissing = new Set<string>();
let seenErrors = new Set<string>();
let stage = "login";
let failure: string | undefined;

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

async function capture(id: string, start: number, error?: string): Promise<void> {
  const snapshot = await driver.snapshot();
  const missing = await driver.missing();
  const errors = (await driver.logs()).filter((line) => line.startsWith("error:"));
  const texts = await drawn();
  const record = {
    id, ms: Date.now() - start, mainLoopWedged: snapshot.wedged,
    texts: texts.map(redact), perf: await driver.perf(),
    newMissing: missing.filter((item) => !seenMissing.has(item)),
    newErrors: errors.filter((item) => !seenErrors.has(item)).map(redact),
    nativeRequired: await driver.nativeRequired(), error,
  };
  seenMissing = new Set(missing);
  seenErrors = new Set(errors);
  await Bun.write(`${out}/${id}.png`, snapshot.png);
  runs.push(record);
  console.log(`${id}: ${record.ms}ms${snapshot.wedged ? " MAIN LOOP WEDGED" : ""}${error ? ` ${error}` : ""}`);
  if (snapshot.wedged) throw new Error(`${id}: main loop wedged`);
}

async function step(id: string, action: () => Promise<void>, labels: string[], absent: string[] = []): Promise<void> {
  stage = id;
  await driver.perfReset();
  const start = Date.now();
  const frame = await driver.page.evaluate(() => globalThis.__e2eDrawnText.frame);
  await action();
  await waitFor(id, async () => {
    const next = await driver.page.evaluate(() => globalThis.__e2eDrawnText);
    return next.frame > frame && labels.every((label) => next.texts.some((text) => contains(text, label))) &&
      absent.every((label) => !next.texts.some((text) => contains(text, label)));
  });
  await capture(id, start);
}

try {
  await driver.setClock(Date.now());
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
  for (const field of [{ x: 0.5, y: 0.434, text: username }, { x: 0.4, y: 0.518, text: password }]) {
    await driver.page.evaluate(async ({ x, y, text }) => {
      await wd.tap(x, y);
      await wd.type(text);
    }, { x: field.x * driver.screen.width, y: field.y * driver.screen.height, text: field.text });
    await sleep(2000);
  }
  await driver.tapNorm(0.5, 0.92);
  await waitText("Home");
  authenticated = true;
  console.log("login: authenticated Home rendered");
  await waitFor("loaded feed", async () => (await drawn()).some((text) => /^[ru]\//.test(text)));
  await capture("feed", Date.now());
  await step("drawer", () => driver.tapNorm(0.076, 0.0625), ["Popular", "Your Communities"]);
  await step("drawer-back", () => driver.back(), ["Home"], ["Your Communities"]);
  if ((await drawn()).some((text) => text.includes("Join the conversation"))) {
    throw new Error("Post marker is already on the feed; cannot measure a detail transition");
  }
  await step("post", () => driver.tapNorm(0.5, 0.2), ["Join the conversation"]);
  for (let i = 0; i < 5 && !(await drawn()).some((text) => contains(text, "Reply")); i++) {
    await step(`comments-scroll-${i + 1}`, () => driver.swipe([0.5, 0.8], [0.5, 0.3]), ["Join the conversation"]);
  }
  await waitText("Reply");
  await capture("comments", Date.now());
  await step("composer", () => driver.tapNorm(0.48, 0.93), ["Commenting on"]);
  await step("composer-back", () => driver.back(), ["Join the conversation", "Reply"], ["Commenting on"]);
  await driver.settle();
  await step("post-back", () => driver.back(), ["Home"], ["Join the conversation"]);
} catch (error) {
  const message = redact(error instanceof Error ? error.message : String(error));
  failure = message;
  if (authenticated) await capture(`${stage}-failed`, Date.now(), message).catch(() => {});
  console.error(message);
  process.exitCode = 1;
} finally {
  await Bun.write(`${out}/run.json`, JSON.stringify({
    url: BASE_URL, jsFlags: process.env.WEBDROID_JS_FLAGS ?? "", failedAt: failure ? stage : undefined, error: failure, runs,
  }, null, 2));
  await driver.close();
}
