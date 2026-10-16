import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { androidTool } from "../android-sdk.ts";
import { openApk } from "../lib.ts";
import { parseAXML, attrStr } from "../../src/android/axml.ts";
import { device, type Screen } from "../../src/shell/config.ts";
import { performAction } from "../../tests/e2e/lib/actions.ts";
import type { Act } from "../../tests/e2e/lib/probe.ts";
import { parseUiAutomator } from "../../tests/e2e/lib/uiautomator.ts";
import type { UiNode } from "../../tests/e2e/types.ts";
import { matchIdentity, type UiAction } from "./ui-model.ts";
import { startWebdroid, type WebdroidSession } from "./webdroid-session.ts";

const STEP_DEADLINE_MS = 5_000;
export type UiApp = { apk: string; pkg: string; activity: string };
export type UiSize = { width: number; height: number };
type Rotation = { accelerometer: string | null; user: string | null };

type Adb = (...args: string[]) => Promise<Buffer>;

export async function inspectUiApp(apkArg: string): Promise<UiApp> {
  const apk = existsSync(apkArg) ? apkArg : `apks/${apkArg}`;
  if (!existsSync(apk)) throw new Error(`missing APK ${apkArg}`);
  const manifest = (await openApk(apk))["AndroidManifest.xml"];
  if (!manifest) throw new Error(`${apk} has no AndroidManifest.xml`);
  const root = parseAXML(manifest), pkg = attrStr(root, "package");
  const application = root.children.find((node) => node.name === "application");
  const launcher = application?.children.find((node) =>
    (node.name === "activity" || node.name === "activity-alias") && node.children.some((filter) =>
      filter.name === "intent-filter" &&
      filter.children.some((entry) => entry.name === "action" && attrStr(entry, "name") === "android.intent.action.MAIN") &&
      filter.children.some((entry) => entry.name === "category" && attrStr(entry, "name") === "android.intent.category.LAUNCHER")));
  const name = launcher && attrStr(launcher, "name");
  if (!pkg || !name) throw new Error(`${apk} has no launchable activity`);
  return { apk, pkg, activity: name.startsWith(".") ? pkg + name : name };
}

function pixels(point: { x: number; y: number }, size: UiSize): [string, string] {
  return [String(Math.round(point.x * size.width)), String(Math.round(point.y * size.height))];
}

export class AndroidUiTarget {
  private readonly adb: Adb; private readonly app: UiApp; private readonly rotation: Rotation;
  readonly environment: { serial: string; fingerprint: string };
  private constructor(adb: Adb, app: UiApp,
    rotation: Rotation, serial: string, fingerprint: string) {
    this.adb = adb; this.app = app; this.rotation = rotation;
    this.environment = { serial, fingerprint };
  }

  private static async restoreRotation(adb: Adb, rotation: Rotation): Promise<void> {
    for (const [name, value] of [["user_rotation", rotation.user], ["accelerometer_rotation", rotation.accelerometer]] as const)
      await adb("shell", "settings", value === null ? "delete" : "put", "system", name, ...(value === null ? [] : [value]));
  }

  static async open(serial: string, app: UiApp): Promise<AndroidUiTarget> {
    const adbPath = androidTool("adb");
    const adb: Adb = async (...args) =>
      (await promisify(execFile)(adbPath, ["-s", serial, ...args], { encoding: "buffer", maxBuffer: 1 << 30, timeout: STEP_DEADLINE_MS })).stdout;
    const [sdk, fingerprint, accelerometer, user] = await Promise.all([
      adb("shell", "getprop", "ro.build.version.sdk"), adb("shell", "getprop", "ro.build.fingerprint"),
      adb("shell", "settings", "get", "system", "accelerometer_rotation"),
      adb("shell", "settings", "get", "system", "user_rotation"),
    ]);
    if (sdk.toString().trim() !== "35") throw new Error(`oracle ${serial} is not API 35`);
    const setting = (result: Buffer): string | null => {
      const value = result.toString().trim();
      return value === "null" ? null : value;
    };
    const rotation = { accelerometer: setting(accelerometer), user: setting(user) };
    try {
      await adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
      await adb("shell", "settings", "put", "system", "user_rotation", "0");
      await adb("uninstall", app.pkg).catch(() => undefined);
      await adb("install", "-r", "-t", app.apk);
      await adb("shell", "am", "force-stop", app.pkg);
      await adb("shell", "am", "start", "-W", "-n", `${app.pkg}/${app.activity}`);
      return new AndroidUiTarget(adb, app, rotation, serial, fingerprint.toString().trim());
    } catch (error) {
      await AndroidUiTarget.restoreRotation(adb, rotation);
      throw error;
    }
  }

  close(): Promise<void> { return AndroidUiTarget.restoreRotation(this.adb, this.rotation); }

  async tree(): Promise<UiNode[]> {
    await this.adb("shell", "uiautomator", "dump", "/sdcard/wd-fuzz-ui.xml");
    return parseUiAutomator((await this.adb("shell", "cat", "/sdcard/wd-fuzz-ui.xml")).toString());
  }

  screenshot(): Promise<Buffer> {
    return this.adb("exec-out", "screencap", "-p");
  }

  async act(action: UiAction, size: UiSize): Promise<void> {
    switch (action.type) {
      case "tap": case "fallback-tap": await this.adb("shell", "input", "tap", ...pixels(action.at, size)); return;
      case "type":
        await this.adb("shell", "input", "tap", ...pixels(action.at, size));
        await this.adb("shell", "input", "text", action.text.replace(/ /g, "%s")); return;
      case "scroll": await this.adb("shell", "input", "swipe", ...pixels(action.from, size), ...pixels(action.to, size), String(action.durationMs)); return;
      case "back": await this.adb("shell", "input", "keyevent", "4"); return;
      case "enter": await this.adb("shell", "input", "keyevent", "66"); return;
      case "background":
        await this.adb("shell", "input", "keyevent", "3"); await sleep(action.durationMs);
        await this.adb("shell", "am", "start", "-n", `${this.app.pkg}/${this.app.activity}`); return;
      case "configuration":
        await this.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
        await this.adb("shell", "settings", "put", "system", "user_rotation", action.orientation === "landscape" ? "1" : "0"); return;
    }
  }
}

function webAction(action: UiAction, nodes: readonly UiNode[], size: UiSize): Act | null {
  const target = "target" in action ? matchIdentity(nodes, action.target) : null;
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

export class WebdroidUiTarget {
  private readonly session: WebdroidSession;
  readonly page: Page;
  readonly origin: string;
  readonly errors: string[];
  private constructor(session: WebdroidSession) {
    this.session = session;
    this.page = session.page; this.origin = session.origin; this.errors = session.errors;
  }

  static async open(app: UiApp): Promise<WebdroidUiTarget> {
    const session = await startWebdroid(app.apk);
    try {
      // the app has drawn; wait up to 3 s for its process to stop drawing and queueing work
      await session.page.evaluate(async () => {
        const read = async () => (await globalThis.wd!.foregroundWorkerSnapshot())?.snapshot;
        const until = performance.now() + 3_000;
        let quietSince = 0, draws = (await read())?.perf.draws;
        while (performance.now() < until) {
          const shown = await read(), now = performance.now();
          quietSince = shown?.main.queued === 0 && shown.perf.draws === draws ? quietSince || now : 0;
          if (quietSince && now - quietSince >= 400) break;
          draws = shown?.perf.draws;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
      return new WebdroidUiTarget(session);
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  tree(): Promise<UiNode[]> {
    return this.page.evaluate(() => globalThis.wd!.uiTree());
  }

  async act(action: UiAction, nodes: readonly UiNode[]): Promise<void> {
    if (action.type === "configuration") {
      await this.page.evaluate((orientation) => globalThis.wd!.configuration(orientation), action.orientation);
      return;
    }
    const screen = await this.screen();
    const act = webAction(action, nodes, screen);
    if (!act) throw new Error(`semantic target absent for ${action.type}`);
    await this.page.evaluate(performAction, { a: act, screen, deadlineMs: STEP_DEADLINE_MS });
  }

  /** the display the foreground process draws at, as rotated; the session's profile geometry
   *  (`WEBDROID_SCREEN` included) while no process is in front */
  private async screen(): Promise<Screen> {
    const size = await this.page.evaluate(async () => {
      const shown = (await globalThis.wd!.foregroundWorkerSnapshot())?.snapshot;
      return shown ? { width: shown.width as number, height: shown.height as number } : null;
    });
    return { width: size?.width ?? device.width, height: size?.height ?? device.height, densityDpi: device.densityDpi };
  }

  /** the shown processes' mirrored frames under the system windows, composited by the e2e probe */
  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.page.evaluate(() => globalThis.__wd.screen()), "base64");
  }

  alive(): Promise<boolean> { return this.page.evaluate(() => globalThis.wd!.alive(2_000)); }
  close(): Promise<void> { return this.session.close(); }
}

export async function openUiTargets(app: UiApp, oracle?: string): Promise<{ webdroid: WebdroidUiTarget; android?: AndroidUiTarget }> {
  const webdroid = await WebdroidUiTarget.open(app);
  try {
    const android = oracle ? await AndroidUiTarget.open(oracle, app) : undefined;
    return { webdroid, android };
  } catch (error) {
    await webdroid.close();
    throw error;
  }
}
