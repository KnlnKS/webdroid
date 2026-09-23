// Golden pass — the ONLY entry point that touches the emulator.
//
//   bun tests/e2e/capture-emulator.ts [flow...]
//
// Walks each flow on the API 33 oracle, resolves every text anchor to a concrete normalized
// coordinate, and writes tests/e2e/golden/<flow>/{NN-id.png, manifest.json}. Run this by hand
// when the flows change; `bun run e2e --full` then diffs off the committed result with no emulator.
import { mkdir, rm } from "node:fs/promises";
import * as emu from "./drivers/emulator";
import { parseArgs } from "./lib/args";
import { PINNED_CLOCK_MS, screenOf, screenParam, sameScreen, uiFileFor, waitHorizonMs, type Flow, type Manifest, type RecordedStep } from "./types";
import { E2E_DIR, sleep } from "./lib/util";
import { device as profile } from "../../src/shell/config";

const { flows } = parseArgs(process.argv.slice(2), "bun run e2e --record");

async function ensureDevice(flow: Flow) {
  const devices = (await emu.sh(["devices"], { quiet: true })).split("\n").filter((l) => /\tdevice$/.test(l));
  if (!devices.length) {
    throw new Error("no emulator attached — run `bash tests/e2e/boot-emulator.sh` first");
  }
  const expected = screenOf(undefined, flow.screen);
  let info = await emu.deviceInfo();
  if (info.sdk !== String(profile.sdk)) throw new Error(`Android SDK ${info.sdk} cannot record an SDK ${profile.sdk} reference`);
  if (!sameScreen(info, expected)) {
    await emu.shell(`wm size ${expected.width}x${expected.height}`);
    await emu.shell(`wm density ${expected.densityDpi}`);
    info = await emu.deviceInfo();
  }
  if (!sameScreen(info, expected)) throw new Error(`device is ${screenParam(info)}; ${flow.app} requires ${screenParam(expected)}`);
  return info;
}

/** Start once so the app creates its data dir, then write the flow's seed prefs into it. */
async function seedPrefs(flow: Flow) {
  const pkg = flow.pkg;
  await emu.shell(`am start -n ${emu.shellArg(`${pkg}/${flow.activity}`)}`);
  await sleep(6000);
  await emu.shell(`am force-stop ${pkg}`);
  await sleep(1500);
  const uid = (await emu.shell(`stat -c %u /data/data/${pkg}`)).trim();
  const path = `/data/data/${pkg}/shared_prefs/${pkg}_preferences.xml`;
  const b64 = Buffer.from(flow.seedPrefs!, "utf8").toString("base64");
  await emu.shell(`mkdir -p /data/data/${pkg}/shared_prefs`);
  await emu.shell(`echo '${b64}' | base64 -d > ${path}`);
  await emu.shell(`chown ${uid}:${uid} ${path} && chmod 660 ${path} && restorecon ${path}`);
}

/** Point the device at the instant this flow wants, and report it. Needs root. */
async function setDeviceClock(flow: Flow): Promise<number> {
  const ms = flow.clock === "live" ? Date.now() : PINNED_CLOCK_MS;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}` +
    `${d.getUTCFullYear()}.${p(d.getUTCSeconds())}`;
  await emu.shell(`date ${stamp}`, { quiet: true });
  return ms;
}

async function record(flow: Flow, device: Awaited<ReturnType<typeof emu.deviceInfo>>) {
  const dir = `${E2E_DIR}golden/${flow.app}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  console.log(`\n=== recording ${flow.app} (${flow.steps.length} steps) ===`);
  const clockMs = await setDeviceClock(flow);
  await emu.shell(`pm clear ${flow.pkg}`);
  await sleep(1200);
  if (flow.seedPrefs) {
    console.log("  seeding preferences");
    await seedPrefs(flow);
  }

  const recorded: RecordedStep[] = [];
  for (const [i, step] of flow.steps.entries()) {
    const a = step.action;
    let resolved: RecordedStep["resolved"];
    let bounds: RecordedStep["bounds"];
    let note: string | undefined;

    switch (a.type) {
      case "launch":
        await emu.shell(`am start -n ${emu.shellArg(`${flow.pkg}/${flow.activity}`)}`);
        break;
      case "tapText": {
        const node = emu.findNode(await emu.dumpUi(), a.text);
        if (!node) {
          if (!a.optional) {
            note = `text anchor "${a.text}" not found on screen`;
            console.warn(`  ! step ${i} ${step.id}: ${note}`);
          }
          break;
        }
        const [cx, cy] = emu.centerOf(node);
        resolved = { x: cx / device.width, y: cy / device.height };
        bounds = node.bounds;
        await emu.tap(cx, cy);
        break;
      }
      case "tapAt":
        resolved = { x: a.x, y: a.y };
        await emu.tap(a.x * device.width, a.y * device.height);
        break;
      case "typeInto":
        resolved = { x: a.x, y: a.y };
        await emu.tap(a.x * device.width, a.y * device.height);
        await sleep(700);
        await emu.typeText(a.text);
        await sleep(500);
        // An editor is focused and no dialog is open, so ESCAPE is unambiguous here. It also
        // clears the IME navigation strip, which lingers below the keyboard and which webdroid
        // has no equivalent of.
        await emu.shell("input keyevent 111");
        await sleep(500);
        break;
      case "back":
        await emu.back();
        break;
      case "enter":
        await emu.shell("input keyevent 66");
        break;
      case "background":
        await emu.shell("input keyevent 3");
        await sleep(a.ms ?? 1000);
        await emu.shell(`am start -n ${emu.shellArg(`${flow.pkg}/${flow.activity}`)}`);
        break;
      case "swipe":
        for (let n = 0; n < (a.maxSwipes ?? 1); n++) {
          if (a.untilText && emu.findNode(await emu.dumpUi(), a.untilText)) break;
          await emu.swipe(a.from[0] * device.width, a.from[1] * device.height,
                          a.to[0] * device.width, a.to[1] * device.height, a.ms ?? 400);
          if (a.untilText) await sleep(500);
        }
        break;
      case "settle":
        break;
    }

    const horizonMs = waitHorizonMs(step.wait);
    if (horizonMs) await sleep(horizonMs);
    // webdroid has no IME. A soft keyboard in a golden would floor that step's diff near 50%,
    // so it is closed before capture — but only when one is actually up, since the dismiss key
    // also closes dialogs.
    if (await emu.dismissIme()) await sleep(400);

    const { png, timedOut } = await emu.settle();
    const file = `${String(i).padStart(2, "0")}-${step.id}.png`;
    await Bun.write(`${dir}/${file}`, png);
    // The hierarchy this screen actually had. dumpUi already runs for every tapText step and its
    // nodes were thrown away; the whole point of the golden pass is to keep what the device knew.
    let uiFile: string | undefined;
    try {
      await Bun.write(`${dir}/${uiFileFor(file)}`, JSON.stringify(await emu.dumpUi()));
      uiFile = uiFileFor(file);
    } catch (e) { console.log(`     (no hierarchy: ${(e as Error).message})`); }
    recorded.push({ id: step.id, label: step.label, index: i, file, resolved, bounds, uiFile, settleTimedOut: timedOut, note });
    console.log(`  ${String(i).padStart(2, "0")} ${step.label}${timedOut ? "  [settle timeout]" : ""}${note ? "  [" + note + "]" : ""}`);
  }

  const manifest: Manifest = {
    app: flow.app, pkg: flow.pkg, activity: flow.activity,
    recordedAt: new Date().toISOString(),
    pinnedClockMs: clockMs,
    device, crop: flow.crop, steps: recorded,
  };
  await Bun.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`  -> ${dir}`);
}

const device = await ensureDevice(flows[0]!);
console.log(`device: ${device.width}x${device.height} @${device.densityDpi}dpi  sdk=${device.sdk}`);
const clock = (await emu.shell("date -u +%s")).trim();
const drift = Math.abs(+clock * 1000 - PINNED_CLOCK_MS);
if (drift > 86_400_000 && flows.some((f) => f.clock === "controlled")) {
  console.warn(`WARN: device clock is ${new Date(+clock * 1000).toISOString()}, not the pinned ` +
    `${new Date(PINNED_CLOCK_MS).toISOString()}. Re-run boot-emulator.sh or date-bearing screens will drift.`);
}
for (const [index, flow] of flows.entries()) await record(flow, index === 0 ? device : await ensureDevice(flow));
console.log("\ndone. Review the goldens, then commit tests/e2e/golden/.");
