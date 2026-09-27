import { rt } from "../jvm/runtime";
import { calledMissing } from "../native/host";
import { errorText } from "./ui";

export function nativeRequirements(): string[] {
  return [...rt.nativeRequired].map(([library, api]) => `${library} (${api})`)
    .concat([...calledMissing].map((symbol) => `ELF ${symbol}`));
}

/** Development panel; production relies on the console output of the same reports. */
export function mountDiagnostics(parent: HTMLElement): void {
  parent.insertAdjacentHTML("beforeend", `<details id="diagnostics" hidden><summary>Diagnostics<span class="summary-meta"></span></summary><div class="disclosure-content"><p></p><p></p><pre></pre></div></details>`);
  const panel = parent.lastElementChild as HTMLDetailsElement;
  const [count, error, native, missing] = panel.querySelectorAll<HTMLElement>(".summary-meta, p, pre");
  const show = (field: HTMLElement, text: string) => { field.textContent = text; panel.hidden = false; };
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
