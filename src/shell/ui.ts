import { device, parseScreen, storeScreen, type Screen } from "./config.ts";

/** Each step of opening an app until its first frame, as the page says it, the share of the bar done when it begins and about how
 *  long it lasts (cold launches of FitNotes, Lichess, Komikku and Reddit took 4-13 s); the app process's steps are its Worker's phases. */
const STAGES = {
  runtime: { text: "Loading Webdroid…", at: 0, ms: 1500 },
  download: { text: "Downloading package…", at: 0.03, ms: 300 },
  open: { text: "Opening package…", at: 0.03, ms: 300 },
  assets: { text: "Preparing local app assets…", at: 0.07, ms: 50 },
  system: { text: "Starting system services…", at: 0.08, ms: 100 },
  attaching: { text: "Starting app process…", at: 0.09, ms: 200 },
  packages: { text: "Installing app…", at: 0.11, ms: 100 },
  platform: { text: "Loading Android…", at: 0.12, ms: 100 },
  application: { text: "Compiling app…", at: 0.13, ms: 1500 },
  ready: { text: "Compiling its first screen…", at: 0.35, ms: 6000 },
} satisfies Record<string, { text: string; at: number; ms: number }>;
type Stage = keyof typeof STAGES;
const stageEnd = (stage: Stage) => Object.values(STAGES).find(({ at }) => at > STAGES[stage].at)?.at ?? 1;

type SessionState =
  | { kind: "loading"; file: string; stage: Stage }
  | { kind: "running"; file: string; label: string }
  | { kind: "failed"; file: string; error: unknown; retry: (() => void) | null }
  /** the app's process ended: on a device the launcher returns, and opening the app starts a new one */
  | { kind: "exited"; file: string; label: string; crashed: boolean; crashDialog: boolean; retry: (() => void) | null };

export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("msg" in error) return String(error.msg);
    if ("message" in error) return String(error.message);
  }
  return String(error);
}

export type Shell = ReturnType<typeof createShell>;
export function createShell(actions: { launch: (name: string, file?: File) => void; back: () => void }) {
  const root = document.querySelector<HTMLElement>("#root")!;
  const canvas = document.querySelector<HTMLCanvasElement>("#screen")!;
  const phone = document.querySelector<HTMLElement>("#phone")!;
  const stage = document.querySelector<HTMLElement>("#stage")!;
  const picker = document.querySelector<HTMLInputElement>("#apk-picker")!;
  const choose = document.querySelector<HTMLButtonElement>("#choose-file")!;
  const back = document.querySelector<HTMLButtonElement>("#btn-back")!;
  const home = document.querySelector<HTMLButtonElement>("#btn-home")!;
  const launcher = document.querySelector<HTMLElement>("#launcher")!;
  const samples = document.querySelector<HTMLDetailsElement>("#samples")!;
  const settings = document.querySelector<HTMLElement>("#screencfg")!;
  const notice = document.querySelector<HTMLElement>("#notice")!;
  const loader = document.querySelector<HTMLElement>("#local-loader")!;
  const sessionCard = document.querySelector<HTMLElement>("#session")!;
  const packageName = document.querySelector<HTMLElement>("#package-name")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  const hint = document.querySelector<HTMLElement>("#recovery-hint")!;
  const details = document.querySelector<HTMLDetailsElement>("#error-details")!;
  const errorMessage = document.querySelector<HTMLElement>("#error-message")!;
  const stageText = document.querySelector<HTMLElement>("#stage-text")!;
  const retry = document.querySelector<HTMLButtonElement>("#retry")!;
  const reload = document.querySelector<HTMLButtonElement>("#reload")!;
  const progress = document.querySelector<HTMLElement>("#progress")!, fill = progress.firstElementChild as HTMLElement;
  let session: SessionState | null = null;
  /** an app has run or can't be retried: another needs a fresh session */
  const started = () => session?.kind === "running" || session?.kind === "exited" || (session?.kind === "failed" && !session.retry);

  /** The bar shows the steps done, and eases on toward the next step's start over about three times the step's usual length: a
   *  compositor transition, which moves while the page's thread is busy. */
  function showStage(stage: Stage) {
    const { text, at, ms } = STAGES[stage];
    stageText.textContent = text;
    progress.setAttribute("aria-valuenow", String(Math.round(at * 100)));
    fill.style.transition = `transform ${ms * 3}ms ease-out`;
    fill.style.transform = `scaleX(${stageEnd(stage)})`;
  }

  function updateAvailability() {
    const busy = session?.kind === "loading", done = started(), blocked = busy || done;
    choose.disabled = picker.disabled = launcher.inert = blocked;
    settings.hidden = blocked;
    samples.hidden = done || !launcher.childElementCount;
    back.disabled = session?.kind !== "running";
    home.disabled = busy;
    loader.hidden = done;
  }

  const announce = (message: string) => { notice.textContent = message; notice.hidden = !message; };
  const reset = () => {
    const url = new URL(location.href);
    url.searchParams.delete("apk");
    location.replace(url.href);
  };
  home.addEventListener("click", reset);
  reload.addEventListener("click", reset);
  back.addEventListener("click", actions.back);
  choose.addEventListener("click", () => picker.click());
  retry.addEventListener("click", () => {
    if (session?.kind === "failed" || session?.kind === "exited") session.retry?.();
  });

  function openFiles(files: FileList) {
    if (session?.kind === "loading") return;
    if (started()) {
      announce("Return home to open another app in a fresh session.");
      return;
    }
    const file = files[0];
    if (!file) return;
    if (files.length !== 1) { announce("Choose one package at a time."); return; }
    if (!/\.(?:apk|xapk|apks)$/i.test(file.name)) { announce("Choose an APK, XAPK or APKS file."); return; }
    actions.launch(file.name, file);
  }
  picker.addEventListener("change", () => {
    if (picker.files) openFiles(picker.files);
    picker.value = "";
  });
  document.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    if (session?.kind !== "loading") document.body.classList.add("dragging");
  });
  document.addEventListener("dragleave", (event) => { if (!event.relatedTarget) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    document.body.classList.remove("dragging");
    openFiles(event.dataTransfer.files);
  });
  root.addEventListener("pointerdown", ({ target }) => {
    if (target instanceof Element && target.closest("button, summary") && !root.hasAttribute("data-pointer")) root.dataset.pointer = "";
  }, { passive: true });
  document.addEventListener("keydown", () => { if (root.hasAttribute("data-pointer")) delete root.dataset.pointer; });

  configureScreen();
  const resizeDisplay = fitDisplay(canvas, phone, stage);

  updateAvailability();
  return {
    canvas,
    kbd: document.querySelector<HTMLTextAreaElement>("#kbd")!,
    resizeDisplay,
    setState(next: SessionState) {
      const loading = session?.kind === "loading";
      session = next;
      if (next.kind === "loading") {
        showStage(next.stage);
        if (loading) return;
        announce("");
      }
      root.dataset.state = next.kind;
      updateAvailability();
      const ended = next.kind === "failed" || next.kind === "exited";
      sessionCard.hidden = !ended;
      if (next.kind === "running") {
        canvas.setAttribute("aria-label", `${next.label} — Android app screen`);
        resizeDisplay();
        window.scrollTo(0, 0);
      }
      if (!ended) return;
      const failed = next.kind === "failed";
      details.hidden = !failed;
      details.open = false;
      retry.hidden = !next.retry;
      retry.textContent = failed ? "Try again" : "Open again";
      [status.textContent, hint.textContent] = failed
        ? ["Couldn’t open this app", next.retry ? "Try again, or choose another package. Check that the file is complete." : "Reload to start a fresh session, then choose your package again."]
        : [next.crashDialog ? `${next.label} keeps stopping` : next.crashed ? "The app stopped" : "The app closed",
          next.retry ? "Its process ended. Open it again to start a new one." : "Its process ended. Reload to start a fresh session, then choose your package again."];
      packageName.textContent = failed ? next.file : next.label;
      if (failed) errorMessage.textContent = errorText(next.error);
    },
    addPackage(file: string) {
      const button = document.createElement("button");
      button.className = "appcard";
      const name = document.createElement("strong"), filename = document.createElement("small");
      name.textContent = file.replace(/\.(?:xapk|apks|apk)$/i, "").replace(/[-_]v?\d[\d.]*$/, "").replace(/[-_]+/g, " ");
      filename.textContent = file;
      button.append(name, filename);
      button.addEventListener("click", () => actions.launch(file));
      launcher.append(button);
      updateAvailability();
    },
  };
}

function configureScreen() {
  const form = document.querySelector<HTMLFormElement>("#screen-form")!;
  const width = document.querySelector<HTMLInputElement>("#cfg-w")!;
  const height = document.querySelector<HTMLInputElement>("#cfg-h")!;
  const density = document.querySelector<HTMLInputElement>("#cfg-dpi")!;
  const note = document.querySelector<HTMLElement>("#cfg-note")!;
  width.value = String(device.width);
  height.value = String(device.height);
  density.value = String(device.densityDpi);
  const selectedScreen = () => parseScreen(`${width.value}x${height.value}@${density.value}`);
  function describeScreen() {
    const screen = selectedScreen();
    note.textContent = screen
      ? `${Math.round(screen.width * 160 / screen.densityDpi)} × ${Math.round(screen.height * 160 / screen.densityDpi)} dp · ${screen.width} × ${screen.height} px`
      : "Enter positive whole numbers for each dimension.";
  }
  describeScreen();
  form.addEventListener("input", describeScreen);
  function applyScreen(screen: Screen | null) {
    storeScreen(screen);
    // A URL profile otherwise overrides the preference again after reloading.
    const url = new URL(location.href);
    url.searchParams.delete("screen");
    location.replace(url.href);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const screen = selectedScreen();
    if (screen) applyScreen(screen); else describeScreen();
  });
  document.querySelector<HTMLButtonElement>("#cfg-reset")!.addEventListener("click", () => applyScreen(null));
}

function fitDisplay(canvas: HTMLCanvasElement, phone: HTMLElement, stage: HTMLElement) {
  const nav = document.querySelector<HTMLElement>("#nav")!;
  function fit() {
    if (!stage.clientWidth || !stage.clientHeight) return;
    const style = getComputedStyle(phone);
    const chromeWidth = phone.offsetWidth - phone.clientWidth + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const chromeHeight = phone.offsetHeight - phone.clientHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + nav.offsetHeight;
    const scale = Math.min(Math.max(1, stage.clientWidth - chromeWidth) / device.width,
      Math.max(1, stage.clientHeight - chromeHeight) / device.height);
    canvas.style.width = `${device.width * scale}px`;
    canvas.style.height = `${device.height * scale}px`;
  }
  function resizeDisplay() {
    if (canvas.width !== device.width) canvas.width = device.width;
    if (canvas.height !== device.height) canvas.height = device.height;
    fit();
  }
  resizeDisplay();
  window.addEventListener("resize", fit);
  new ResizeObserver(fit).observe(stage);

  return resizeDisplay;
}
