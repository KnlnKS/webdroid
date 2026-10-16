import { device, parseScreen, storeScreen, type Screen } from "./config.ts";

type SessionState =
  | { kind: "loading"; file: string; stage: string }
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
  const status = document.querySelector<HTMLElement>("#status")!;
  const retry = document.querySelector<HTMLButtonElement>("#retry")!;
  const reload = document.querySelector<HTMLButtonElement>("#reload")!;
  let session: SessionState | null = null;

  function updateAvailability() {
    const busy = session?.kind === "loading";
    const started = session?.kind === "running" || session?.kind === "exited" || (session?.kind === "failed" && !session.retry);
    choose.disabled = picker.disabled = busy || started;
    launcher.inert = busy || started;
    samples.hidden = started || !launcher.childElementCount;
    settings.hidden = busy || started;
    back.disabled = session?.kind !== "running";
    home.disabled = busy;
    const loader = document.querySelector<HTMLElement>("#local-loader")!;
    loader.hidden = started;
    loader.setAttribute("aria-busy", String(busy));
    document.querySelector<HTMLElement>(".privacy-note")!.hidden = started;
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
    if (session?.kind === "running" || session?.kind === "exited" || (session?.kind === "failed" && !session.retry)) {
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
    webLayer: document.querySelector<HTMLElement>("#weblayer")!,
    resizeDisplay,
    setState(next: SessionState) {
      if (session?.kind === "loading" && next.kind === "loading") {
        session = next;
        status.textContent = next.stage;
        return;
      }
      if (next.kind === "loading") announce("");
      session = next;
      root.dataset.state = next.kind;
      updateAvailability();
      document.querySelector<HTMLElement>("#session")!.hidden = next.kind === "running";
      document.querySelector<HTMLElement>("#package-name")!.textContent = next.kind === "running" || next.kind === "exited" ? next.label : next.file;
      const failed = next.kind === "failed", ended = failed || next.kind === "exited";
      document.querySelector<HTMLElement>("#recovery")!.hidden = !ended;
      const hint = document.querySelector<HTMLElement>("#recovery-hint")!;
      hint.hidden = !ended;
      const details = document.querySelector<HTMLDetailsElement>("#error-details")!;
      details.hidden = !failed;
      details.open = false;
      retry.hidden = !ended || !next.retry;
      retry.textContent = next.kind === "exited" ? "Open again" : "Try again";
      status.textContent = next.kind === "loading" ? next.stage : next.kind === "running" ? "Running"
        : next.kind === "exited" ? (next.crashDialog ? `${next.label} keeps stopping` : next.crashed ? "The app stopped" : "The app closed") : "Couldn’t open this app";
      if (next.kind === "exited") hint.textContent = next.retry ? "Its process ended. Open it again to start a new one." : "Its process ended. Reload to start a fresh session, then choose your package again.";
      if (failed) {
        hint.textContent = !next.retry ? "Reload to start a fresh session, then choose your package again." : "Try again, or choose another package. Check that the file is complete.";
        document.querySelector<HTMLElement>("#error-message")!.textContent = errorText(next.error);
      }
      if (next.kind === "running") {
        canvas.setAttribute("aria-label", `${next.label} — Android app screen`);
        resizeDisplay();
        window.scrollTo(0, 0);
      }
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
