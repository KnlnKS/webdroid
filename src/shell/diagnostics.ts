import { rt } from "../jvm/runtime.ts";
import { calledMissing } from "../native/host.ts";
import { errorText } from "./ui.ts";

export function nativeRequirements(): string[] {
  return [...rt.nativeRequired].map(([library, api]) => `${library} (${api})`)
    .concat([...calledMissing].map((symbol) => `ELF ${symbol}`));
}

/** Development panel; production relies on the console output of the same reports. */
export function mountDiagnostics(parent: HTMLElement): void {
  parent.insertAdjacentHTML("beforeend", `<details id="diagnostics" hidden><summary>Diagnostics<span id="diagnostic-count" class="summary-meta"></span></summary><div class="disclosure-content"><p id="runtime-error"></p><p id="native"></p><pre id="missing"></pre></div></details>`);
  const field = (id: string) => document.getElementById(id)!;
  const panel = field("diagnostics"), count = field("diagnostic-count"), error = field("runtime-error"), native = field("native"), missing = field("missing");
  const show = (target: HTMLElement, text: string) => { target.textContent = text; panel.hidden = false; };
  rt.onUncaught = (e) => show(error, errorText(e));
  rt.onNativeRequired = (lib, abi) => show(native, `Native code required: ${lib} (${abi})`);
  let queued = false;
  rt.onMissing = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      count.textContent = String(rt.missing.size);
      show(missing, `Missing APIs (${rt.missing.size}):\n${[...rt.missing].slice(-60).join("\n")}`);
    }, 800);
  };
}
