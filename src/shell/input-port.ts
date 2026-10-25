// A process's input from the page: the pointer events and IME edits its realm serves on its input
// port, and the IME state it tells the page's text control on another.
import type { ImeState } from "../android/ime.ts";
import type { TouchPointer } from "./pointer-queue.ts";
import { callProxy, methodsOf, serveCalls } from "./rpc.ts";
import { attachPointerInput, type PointerDispatch, type PointerGeometry } from "./pointer-input.ts";

type ImeCalls = {
  input(generation: number, text: string, start: number, end: number, composing: boolean): Promise<void>;
  selection(generation: number, start: number, end: number): Promise<void>;
  finish(generation: number): Promise<void>;
  action(generation: number): Promise<boolean>;
};
export type InputCalls = ImeCalls & { pointer(action: number, pointers: TouchPointer[]): Promise<void> };
export const inputMethods = methodsOf<InputCalls>()(["pointer", "input", "selection", "finish", "action"]);
/** what the page's text control hears of the editor */
export type ImeView = { state(state: ImeState): void };

/** Java callbacks remain in this realm. Every edit checks its editor identity
 * again when its main-looper job runs, not merely when the message arrives. */
export async function serveInput(input: MessagePort, view: MessagePort): Promise<() => void> {
  const [ime, { dispatchTouches }] = await Promise.all([import("../android/ime.ts"), import("./device.ts")]);
  const page = callProxy<ImeView>(view, ["state"], { notifications: ["state"] });
  const changed = (state: ImeState) => page.endpoint.state(state);
  ime.imeTransport.changed = changed;
  const close = serveCalls<InputCalls>(input, {
    pointer: dispatchTouches,
    input: (generation, text, start, end, composing) => ime.imeInput(text, start, end, composing, generation),
    selection: (generation, start, end) => ime.imeSelection(start, end, generation),
    finish: generation => ime.imeFinishComposition(generation),
    action: generation => ime.imeAction(generation),
  }, () => { if (ime.imeTransport.changed === changed) ime.imeTransport.changed = null; });
  changed(ime.imeState());
  return () => { close(); page.close(); };
}

type Edit = { generation: number; kind: "input"; text: string; start: number; end: number; composing: boolean }
  | { generation: number; kind: "selection"; start: number; end: number }
  | { generation: number; kind: "finish" | "action" };
/** A text control belongs to exactly one page-side process owner: it sends `calls` its edits and
 *  hears the editor's state on `view`. */
export function receiveIme(view: MessagePort, canvas: HTMLCanvasElement, calls: ImeCalls, suppliedInput?: HTMLTextAreaElement) {
  const input = suppliedInput ?? document.createElement("textarea");
  input.className = "sr-only"; input.setAttribute("aria-label", "Android keyboard input");
  input.tabIndex = -1; input.autocomplete = "off"; input.disabled = true;
  if (!suppliedInput) (canvas.parentElement ?? document.body).append(input);
  const events = new AbortController();
  let closed = false, pending = false, shown = !canvas.hidden;
  let state: ImeState = { generation: 0, text: "", start: 0, end: 0, active: false, hasAction: false };
  const queue: Edit[] = [];
  function mirror() {
    if (closed) return;
    input.disabled = !state.active || !shown;
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
    const result = edit.kind === "input" ? calls.input(edit.generation, edit.text, edit.start, edit.end, edit.composing)
      : edit.kind === "selection" ? calls.selection(edit.generation, edit.start, edit.end)
      : edit.kind === "finish" ? calls.finish(edit.generation) : calls.action(edit.generation);
    void result.catch(error => { if (!closed) console.error("[IME]", error); }).finally(() => { pending = false; drain(); });
  }
  function enqueue(edit: Edit) {
    if (closed || !state.active || !shown) return;
    const last = queue.at(-1);
    if (last?.generation === edit.generation && last.kind === edit.kind &&
      (edit.kind === "selection" || edit.kind === "input" && last.kind === "input" && last.composing === edit.composing)) queue[queue.length - 1] = edit;
    else queue.push(edit);
    drain();
  }
  const stop = serveCalls<ImeView>(view, { state: next => {
    if (closed) return;
    const previous = state;
    state = next;
    if (state.generation !== previous.generation) {
      queue.length = 0; input.value = state.text; input.setSelectionRange(state.start, state.end);
    }
    mirror();
    if (state.active && shown && (!previous.active || previous.generation !== state.generation)) input.focus();
  } }, () => close());
  input.addEventListener("input", event => enqueue({generation:state.generation,kind:"input",text:input.value,
    start:input.selectionStart,end:input.selectionEnd,composing:event instanceof InputEvent && event.isComposing}), {signal:events.signal});
  // mirror's setSelectionRange fires `select` too: the editor's own selection, sent back late, would undo an edit made since
  input.addEventListener("select", () => {
    if (input.selectionStart === state.start && input.selectionEnd === state.end) return;
    enqueue({generation:state.generation,kind:"selection",start:input.selectionStart,end:input.selectionEnd});
  }, {signal:events.signal});
  input.addEventListener("compositionend", () => enqueue({generation:state.generation,kind:"finish"}), {signal:events.signal});
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing && state.hasAction) { event.preventDefault(); enqueue({generation:state.generation,kind:"action"}); }
  }, {signal:events.signal});
  function close() {
    if (closed) return;
    closed = true; queue.length = 0; events.abort(); stop(); input.disabled = true; input.blur(); if (!suppliedInput) input.remove();
  }
  return { close, focus() { mirror(); if (!input.disabled) input.focus(); }, input,
    /** whether its canvas shows */
    show(visible: boolean) { if (shown === visible) return; shown = visible; mirror(); if (state.active && shown) input.focus(); } };
}

/** `canvas`'s input to one realm, served on `input` and `view`: its pointers go to `dispatch`, the realm's
 *  by default, and a press focuses the text control once the press's own focus change is done */
export function attachRealmInput(canvas: HTMLCanvasElement, geometry: PointerGeometry, input: MessagePort, view: MessagePort,
  { dispatch, kbd, source }: { dispatch?: PointerDispatch; kbd?: HTMLTextAreaElement; source?: HTMLElement } = {}) {
  const calls = callProxy<InputCalls>(input, inputMethods), text = receiveIme(view, canvas, calls.endpoint, kbd);
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const pointers = attachPointerInput(canvas, geometry, dispatch ?? calls.endpoint.pointer, () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(text.focus, 0);
  }, source);
  return { ...text, close() { clearTimeout(focusTimer); pointers.close(); text.close(); calls.close(); } };
}
