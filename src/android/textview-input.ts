// The focused EditText and the page's text control that stands in for its keyboard: focus, the
// editor action, and the page's edits as replaces through the field's Editable. Selection lives
// in the text as android.text.Selection keeps it.
import { rt, driven, type Gen } from "../jvm/runtime";
import { vcall, newObj, scall } from "../jvm/natives/jlang";
import { guestNow } from "../guest-clock";
import { invalidate } from "./view";
import type { JTextView, JEditText } from "./textview";

const SELECTION = "android/text/Selection";
export const selectionStart = (text: unknown): number | Promise<number> =>
  text == null ? -1 : scall(SELECTION, "getSelectionStart", "(Ljava/lang/CharSequence;)I", text);
export const selectionEnd = (text: unknown): number | Promise<number> =>
  text == null ? -1 : scall(SELECTION, "getSelectionEnd", "(Ljava/lang/CharSequence;)I", text);
export const setSelection = (text: unknown, start: number, end: number): unknown =>
  scall(SELECTION, "setSelection", "(Landroid/text/Spannable;II)V", text, start, end);
export const selectAll = (text: unknown): unknown => scall(SELECTION, "selectAll", "(Landroid/text/Spannable;)V", text);

export let focusedEdit: JEditText | null = null;
/** The shell's hidden text control mirrors the focused EditText. */
export let inputEl: HTMLInputElement | HTMLTextAreaElement | null = null;
export function setInputElement(el: HTMLInputElement | HTMLTextAreaElement) { inputEl = el; }
/**
 * TextView.onEditorAction: the listener first; then AOSP's defaults — NEXT/PREVIOUS move focus
 * on and DONE closes the keyboard, both of which leave the field here, while any other action
 * (SEARCH, GO, SEND, or none) is delivered as an ENTER key press to the view, which is what a
 * field that listens with an OnKeyListener rather than an editor-action listener receives.
 */
export const editorAction = driven(function* editorAction(tv: JTextView, action: number): Gen<boolean> {
  if (tv.editorActionL && (yield vcall(tv.editorActionL, "onEditorAction",
    "(Landroid/widget/TextView;ILandroid/view/KeyEvent;)Z", tv, action, null))) return true;
  if (action === 5 || action === 6 || action === 7) { if (tv === focusedEdit) focusEditText(null); return false; }
  rt.link("android/view/KeyEvent");
  for (const act of [0, 1]) yield vcall(tv, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", yield newObj("android/view/KeyEvent", "(II)V", act, 66));
  return true;
});
/** the IME action key on the focused field */
export function fireEditorAction(): boolean | Promise<boolean> {
  const et = focusedEdit;
  return et ? editorAction(et, (et.imeOptions & 0xff) || 0) : Promise.resolve(false);
}
export function focusEditText(et: JEditText | null) {
  if (focusedEdit === et) return;
  if (focusedEdit) focusedEdit.focused = false;
  focusedEdit = et;
  if (et) { et.focused = true; et.blinkStart = guestNow(); }
  if (inputEl) {
    if (et) {
      inputEl.value = et.text;
      if (et.showSoftInputOnFocus) inputEl.focus(); else inputEl.blur();
    } else inputEl.blur();
  }
  invalidate();
}
/** the changed range between two texts: previous[a, b) became text[a, c) */
export function textDiff(previous: string, text: string): [number, number, number] {
  let a = 0, b = previous.length, c = text.length;
  while (a < b && a < c && previous[a] === text[a]) a++;
  while (b > a && c > a && previous[b - 1] === text[c - 1]) { b--; c--; }
  return [a, b, c];
}
/** the page's input changed the focused field: one replace through its Editable, whose filters
 *  may shorten or reject it, as an IME commit would be */
export const editInput = driven(function* editInput(text: string, start: number = text.length, end: number = start): Gen {
  const et = focusedEdit;
  if (!et) return;
  const previous = et.text, [a, b, c] = textDiff(previous, text), editable = yield et.getEditable();
  if (b > a || c > a) yield vcall(editable, "replace", "(IILjava/lang/CharSequence;II)Landroid/text/Editable;", a, b, text, a, c);
  if (et.text !== text) {
    start = end = Math.max(a, et.text.length - (previous.length - b));
    inputEl?.setSelectionRange(start, end);
  }
  yield setSelection(editable, start, end);
});
