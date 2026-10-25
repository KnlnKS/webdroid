import { pixelsOn, wait, type Flow, type Screen } from "../types.ts";

const screen: Screen = { width: 1080, height: 2160, densityDpi: 480 };
const { point } = pixelsOn(screen);
const tap = (x: number, y: number) => ({ type: "tapAt" as const, ...point(x, y) });

export const chatgpt: Flow = {
  app: "chatgpt",
  pkg: "com.openai.chatgpt",
  activity: "com.openai.chatgpt.MainActivity",
  apk: "ChatGPT.xapk",
  screen,
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  clock: "live",
  steps: [
    { id: "launch", label: "Welcome", action: { type: "launch" }, wait: wait.live(20000), liveWait: wait.state({ kind: "text", text: "Continue" }, 0, 20_000) },
    { id: "skip", label: "Continue as guest", action: { type: "tapText", text: "Skip", optional: true }, wait: wait.live(3000) },
    { id: "continue-guest", label: "Continue as guest when configured with the longer label", action: { type: "tapText", text: "Continue without logging in", optional: true }, wait: wait.live(3000) },
    { id: "continue-welcome", label: "Dismiss the compact welcome sheet when present", action: { type: "tapText", text: "Continue", optional: true }, wait: wait.live(3000) },
    { id: "prompt", label: "Enter a guest question", action: { type: "typeInto", x: 360 / screen.width, y: 1980 / screen.height, text: "What is two plus two?" }, wait: wait.live(1000) },
    { id: "send", label: "Send the question", action: tap(965, 1980), wait: wait.live(15000) },
    { id: "response", label: "Receive a real service response", action: { type: "settle" }, wait: wait.live(10000), liveWait: wait.state({ kind: "text", text: "4" }, 0, 20_000) },
    { id: "resume", label: "Retain the conversation after backgrounding", action: { type: "background", ms: 1000 }, wait: wait.live(4000) },
    { id: "attachments", label: "Open the attachment menu", action: tap(105, 1980), wait: wait.live(2000) },
    { id: "photos", label: "Show the guest attachment login requirement", action: { type: "tapText", text: "Photos" }, wait: wait.live(2000) },
    { id: "photos-back", label: "Return from the attachment login sheet", action: { type: "back" }, wait: wait.live(1000) },
    { id: "attachment-tools", label: "Reopen attachments", action: tap(105, 1980), wait: wait.live(1000) },
    { id: "plugins", label: "Show plugin choices and icons", action: { type: "tapText", text: "Plugins" }, wait: wait.live(3000) },
    { id: "plugins-close", label: "Clear the plugin query", action: { type: "typeInto", x: 360 / screen.width, y: 1980 / screen.height, text: "" }, wait: wait.live(1000) },
    { id: "menu", label: "Open navigation", action: tap(100, 100), wait: wait.live(2000) },
    { id: "settings", label: "Guest settings", action: { type: "tapText", text: "Settings" }, wait: wait.live(3000), liveWait: wait.state({ kind: "text", text: "Data controls" }, 0, 6_000) },
    { id: "language", label: "Open the app language dialog", action: { type: "tapText", text: "Language" }, wait: wait.live(2000) },
    { id: "language-back", label: "Dismiss the language dialog", action: { type: "back" }, wait: wait.live(1000) },
    { id: "about", label: "Open app information", action: { type: "tapText", text: "About" }, wait: wait.live(2000), liveWait: wait.state({ kind: "text", text: "Licenses" }, 0, 6_000) },
    { id: "about-back", label: "Return from app information", action: { type: "back" }, wait: wait.live(1000) },
    { id: "settings-back", label: "Return from settings", action: { type: "back" }, wait: wait.live(2000) },
    { id: "menu-back", label: "Close navigation", action: { type: "back" }, wait: wait.live(2000) },
    { id: "login", label: "Open the login sheet", action: tap(900, 100), wait: wait.live(3000) },
    { id: "login-back", label: "Dismiss login and retain the conversation", action: { type: "back" }, wait: wait.live(2000) },
  ],
};
