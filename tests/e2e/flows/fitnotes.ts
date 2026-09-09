// FitNotes flow — authored against live uiautomator dumps on webdroid_ref (720x1280 @320dpi).
//
// Two arcs: log two sets against a stock exercise and read its graph, then create a custom
// exercise from scratch, log against it, and read ITS graph. Aspirational by design — it
// deliberately crosses surfaces the implementation history lists as unfinished (overflow menu, EditText box
// styling, the ViewPager draw/settle gap), because the flow is the target, not a certificate.
import type { Flow } from "../types";

// Normalized centres verified on-device. EditTexts and ActionBar icons carry no matchable
// text, so they are tapped positionally; everything else uses a text anchor.
const N = (x: number, y: number) => ({ x: x / 720, y: y / 1280 });

const WEIGHT_FIELD = N(360, 353);
const REPS_FIELD = N(360, 531);
const NAME_FIELD = N(360, 285);
const CATEGORY_SPINNER = N(360, 683);
const AB_CREATE_EXERCISE = N(552, 96);   // content-desc "Create New Exercise"
const AB_SAVE = N(664, 96);              // content-desc "Save" (not "Save and New")
const AB_UP = N(48, 96);                 // content-desc "…, Navigate up"

/** Log one set: weight, reps, save. Focus+type is one atomic step (see Action.typeInto). */
const logSet = (n: number, weight: string, reps: string) => [
  { id: `${n}-weight`, label: `Enter weight ${weight} (set ${n})`,
    action: { type: "typeInto", ...WEIGHT_FIELD, text: weight } as const, settleDelayMs: 400 },
  { id: `${n}-reps`, label: `Enter reps ${reps} (set ${n})`,
    action: { type: "typeInto", ...REPS_FIELD, text: reps } as const, settleDelayMs: 400 },
  { id: `${n}-save`, label: `SAVE set ${n} (${weight}x${reps})`,
    action: { type: "tapText", text: "SAVE" } as const, settleDelayMs: 900 },
];

export const fitnotes: Flow = {
  app: "fitnotes",
  pkg: "com.github.jamesgay.fitnotes",
  activity: "com.github.jamesgay.fitnotes.feature.home.MainActivity",
  apk: "FitNotes.apk",
  // App content is exactly [0,48]-[720,1232] on both sides: verified against the real
  // hierarchy dump (status bar [0,0][720,48], gesture bar [0,1232][720,1280]).
  crop: { top: 48, bottom: 48, left: 0, right: 0 },
  steps: [
    { id: "launch", label: "Launch — welcome dialog", action: { type: "launch" }, settleDelayMs: 1500 },
    { id: "unit-metric", label: "Choose Metric (kgs)", action: { type: "tapText", text: "Metric (kgs)" } },
    { id: "welcome-ok", label: "Dismiss welcome dialog", action: { type: "tapText", text: "OK" } },
    { id: "home-tip-ok", label: "Dismiss Home tutorial", action: { type: "tapText", text: "OK" } },
    { id: "home", label: "Workout log — empty", action: { type: "settle" } },

    { id: "start-workout", label: "Start New Workout", action: { type: "tapText", text: "Start New Workout" } },
    { id: "exlist-tip-ok", label: "Dismiss Exercise List tip", action: { type: "tapText", text: "OK" } },
    { id: "routines-tip-ok", label: "Dismiss Workout Routines tip", action: { type: "tapText", text: "OK" } },
    { id: "categories", label: "Exercise categories (SQLite)", action: { type: "settle" } },
    { id: "cat-biceps", label: "Open Biceps", action: { type: "tapText", text: "Biceps" } },
    { id: "ex-barbell-curl", label: "Open Barbell Curl", action: { type: "tapText", text: "Barbell Curl" }, settleDelayMs: 900 },

    ...logSet(1, "60", "10"),
    ...logSet(2, "65", "8"),
    { id: "tab-history", label: "HISTORY tab", action: { type: "tapText", text: "HISTORY" }, settleDelayMs: 700 },
    { id: "tab-graph", label: "GRAPH tab — one exercise plotted", action: { type: "tapText", text: "GRAPH" }, settleDelayMs: 1200 },

    { id: "back-to-exlist", label: "Back to exercise list", action: { type: "back" }, settleDelayMs: 700 },
    { id: "new-exercise-open", label: "Create New Exercise", action: { type: "tapAt", ...AB_CREATE_EXERCISE }, settleDelayMs: 700 },
    { id: "new-name", label: 'Name it "Webdroid Press"',
      action: { type: "typeInto", ...NAME_FIELD, text: "Webdroid Press" }, settleDelayMs: 500 },
    { id: "new-category-open", label: "Open category spinner", action: { type: "tapAt", ...CATEGORY_SPINNER }, settleDelayMs: 900 },
    { id: "new-category-chest", label: "Choose Chest", action: { type: "tapText", text: "Chest" }, settleDelayMs: 600 },
    { id: "new-save", label: "Save new exercise", action: { type: "tapAt", ...AB_SAVE }, settleDelayMs: 900 },

    { id: "up-to-categories", label: "Up to categories", action: { type: "tapAt", ...AB_UP }, settleDelayMs: 700 },
    { id: "cat-chest", label: "Open Chest", action: { type: "tapText", text: "Chest" }, settleDelayMs: 700 },
    { id: "scroll-chest", label: "Scroll to the custom exercise",
      action: { type: "swipe", from: [0.5, 0.781], to: [0.5, 0.3125], ms: 400 }, settleDelayMs: 900 },
    { id: "ex-custom", label: "Open Webdroid Press", action: { type: "tapText", text: "Webdroid Press" }, settleDelayMs: 900 },

    ...logSet(3, "40", "12"),
    ...logSet(4, "45", "10"),
    { id: "custom-graph", label: "GRAPH — custom exercise", action: { type: "tapText", text: "GRAPH" }, settleDelayMs: 1200 },

    { id: "back-1", label: "Back to exercise list", action: { type: "back" }, settleDelayMs: 700 },
    { id: "back-2", label: "Back to categories", action: { type: "back" }, settleDelayMs: 700 },
    { id: "home-final", label: "Home — workout logged", action: { type: "back" }, settleDelayMs: 1200 },
  ],
};
