// Resy (Java/Kotlin, appcompat + Material, RxJava/Retrofit, MapLibre through microG's maps
// module) — guest browsing against the live API, so this is a smoke flow: every step must
// render and nothing may wedge, but the pixels change with the restaurants of the day.
//
// Observed boot: the phone-number onboarding ("Right this way.") under the upstream "Unable to
// configure device for notifications" alert (Firebase 400, reproduces on a device — see the
// implementation history). Closing onboarding reaches ResyListActivity: the MapLibre map with
// the user's location, the nearby list with live slots, and — server-dependent — an
// announcement bottom sheet ("Not a Gold Card Member?") that the API returns again after every
// venue reload, so it is closed twice. Search is the action-bar pill: the keyword field, the
// keyboard's Search key, then the list re-queries /4/find with the matched venues; a row opens
// the venue page (photo, rating, description); back returns to the list. The map's "Near Me"
// label is the location entry: tapping it opens the search screen on the location field (the
// list itself stays on the city default until a location is chosen; the fused fix microG
// derives from browser geolocation reaches ResyLocationManager and the map's own marker).
// Accepted upstream log lines: the Firebase installations/FCM 400s, the Facebook GraphResponse
// 400 and the two "Error parsing JSON" warnings Branch's session callback logs when there is no
// deep link (the referring params carry none of the keys ResyActivity reads).
import type { Flow } from "../types";

const W = 1080, H = 2160;
const N = (x: number, y: number) => ({ x: x / W, y: y / H });

const SHEET_CLOSE = N(960, 207);      // the announcement sheet's X (no text, no content-desc)
const SEARCH_PILL = N(600, 156);      // action-bar search pill (the icon alone is not the target)
const KEYWORD_FIELD = N(600, 168);    // the keyword EditText once the search screen is up
const FIRST_ROW = N(213, 779);        // the first venue row's name
const NEAR_ME = N(963, 618);          // the map's "Near Me" label (the search screen has one too)

export const resy: Flow = {
  app: "resy",
  pkg: "com.resy.android",
  activity: "com.resy.android.ResyActivity",
  apk: "Resy.apk",
  // the Resy API is HTTPS on a live certificate chain
  liveClock: true,
  screen: { width: W, height: H, densityDpi: 480 },
  crop: { top: 72, bottom: 72, left: 0, right: 0 },
  steps: [
    { id: "launch", label: "Launch — onboarding under the notification alert", action: { type: "launch" }, settleDelayMs: 15000 },
    { id: "alert-ok", label: "Dismiss the upstream notification alert", action: { type: "tapText", text: "OK" }, settleDelayMs: 1500 },
    { id: "onboarding-close", label: "Close onboarding", action: { type: "tapText", text: "close" }, settleDelayMs: 3000 },
    { id: "location-permission", label: "Allow location when Android asks — nearby list loads", action: { type: "tapText", text: "While using the app", optional: true }, settleDelayMs: 25000 },
    { id: "list", label: "Nearby list with live slots and the map", action: { type: "settle" }, settleDelayMs: 5000 },
    { id: "sheet-close", label: "Close the announcement sheet", action: { type: "tapAt", ...SHEET_CLOSE }, settleDelayMs: 3000 },
    { id: "search-open", label: "Open search from the action bar", action: { type: "tapAt", ...SEARCH_PILL }, settleDelayMs: 4000 },
    { id: "search-type", label: 'Type "Carbone"', action: { type: "typeInto", ...KEYWORD_FIELD, text: "Carbone" }, settleDelayMs: 2000 },
    { id: "search-go", label: "Search — the list shows the matches", action: { type: "enter" }, settleDelayMs: 15000 },
    { id: "sheet-close-2", label: "Close the re-shown announcement sheet", action: { type: "tapAt", ...SHEET_CLOSE }, settleDelayMs: 3000 },
    { id: "venue", label: "Open the first result — venue page", action: { type: "tapAt", ...FIRST_ROW }, settleDelayMs: 15000 },
    { id: "venue-back", label: "Back to the list", action: { type: "back" }, settleDelayMs: 5000 },
    { id: "near-me", label: "Near Me — the location search", action: { type: "tapAt", ...NEAR_ME }, settleDelayMs: 10000 },
  ],
};
