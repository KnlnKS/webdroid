// The browser keyboard: the page's text control in the role of the input method, serving the
// editor InputMethodManagerService (server/imm.ts) binds it to. The page's edits reach the editor
// as InputConnection calls; the editor's reports keep the control's text and selection current.
import { awaited, rt, type JObj, driven, declaredField, type Gen } from "../jvm/runtime";
import { onMain } from "./mainloop";
import { csText } from "../jvm/natives/jchars";

/** An editor the IME serves, as the IME last heard it: its text from `offset`, the selection in
 *  the editor's coordinates and the composing region in `text`'s. `call` is an
 *  IRemoteInputConnection method by name and argument descriptor. */
export interface ImeSession {
  text: string; offset: number; start: number; end: number; compStart: number; compEnd: number;
  imeOptions: number; actionId: number;
  call(name: string, args: string, ...values: unknown[]): unknown;
}
export type ImeState = { generation: number; text: string; start: number; end: number; active: boolean; hasAction: boolean };
let generation = 0;
let served: ImeSession | null = null;
// ExtractedText partial updates describe the last reported text. Local optimistic
// edits may already have advanced session.text before the editor reports its delta.
const reportedText = new WeakMap<ImeSession, {text:string;offset:number}>();
export const imeTransport: { changed: ((state: ImeState) => void) | null } = { changed: null };
export function imeState(): ImeState {
  return { generation, text: served?.text ?? "", start: served ? served.start - served.offset : 0,
    end: served ? served.end - served.offset : 0, active: imeActive(), hasAction: imeHasAction() };
}
let imeVisible = false;
let editing = false;
/** the page's text control takes the served editor's text and selection */
export function mirrorInput() {
  if (!editing) imeTransport.changed?.(imeState());
}
/** the IME serves `session`'s editor, or none */
export function serveInput(session: ImeSession | null) {
  if (served !== session) generation++;
  if (session && !reportedText.has(session)) reportedText.set(session,{text:session.text,offset:session.offset});
  served = session; mirrorInput();
}
/** the keyboard shows or hides */
export function showInput(visible: boolean) {
  imeVisible = visible;
  mirrorInput();
}
const ET = "android/view/inputmethod/ExtractedText";
/** an ExtractedText the editor reported: all of its text, or a changed part of it */
let reports = 0;
export const extractedInput = driven(function* extractedInput(session: ImeSession, extracted: JObj): Gen {
  reports++;
  const f = (name: string) => (extracted as unknown as Record<string, number>)[declaredField(ET, name)];
  const content = f("text"), partialStart = f("partialStartOffset"), partialEnd = f("partialEndOffset"),
    startOffset = f("startOffset"), selectionStart = f("selectionStart"), selectionEnd = f("selectionEnd");
  const text = yield* awaited(csText(content));
  const previous = reportedText.get(session) ?? {text:session.text,offset:session.offset};
  if (partialStart < 0) { session.text = text; session.offset = startOffset; }
  else session.text = previous.text.slice(0, partialStart - previous.offset) + text + previous.text.slice(partialEnd - previous.offset);
  reportedText.set(session,{text:session.text,offset:session.offset});
  session.start = selectionStart + startOffset; session.end = selectionEnd + startOffset;
  mirrorInput();
});
/** the changed range between two texts: previous[a, b) became text[a, c) */
function textDiff(previous: string, text: string): [number, number, number] {
  let a = 0, b = previous.length, c = text.length;
  while (a < b && a < c && previous[a] === text[a]) a++;
  while (b > a && c > a && previous[b - 1] === text[c - 1]) { b--; c--; }
  return [a, b, c];
}
const IME_FLAG_NO_ENTER_ACTION = 0x40000000, IME_ACTION_NONE = 1;
export const imeActive = () => !!served && imeVisible;
const imeHasAction = () => !!served && !(served.imeOptions & IME_FLAG_NO_ENTER_ACTION) && (served.imeOptions & 0xff) !== IME_ACTION_NONE;
export function imeInput(text: string, start = text.length, end = start, composing = false, expectedGeneration?: number) {
  return onMain(() => rt.drive(function* (): Gen<void> {
    const session = served;
    if (!session || expectedGeneration !== undefined && expectedGeneration !== generation) return;
    const previous = session.text, offset = session.offset;
    let [a, b, c] = textDiff(previous, text);
    if (session.compStart >= 0) {
      a = Math.min(a, session.compStart); b = Math.max(b, session.compEnd); c = text.length - (previous.length - b);
    }
    const heard = reports;
    yield session.call("beginBatchEdit", "");
    editing = true;
    try {
      yield session.call("finishComposingText", "");
      if (b > a && c === a) {
        yield session.call("setSelection", "II", b + offset, b + offset);
        yield session.call("deleteSurroundingText", "II", b - a, 0);
      } else if (b > a || c > a) {
        yield session.call("setSelection", "II", a + offset, b + offset);
        yield session.call(composing ? "setComposingText" : "commitText", "Ljava/lang/CharSequence;I", text.slice(a, c), 1);
      }
      yield session.call("setSelection", "II", start + offset, end + offset);
      session.compStart = composing ? a : -1; session.compEnd = composing ? c : -1;
    } finally { try { yield session.call("endBatchEdit", ""); } finally { editing = false; } }
    // an editor that reports its changes has done so against the text before the edit
    if (reports === heard) { session.text = text; session.start = start + offset; session.end = end + offset; }
    mirrorInput();
  }()));
}
export function imeSelection(start: number, end: number, expectedGeneration?: number) {
  return onMain(() => rt.drive(function* (): Gen<void> {
    const session = served;
    if (!session || expectedGeneration !== undefined && expectedGeneration !== generation || start + session.offset === session.start && end + session.offset === session.end) return;
    yield session.call("setSelection", "II", start + session.offset, end + session.offset);
    session.start = start + session.offset; session.end = end + session.offset;
    mirrorInput();
  }()));
}
export const imeFinishComposition = (expectedGeneration?: number) => onMain(() => rt.drive(function* (): Gen<void> {
  if (served && (expectedGeneration === undefined || expectedGeneration === generation)) { yield served.call("finishComposingText", ""); served.compStart = served.compEnd = -1; }
}()));
export const imeAction = (expectedGeneration?: number) => onMain(() => rt.drive(function* (): Gen<boolean> {
  return (expectedGeneration === undefined || expectedGeneration === generation) && !!served && !!(yield served.call("performEditorAction", "I", served.actionId || served.imeOptions & 0xff));
}()));
