// webdroid shell: the page answers at once while the emulator (emulator.ts) loads behind it; opening an app waits for that.
import { createShell } from "./shell/ui.ts";
import { switchValue } from "./switches.ts";
import type { Emulator } from "./emulator.ts";

let ready: Emulator | undefined;
const launch = (file: string, local?: File) => {
  if (!ready) shell.setState({ kind: "loading", file, stage: "runtime" });
  emulator.then(e => e.boot(file, local), error => shell.setState({ kind: "failed", file, error, retry: null }));
};
const shell = createShell({ launch, back: () => { void ready?.back(); } });
const emulator = import("./emulator.ts").then(m => ready = m.attach(shell));

if (process.env.NODE_ENV !== "production") {
  void fetch("/apks").then((r) => r.json() as Promise<string[]>).catch(() => [] as string[]).then((files) => {
    for (const file of files) shell.addPackage(file);
    const auto = switchValue("apk");
    if (auto && files.includes(auto)) launch(auto);
  });
}
