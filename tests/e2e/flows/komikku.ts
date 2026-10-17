import { wait, type Flow } from "../types.ts";

export const komikku: Flow = {
  app: "komikku",
  pkg: "app.komikku",
  activity: "eu.kanade.tachiyomi.ui.main.MainActivity",
  apk: "Komikku-arm64-v8a-v1.14.1.apk",
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  clock: "pinned",
  // The bundled requery SQLite logs SQLITE_WARNING (28), SQLITE_NOTICE_RECOVER_WAL (283) and
  // SQLITE_WARNING_AUTOINDEX (284) at error level, on a device as here.
  expectedErrors: ["[logcat] E/SQLiteLog: (28) ", "[logcat] E/SQLiteLog: (283) ", "[logcat] E/SQLiteLog: (284) "],
  privateStorage: {
    files: [{ path: "storage/local/Compatibility sample/Chapter 1/001.png", fixture: "komikku-page.png" }],
    expectedFiles: [{ pathPrefix: "files/", suffix: ".tachibk", minBytes: 100 }],
  },
  steps: [
    { id: "launch", label: "Launch onboarding", action: { type: "launch" }, wait: wait.quiescent(6000, 30000) },
    { id: "dismiss-update", label: "Dismiss update notes", action: { type: "tapText", text: "OK" }, wait: wait.quiescent(1500) },
    { id: "storage-step", label: "Open storage step", action: { type: "tapText", text: "Next" }, wait: wait.quiescent(1500) },
    { id: "select-storage", label: "Grant storage folder", action: { type: "tapText", text: "Select a folder" },
      wait: wait.state({ kind: "text", text: "content://com.android.externalstorage.documents" }, 5000, 20000) },
    { id: "permissions-step", label: "Continue to permissions", action: { type: "tapText", text: "Next" }, wait: wait.quiescent(1500) },
    { id: "finish-step", label: "Finish onboarding permissions", action: { type: "tapText", text: "Next" }, wait: wait.quiescent(1500) },
    // finishing onboarding can leave the welcome page still for seconds before the library replaces it
    { id: "library", label: "Open library", action: { type: "tapText", text: "Get started" },
      wait: wait.state({ kind: "text", text: "Updates" }, 5000, 20000) },
    { id: "browse", label: "Browse sources", action: { type: "tapText", text: "Browse" }, wait: wait.quiescent(2000) },
    { id: "local-source", label: "Open local source", action: { type: "tapText", text: "Local source" }, wait: wait.quiescent(2000) },
    { id: "manga", label: "Open local manga", action: { type: "tapText", text: "Compatibility sample" }, wait: wait.quiescent(2500) },
    // the Start FAB: Material 3's extended FAB clears its label's semantics, so uiautomator sees no text
    { id: "reader", label: "Read local chapter", action: { type: "tapAt", x: 0.816, y: 0.906 }, wait: wait.quiescent(2500) },
    { id: "reader-tap", label: "Dismiss reader guide", action: { type: "tapAt", x: 0.5, y: 0.5 }, wait: wait.quiescent(1000) },
    { id: "reader-back", label: "Return to manga", action: { type: "back" }, wait: wait.quiescent(1500) },
    { id: "add-library", label: "Add manga to library", action: { type: "tapText", text: "Add to library" }, wait: wait.quiescent(2000) },
    { id: "back-to-source", label: "Return to local source", action: { type: "back" }, wait: wait.quiescent(1000) },
    { id: "back-to-browse", label: "Return to browse", action: { type: "back" }, wait: wait.quiescent(1000) },
    { id: "populated-library", label: "Open populated library", action: { type: "tapText", text: "Library" },
      wait: wait.state({ kind: "text", text: "Compatibility sample" }, 5000, 20000) },
    { id: "more", label: "Open more options", action: { type: "tapText", text: "More" }, wait: wait.quiescent(1000) },
    { id: "data-storage", label: "Open data and storage", action: { type: "tapText", text: "Data and storage" }, wait: wait.quiescent(1200) },
    { id: "backup", label: "Create populated backup", action: { type: "tapText", text: "Create backup" }, wait: wait.quiescent(1800) },
    { id: "backup-confirm", label: "Save populated backup", action: { type: "tapText", text: "Create" }, wait: wait.quiescent(2500) },
    { id: "restore", label: "Open saved backup", action: { type: "tapText", text: "Restore backup" }, wait: wait.quiescent(1500) },
    { id: "restore-confirm", label: "Restore populated backup", action: { type: "tapText", text: "Restore" }, wait: wait.quiescent(2500) },
  ],
};
