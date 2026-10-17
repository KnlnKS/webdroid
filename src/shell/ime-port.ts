import type { ImeState } from "../android/ime.ts";
import { callProxy, serveCalls } from "./process-port.ts";

type ImeCalls = {
  input(generation: number, text: string, start: number, end: number, composing: boolean): Promise<void>;
  selection(generation: number, start: number, end: number): Promise<void>;
  finish(generation: number): Promise<void>;
  action(generation: number): Promise<boolean>;
};

/** Java callbacks remain in this Worker. Every edit checks its editor identity
 * again when its main-looper job runs, not merely when the message arrives. */
export async function serveIme(port: MessagePort): Promise<() => void> {
  const ime = await import("../android/ime.ts");
  const changed = (state: ImeState) => port.postMessage({ kind: "imeState", state });
  ime.imeTransport.changed = changed;
  const close = serveCalls<ImeCalls>(port, {
    input: (generation, text, start, end, composing) => ime.imeInput(text, start, end, composing, generation),
    selection: (generation, start, end) => ime.imeSelection(start, end, generation),
    finish: generation => ime.imeFinishComposition(generation),
    action: generation => ime.imeAction(generation),
  }, () => { if (ime.imeTransport.changed === changed) ime.imeTransport.changed = null; });
  changed(ime.imeState());
  return close;
}

type Edit = { generation: number; kind: "input"; text: string; start: number; end: number; composing: boolean }
  | { generation: number; kind: "selection"; start: number; end: number }
  | { generation: number; kind: "finish" | "action" };
/** A text control belongs to exactly one page-side process owner. */
export function receiveIme(port: MessagePort, canvas: HTMLCanvasElement, suppliedInput?: HTMLTextAreaElement) {
  const input = suppliedInput ?? document.createElement("textarea");
  input.className = "sr-only"; input.setAttribute("aria-label", "Android keyboard input");
  input.tabIndex = -1; input.autocomplete = "off"; input.disabled = true;
  if (!suppliedInput) (canvas.parentElement ?? document.body).append(input);
  const events = new AbortController();
  let closed = false, pending = false;
  let state: ImeState = { generation: 0, text: "", start: 0, end: 0, active: false, hasAction: false };
  const queue: Edit[] = [];
  const proxy = callProxy<ImeCalls>(port, ["input", "selection", "finish", "action"], [], undefined, () => close());
  function mirror() {
    if (closed) return;
    input.disabled = !state.active || canvas.hidden;
    if (!pending && !queue.length) {
      if (input.value !== state.text) input.value = state.text;
      if (input.selectionStart !== state.start || input.selectionEnd !== state.end) input.setSelectionRange(state.start, state.end);
    }
    if (input.disabled) input.blur();
  }
  function drain() {
    if (closed || pending) return;
    const edit = queue.shift();
    if (!edit) { mirror(); return; }
    if (edit.generation !== state.generation) { drain(); return; }
    pending = true;
    const calls = proxy.endpoint;
    const result = edit.kind === "input" ? calls.input(edit.generation, edit.text, edit.start, edit.end, edit.composing)
      : edit.kind === "selection" ? calls.selection(edit.generation, edit.start, edit.end)
      : edit.kind === "finish" ? calls.finish(edit.generation) : calls.action(edit.generation);
    void result.catch(error => { if (!closed) console.error("[IME]", error); }).finally(() => { pending = false; drain(); });
  }
  function enqueue(edit: Edit) {
    if (closed || !state.active || canvas.hidden) return;
    const last = queue.at(-1);
    if (last?.generation === edit.generation && last.kind === edit.kind &&
      (edit.kind === "selection" || edit.kind === "input" && last.kind === "input" && last.composing === edit.composing)) queue[queue.length - 1] = edit;
    else queue.push(edit);
    drain();
  }
  const visibility = new MutationObserver(() => { mirror(); if (state.active && !canvas.hidden) input.focus(); });
  visibility.observe(canvas, {attributes:true,attributeFilter:["hidden"]});
  const receive = ({ data }: MessageEvent<{kind: string; state: ImeState}>) => {
    if (closed || data.kind !== "imeState") return;
    const previous = state;
    state = data.state;
    if (state.generation !== previous.generation) {
      queue.length = 0; input.value = state.text; input.setSelectionRange(state.start, state.end);
    }
    mirror();
    if (state.active && !canvas.hidden && (!previous.active || previous.generation !== state.generation)) input.focus();
  };
  port.addEventListener("message", receive);
  input.addEventListener("input", event => enqueue({generation:state.generation,kind:"input",text:input.value,
    start:input.selectionStart,end:input.selectionEnd,composing:event instanceof InputEvent && event.isComposing}), {signal:events.signal});
  input.addEventListener("select", () => enqueue({generation:state.generation,kind:"selection",start:input.selectionStart,end:input.selectionEnd}), {signal:events.signal});
  input.addEventListener("compositionend", () => enqueue({generation:state.generation,kind:"finish"}), {signal:events.signal});
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing && state.hasAction) { event.preventDefault(); enqueue({generation:state.generation,kind:"action"}); }
  }, {signal:events.signal});
  function close() {
    if (closed) return;
    closed = true; queue.length = 0; visibility.disconnect(); events.abort(); port.removeEventListener("message", receive); proxy.close(); input.disabled = true; input.blur(); if (!suppliedInput) input.remove();
  }
  return { close, focus() { mirror(); if (!input.disabled) input.focus(); }, input };
}
