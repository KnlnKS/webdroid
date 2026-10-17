// Live API content and an optional notification alert make the launch golden nondeterministic.
// The fast path asserts onboarding, search results and venue resources; the full path retains
// the recorded Android flow. The list shows the API's announcement sheet again on each venue-list
// update while none is shown, and a search's paging can update the list for several seconds.
import { wait, type Flow } from "../types.ts";

const W = 1080, H = 2160;
const N = (x: number, y: number) => ({ x: x / W, y: y / H });

const SHEET_CLOSE = N(960, 207);      // the announcement sheet's X (no text, no content-desc)
const SEARCH_PILL = N(600, 156);      // action-bar search pill (the icon alone is not the target)
const KEYWORD_FIELD = N(600, 168);    // the keyword EditText once the search screen is up
const FIRST_ROW = N(213, 779);        // the first venue row's name
const NEAR_ME = N(963, 618);          // the map's "Near Me" label (the search screen has one too)
const PROMO = "Not a Gold Card Member?";
const VENUE_NAME = "com.resy.android:id/venueName";
const LIST_VENUE = "com.resy.android:id/list_item_venue_name";
const DISMISS_SHEET = { type: "tapAt", ...SHEET_CLOSE, repeat: 30, everyMs: 300, whileText: PROMO, quietMs: 2000 } as const;

export const resy: Flow = {
  app: "resy",
  pkg: "com.resy.android",
  activity: "com.resy.android.ResyActivity",
  apk: "Resy.apk",
  // the Resy API is HTTPS on a live certificate chain
  clock: "live",
  screen: { width: W, height: H, densityDpi: 480 },
  crop: { top: 72, bottom: 72, left: 0, right: 0 },
  steps: [
    { id: "launch", label: "Launch — phone onboarding", action: { type: "launch" }, wait: wait.live(15000),
      fastWait: wait.state({ kind: "text", text: "Enter your mobile phone number to get started." }, 0, 10_000) },
    { id: "alert-ok", label: "Dismiss the upstream notification alert if shown", action: { type: "tapText", text: "OK", optional: true }, wait: wait.live(1500) },
    { id: "onboarding-close", label: "Close onboarding", action: { type: "tapText", text: "close" }, wait: wait.live(3000), fastWait: wait.state({ kind: "text", text: "Near Me" }, 0, 10_000) },
    { id: "location-permission", label: "Allow location when Android asks — nearby list loads", action: { type: "tapText", text: "While using the app", optional: true }, wait: wait.live(25000) },
    { id: "list", label: "Nearby list with live slots and the map", action: { type: "settle" }, wait: wait.live(5000),
      fastWait: wait.state({ kind: "resource", resId: LIST_VENUE }, 0, 20_000) },
    // the sheet arrives seconds after the list, and would take the search tap
    { id: "sheet-close", label: "Close the announcement sheet", action: { type: "tapAt", ...SHEET_CLOSE },
      fastAction: { ...DISMISS_SHEET, appearMs: 10_000 }, wait: wait.live(3000) },
    { id: "search-open", label: "Open search from the action bar", action: { type: "tapAt", ...SEARCH_PILL }, fastAction: { type: "tapText", text: "search" }, wait: wait.live(4000) },
    { id: "search-type", label: 'Type "Carbone"', action: { type: "typeInto", ...KEYWORD_FIELD, text: "Carbone" }, fastAction: { type: "typeInto", ...KEYWORD_FIELD, text: "Car" }, wait: wait.live(2000) },
    { id: "search-go", label: "Search — the list shows the matches", action: { type: "enter" }, wait: wait.live(15000),
      fastWait: wait.state({ kind: "text", text: "Car", resId: LIST_VENUE }, 0, 15_000) },
    { id: "sheet-close-2", label: "Close the re-shown announcement sheet", action: { type: "tapAt", ...SHEET_CLOSE },
      fastAction: DISMISS_SHEET,
      wait: wait.live(3000) },
    { id: "venue", label: "Open the first result — venue page", action: { type: "tapAt", ...FIRST_ROW }, wait: wait.live(15000),
      fastWait: wait.state({ kind: "any", conditions: [
        { kind: "resource", resId: VENUE_NAME }, { kind: "text", text: PROMO, visible: true },
      ] }, 0, 12_000) },
    { id: "venue-offer-close", label: "Close offers covering the venue", action: { type: "settle" },
      fastAction: DISMISS_SHEET,
      wait: wait.live(1000), fastWait: wait.state({ kind: "text-absent", text: PROMO, visible: true }, 0, 6_000, 400) },
    { id: "venue-retry", label: "Open the venue after an offer has covered the result", action: { type: "settle" },
      fastAction: { type: "tapAt", ...FIRST_ROW, unlessResource: VENUE_NAME },
      wait: wait.live(1000), fastWait: wait.state({ kind: "resource", resId: VENUE_NAME }, 0, 10_000, 400) },
    { id: "venue-back", label: "Back to the list", action: { type: "back" }, wait: wait.live(5000), fastWait: wait.state({ kind: "all", conditions: [
      { kind: "resource-absent", resId: VENUE_NAME }, { kind: "text", text: "Car", resId: LIST_VENUE },
    ] }, 0, 6_000) },
    { id: "near-me", label: "Near Me — the location search", action: { type: "tapAt", ...NEAR_ME }, fastAction: { type: "tapText", text: "Near Me" }, wait: wait.live(10000) },
  ],
};
