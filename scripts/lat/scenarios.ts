// The lat scenarios, by name: an apk, the state its launch reaches, and steps. A step with `m` is a gated tap, timed from its pointerup to its
// response; the others are e2e actions (tests/e2e/lib/actions.ts), waits and scroll windows. Coordinates are px of the 1080x2160@480 screen.
import type { Act } from "../../tests/e2e/lib/probe.ts";
import { deviceScreen, pixelsOn, type StateCondition } from "../../tests/e2e/types.ts";

export type Region = [number, number, number, number];
/** a launch's or a tap's response: `state` in the UI tree and `pixels` of each region (changed from the frame before pointerup, not of one color,
 *  or within 1 of an rgb mean), reached within `ms` of the action (a launch: of its first presentation), 8 s unless given */
export type Expectation = { state: StateCondition; pixels: { region: Region; changed?: boolean; nonUniform?: boolean; rgb?: [number, number, number][] }[]; ms?: number };
/** a gated tap (`m` names it), an action, a pause and an idle wait, or `ms` of scrolling back and forth between the ends of `fps` */
export type Step = { m: string; act: Act & { type: "tap" | "tapText" }; expect: Expectation } | { act: Act } | { wait: number } | { fps: Region; ms?: number; name: string };
/** `gate: false` makes a scenario a report, run only when named (a heavy app whose launch waits on live content); `privateStorage`, document and
 *  folder requests take the app's private storage; `repeat` is what --repeat appends */
export type Scenario = { apk: string; gate?: false; privateStorage?: true; launch: Expectation; steps: Step[]; repeat?: Step[] };

const { point, pair } = pixelsOn(deviceScreen());
const at = (x: number, y: number) => ({ type: "tap" as const, ...point(x, y) }), text = (text: string) => ({ type: "tapText" as const, text, required: true });
const shows = (...texts: string[]): StateCondition => ({ kind: "all", conditions: texts.map((text) => ({ kind: "text", text })) });
const changed = (region: Region) => [{ region, changed: true, nonUniform: true }];

const display: Region = [0, 144, 1080, 600], inDisplay = (...texts: string[]): StateCondition => ({ kind: "all", conditions: texts.map((text) => ({ kind: "text", text, within: display })) });
const calculatorm: Scenario = {
  apk: "calculatorm.apk",
  launch: { state: inDisplay("0"), pixels: [{ region: [72, 363, 1008, 561], nonUniform: true }] },
  steps: ([["7", "7", ["7"]], ["plus", "+", ["7 +", "= 7"]], ["7-warm", "7", ["7 + 7", "= 14"]], ["equals", "=", ["7 + 7 =", "14"]], ["clear", "AC", ["0"]], ["8", "8", ["8"]]] as const)
    .map(([m, key, shown]) => ({ m, act: text(key), expect: { state: inDisplay(...shown), pixels: changed([48, 144, 1032, 600]) } })),
};

const navigation = (day: string): Expectation => ({ state: { kind: "text", text: day, resId: "com.github.jamesgay.fitnotes:id/navigation_text_view" }, pixels: changed([280, 144, 800, 270]) });
const fitnotes: Scenario = {
  apk: "FitNotes.apk",
  launch: { state: { kind: "text", text: "Hello New FitNoter!", resId: "android:id/title" }, pixels: [{ region: [84, 302, 996, 494], nonUniform: true }] },
  steps: [
    { act: text("Metric (kgs)") }, { act: text("OK") }, { wait: 1000 }, { act: text("OK") },
    ...[1, 2, 3].flatMap(() => [{ m: "next", act: at(995, 207), expect: navigation("TOMORROW") }, { m: "prev", act: at(86, 207), expect: navigation("TODAY") }]),
    { m: "start", act: text("Start New Workout"), expect: { state: { kind: "text", text: "Exercise List", resId: "android:id/alertTitle" }, pixels: changed([75, 522, 1005, 1617]) } },
    { act: text("OK") }, { act: text("OK") }, { act: text("Legs") }, { wait: 500 },
    { fps: [540, 1560, 540, 640], ms: 8000, name: "scroll-legs" },
  ],
};

const screenful = (...texts: string[]): Expectation => ({ state: shows(...texts), pixels: changed([0, 200, 1080, 2000]) });
const komikku: Scenario = {
  apk: "Komikku-arm64-v8a-v1.14.1.apk",
  privateStorage: true,
  launch: { state: shows("OK"), pixels: [{ region: [0, 200, 1080, 2000], nonUniform: true }] },
  steps: [
    { act: text("OK") }, { wait: 1500 },
    { m: "next", act: text("Next"), expect: screenful("Select a folder") },
    { act: text("Select a folder") }, { wait: 2000 }, { act: text("Next") }, { wait: 1500 }, { act: text("Next") }, { wait: 1500 },
    { m: "start", act: text("Get started"), expect: screenful("Updates") }, { wait: 3000 },
    { m: "more", act: text("More"), expect: screenful("Data and storage") }, { wait: 1500 },
    { act: { type: "swipe", from: pair(540, 1700), to: pair(540, 600), ms: 300 } }, { wait: 1500 },
    { m: "settings", act: text("Settings"), expect: screenful("Appearance") }, { wait: 1500 },
    { m: "appearance", act: text("Appearance"), expect: screenful("Theme") }, { wait: 2000 },
    { fps: [540, 1800, 540, 600], ms: 8000, name: "scroll-appearance" },
  ],
  repeat: [{ act: { type: "back" } }, { wait: 800 }, { act: { type: "back" } }, { wait: 800 },
    { m: "settings", act: text("Settings"), expect: screenful("Appearance") }, { wait: 1200 }, { m: "appearance", act: text("Appearance"), expect: screenful("Theme") }, { wait: 1500 }],
};

const welcome: StateCondition = { kind: "text", text: "Welcome!", within: [48, 312, 480, 432] };
const theme = (rgb: [number, number, number]): Expectation => ({ state: shows("Welcome!", "Dark", "Light"), pixels: [{ region: [700, 160, 1000, 240], changed: true, rgb: [rgb] }] });
const DARK: [number, number, number] = [18, 19, 24], LIGHT: [number, number, number] = [250, 248, 255];
const mihon: Scenario = {
  apk: "mihon.apk",
  launch: { state: welcome, pixels: [{ region: [700, 160, 1000, 240], rgb: [LIGHT, DARK] }, { region: [48, 312, 480, 432], nonUniform: true }] },
  steps: [
    { m: "dark", act: text("Dark"), expect: theme(DARK) }, { m: "light", act: text("Light"), expect: theme(LIGHT) },
    { m: "dark-warm", act: text("Dark"), expect: theme(DARK) }, { m: "light-warm", act: text("Light"), expect: theme(LIGHT) },
    { m: "next", act: text("Next"), expect: { state: { kind: "all", conditions: [shows("Select a folder", "Storage guide"), { kind: "text-absent", text: "Dark" }, { kind: "text-absent", text: "Light" }] },
      pixels: changed([96, 672, 984, 960]) } },
  ],
};

const report = (apk: string, state: StateCondition, ms?: number): Scenario =>
  ({ apk, gate: false, launch: { state, pixels: [{ region: [0, 200, 1080, 1900], nonUniform: true }], ms }, steps: [{ wait: 3000 }] });
const youtubeScreen = (...texts: string[]): Expectation => ({ state: shows(...texts), pixels: changed([0, 200, 1080, 1900]) });
const youtube: Scenario = {
  ...report("YouTube.xapk", { kind: "text", text: "Search YouTube" }),
  steps: [
    { wait: 3000 },
    { m: "you", act: text("You"), expect: youtubeScreen("Enjoy your favorite videos") }, { wait: 1500 },
    { m: "settings", act: text("Settings"), expect: youtubeScreen("Account") }, { wait: 1500 },
    { m: "general", act: text("General"), expect: youtubeScreen("Double-tap to seek") }, { wait: 1500 },
    { m: "appearance", act: text("Appearance"), expect: { state: shows("Dark theme"), pixels: changed([100, 700, 980, 1430]) } }, { wait: 1500 },
    { m: "dark", act: text("Dark theme"), expect: youtubeScreen("Double-tap to seek") }, { wait: 2000 },
  ],
};

export const SCENARIOS: Record<string, Scenario> = {
  calculatorm, fitnotes, komikku, mihon, youtube,
  chatgpt: report("ChatGPT.xapk", { kind: "text", text: "Welcome to ChatGPT" }, 60_000),
  reddit: report("Reddit.xapk", { kind: "text", text: "Get Started" }),
  tiktok: report("TikTok.apk", { kind: "resource", resId: "com.zhiliaoapp.musically:id/izv" }, 60_000),
};
