// Golden pass — the ONLY entry point that touches the emulator.
//
//   bun tests/e2e/capture-emulator.ts [flow...]
//
// Walks each flow on webdroid_ref, resolves every text anchor to a concrete normalized
// coordinate, and writes tests/e2e/golden/<flow>/{NN-id.png, manifest.json}. Run this by hand
// when the flows change; `bun run e2e` then diffs off the committed result with no emulator.
import { mkdir, rm } from "node:fs/promises";
import * as emu from "./drivers/emulator";
import { selectFlows } from "./lib/args";
import { PINNED_CLOCK_MS, SCREEN_W, SCREEN_H, type Flow, type Manifest, type RecordedStep } from "./types";
import { E2E_DIR, sleep } from "./lib/util";
import { device as profile } from "../../src/shell/config";

const flows = selectFlows(process.argv.slice(2), "bun run e2e:record");

async function ensureDevice() {
  const devices = (await emu.sh(["devices"], { quiet: true })).split("\n").filter((l) => /\tdevice$/.test(l));
  if (!devices.length) {
    throw new Error("no emulator attached — run `bash tests/e2e/boot-emulator.sh` first");
  }
  const info = await emu.deviceInfo();
  if (info.width !== SCREEN_W || info.height !== SCREEN_H || info.densityDpi !== profile.densityDpi) {
    throw new Error(
      `device is ${info.width}x${info.height} @${info.densityDpi}dpi — the goldens must come from ` +
      `${SCREEN_W}x${SCREEN_H} @${profile.densityDpi}dpi so no rescaling enters the metric. Use the webdroid_ref AVD.`,
    );
  }
  return info;
}

/** Start once so the app creates its data dir, then write the flow's seed prefs into it. */
async function seedPrefs(flow: Flow) {
  const pkg = flow.pkg;
  await emu.shell(`am start -n ${pkg}/${flow.activity}`);
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

async function record(flow: Flow, device: Awaited<ReturnType<typeof emu.deviceInfo>>) {
  const dir = `${E2E_DIR}golden/${flow.app}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  console.log(`\n=== recording ${flow.app} (${flow.steps.length} steps) ===`);
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
        await emu.shell(`am start -n ${flow.pkg}/${flow.activity}`);
        break;
      case "tapText": {
        const node = emu.findNode(await emu.dumpUi(), a.text);
        if (!node) {
          note = `text anchor "${a.text}" not found on screen`;
          console.warn(`  ! step ${i} ${step.id}: ${note}`);
          break;
        }
        const [cx, cy] = emu.centerOf(node);
        resolved = emu.norm(cx, cy);
        bounds = node.bounds;
        await emu.tap(cx, cy);
        break;
      }
      case "tapAt":
        resolved = { x: a.x, y: a.y };
        await emu.tap(a.x * SCREEN_W, a.y * SCREEN_H);
        break;
      case "typeInto":
        resolved = { x: a.x, y: a.y };
        await emu.tap(a.x * SCREEN_W, a.y * SCREEN_H);
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
      case "swipe":
        await emu.swipe(a.from[0] * SCREEN_W, a.from[1] * SCREEN_H,
                        a.to[0] * SCREEN_W, a.to[1] * SCREEN_H, a.ms ?? 400);
        break;
      case "settle":
        break;
    }

    if (step.settleDelayMs) await sleep(step.settleDelayMs);
    // webdroid has no IME. A soft keyboard in a golden would floor that step's diff near 50%,
    // so it is closed before capture — but only when one is actually up, since the dismiss key
    // also closes dialogs.
    if (await emu.dismissIme()) await sleep(400);

    const { png, timedOut } = await emu.settle();
    const file = `${String(i).padStart(2, "0")}-${step.id}.png`;
    await Bun.write(`${dir}/${file}`, png);
    recorded.push({ id: step.id, label: step.label, index: i, file, resolved, bounds, settleTimedOut: timedOut, note });
    console.log(`  ${String(i).padStart(2, "0")} ${step.label}${timedOut ? "  [settle timeout]" : ""}${note ? "  [" + note + "]" : ""}`);
  }

  const manifest: Manifest = {
    app: flow.app, pkg: flow.pkg, activity: flow.activity,
    recordedAt: new Date().toISOString(),
    pinnedClockMs: PINNED_CLOCK_MS,
    device, crop: flow.crop, steps: recorded,
  };
  await Bun.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`  -> ${dir}`);
}

const device = await ensureDevice();
console.log(`device: ${device.width}x${device.height} @${device.densityDpi}dpi  sdk=${device.sdk}`);
const clock = (await emu.shell("date -u +%s")).trim();
const drift = Math.abs(+clock * 1000 - PINNED_CLOCK_MS);
if (drift > 86_400_000) {
  console.warn(`WARN: device clock is ${new Date(+clock * 1000).toISOString()}, not the pinned ` +
    `${new Date(PINNED_CLOCK_MS).toISOString()}. Re-run boot-emulator.sh or date-bearing screens will drift.`);
}
for (const f of flows) await record(f, device);
console.log("\ndone. Review the goldens, then commit tests/e2e/golden/.");
