// android.view.inputmethod.* — the editor/IME contract, plus the two editable-text pieces
// that hang off it (android.text.Editable$Factory, android.widget.AutoCompleteTextView).
//
// EditorInfo and ExtractedText are public-FIELD APIs, not getter APIs: an editor fills
// `inputType`/`imeOptions`/`initialSelStart` in place and the IME reads them back, so the
// `fields:` maps below are the whole point of these two specs.
//
// InputConnection is registered even though it is bodyless: Compose's RecordingInputConnection
// declares `implements InputConnection`, and an unregistered interface makes Runtime.link
// auto-stub it — which poisons every class that names it.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JEditable, JSpannable, csText } from "./text";
import { JView, invalidate } from "./view";
import { JMatrix } from "./graphics";
import { JTextView, JEditText, focusedEdit, focusEditText } from "./widget";
import { PARCELABLE } from "./os";


class JEditorInfo extends JObj {
  inputType = 0;
  imeOptions = 0;
  privateImeOptions: string | null = null;
  actionLabel: unknown = null;
  actionId = 0;
  initialSelStart = -1;
  initialSelEnd = -1;
  initialCapsMode = 0;
  hintText: unknown = null;
  label: unknown = null;
  packageName: string | null = null;
  fieldId = 0;
  fieldName: string | null = null;
  extras: unknown = null;
  hintLocales: unknown = null;
  contentMimeTypes: unknown = null;
  // setInitialSurroundingText payload: the text and where in the editor it starts.
  surrounding = "";
  surroundingStart = 0;
  stylus = 0;
  gestures: unknown = null;
  gesturePreviews: unknown = null;
}
rt.register({
  name: "android/view/inputmethod/EditorInfo", ctor: JEditorInfo,
  ifaces: ["android/text/InputType", "android/os/Parcelable"],
  statics: {
    IME_ACTION_UNSPECIFIED: 0, IME_ACTION_NONE: 1, IME_ACTION_GO: 2, IME_ACTION_SEARCH: 3,
    IME_ACTION_SEND: 4, IME_ACTION_NEXT: 5, IME_ACTION_DONE: 6, IME_ACTION_PREVIOUS: 7,
    IME_MASK_ACTION: 0x000000ff, IME_NULL: 0,
    IME_FLAG_NO_PERSONALIZED_LEARNING: 0x01000000, IME_FLAG_NO_FULLSCREEN: 0x02000000,
    IME_FLAG_NAVIGATE_PREVIOUS: 0x04000000, IME_FLAG_NAVIGATE_NEXT: 0x08000000,
    IME_FLAG_NO_EXTRACT_UI: 0x10000000, IME_FLAG_NO_ACCESSORY_ACTION: 0x20000000,
    IME_FLAG_NO_ENTER_ACTION: 0x40000000, IME_FLAG_FORCE_ASCII: -0x80000000,
  },
  fields: {
    inputType: "inputType", imeOptions: "imeOptions", privateImeOptions: "privateImeOptions",
    actionLabel: "actionLabel", actionId: "actionId", initialSelStart: "initialSelStart",
    initialSelEnd: "initialSelEnd", initialCapsMode: "initialCapsMode", hintText: "hintText",
    label: "label", packageName: "packageName", fieldId: "fieldId", fieldName: "fieldName",
    extras: "extras", hintLocales: "hintLocales", contentMimeTypes: "contentMimeTypes",
  },
  methods: {
    "<init>()V": function () {},
    // AOSP drops flags/action bits the target SDK cannot express. We report the newest
    // level, so nothing has to be dropped.
    "makeCompatible(I)V": () => {},
    "setInitialSurroundingText(Ljava/lang/CharSequence;)V": async function (this: JEditorInfo, cs: unknown) {
      this.surrounding = await csText(cs);
      this.surroundingStart = 0;
    },
    "setInitialSurroundingSubText(Ljava/lang/CharSequence;I)V": async function (this: JEditorInfo, cs: unknown, start: number) {
      this.surrounding = await csText(cs);
      this.surroundingStart = start;
    },
    "getInitialTextBeforeCursor(II)Ljava/lang/CharSequence;": function (this: JEditorInfo, n: number) {
      const c = this.initialSelStart - this.surroundingStart;
      return c < 0 ? null : this.surrounding.slice(Math.max(0, c - n), c);
    },
    "getInitialTextAfterCursor(II)Ljava/lang/CharSequence;": function (this: JEditorInfo, n: number) {
      const c = this.initialSelEnd - this.surroundingStart;
      return c < 0 ? null : this.surrounding.slice(c, c + n);
    },
    "getInitialSelectedText(I)Ljava/lang/CharSequence;": function (this: JEditorInfo) {
      const a = this.initialSelStart - this.surroundingStart, b = this.initialSelEnd - this.surroundingStart;
      return a < 0 || b < a ? null : this.surrounding.slice(a, b);
    },
    "setStylusHandwritingEnabled(Z)V": function (this: JEditorInfo, v: number) { this.stylus = v; },
    "isStylusHandwritingEnabled()Z": function (this: JEditorInfo) { return this.stylus; },
    "setSupportedHandwritingGestures(Ljava/util/List;)V": function (this: JEditorInfo, l: unknown) { this.gestures = l; },
    "getSupportedHandwritingGestures()Ljava/util/List;": function (this: JEditorInfo) { return this.gestures; },
    "setSupportedHandwritingGesturePreviews(Ljava/util/Set;)V": function (this: JEditorInfo, s: unknown) { this.gesturePreviews = s; },
    "getSupportedHandwritingGesturePreviews()Ljava/util/Set;": function (this: JEditorInfo) { return this.gesturePreviews; },
    ...PARCELABLE,
  },
});

class JExtractedText extends JObj {
  text: unknown = null;
  startOffset = 0;
  partialStartOffset = -1;
  partialEndOffset = -1;
  selectionStart = 0;
  selectionEnd = 0;
  flags = 0;
}
rt.register({
  name: "android/view/inputmethod/ExtractedText", ctor: JExtractedText, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_SINGLE_LINE: 1, FLAG_SELECTING: 2 },
  fields: {
    text: "text", startOffset: "startOffset", partialStartOffset: "partialStartOffset",
    partialEndOffset: "partialEndOffset", selectionStart: "selectionStart",
    selectionEnd: "selectionEnd", flags: "flags",
  },
  methods: { "<init>()V": function () {}, "describeContents()I": () => 0, "writeToParcel(Landroid/os/Parcel;I)V": () => {} },
});
class JExtractedTextRequest extends JObj { token = 0; flags = 0; hintMaxLines = 0; hintMaxChars = 0; }
rt.register({
  name: "android/view/inputmethod/ExtractedTextRequest", ctor: JExtractedTextRequest, ifaces: ["android/os/Parcelable"],
  fields: { token: "token", flags: "flags", hintMaxLines: "hintMaxLines", hintMaxChars: "hintMaxChars" },
  methods: { "<init>()V": function () {}, "describeContents()I": () => 0, "writeToParcel(Landroid/os/Parcel;I)V": () => {} },
});

// ── InputConnection: the interface itself, and the two AOSP implementations of it.
const IC_SIGS = [
  "beginBatchEdit()Z", "endBatchEdit()Z", "clearMetaKeyStates(I)Z", "closeConnection()V",
  "commitCompletion(Landroid/view/inputmethod/CompletionInfo;)Z",
  "commitContent(Landroid/view/inputmethod/InputContentInfo;ILandroid/os/Bundle;)Z",
  "commitCorrection(Landroid/view/inputmethod/CorrectionInfo;)Z",
  "commitText(Ljava/lang/CharSequence;I)Z",
  "commitText(Ljava/lang/CharSequence;ILandroid/view/inputmethod/TextAttribute;)Z",
  "deleteSurroundingText(II)Z", "deleteSurroundingTextInCodePoints(II)Z", "finishComposingText()Z",
  "getCursorCapsMode(I)I",
  "getExtractedText(Landroid/view/inputmethod/ExtractedTextRequest;I)Landroid/view/inputmethod/ExtractedText;",
  "getHandler()Landroid/os/Handler;", "getSelectedText(I)Ljava/lang/CharSequence;",
  "getTextAfterCursor(II)Ljava/lang/CharSequence;", "getTextBeforeCursor(II)Ljava/lang/CharSequence;",
  "getSurroundingText(III)Landroid/view/inputmethod/SurroundingText;",
  "performContextMenuAction(I)Z", "performEditorAction(I)Z",
  "performHandwritingGesture(Landroid/view/inputmethod/HandwritingGesture;Ljava/util/concurrent/Executor;Ljava/util/function/IntConsumer;)V",
  "previewHandwritingGesture(Landroid/view/inputmethod/PreviewableHandwritingGesture;Landroid/os/CancellationSignal;)Z",
  "performPrivateCommand(Ljava/lang/String;Landroid/os/Bundle;)Z", "performSpellCheck()Z",
  "reportFullscreenMode(Z)Z", "requestCursorUpdates(I)Z", "requestCursorUpdates(II)Z",
  "sendKeyEvent(Landroid/view/KeyEvent;)Z", "setComposingRegion(II)Z",
  "setComposingRegion(IILandroid/view/inputmethod/TextAttribute;)Z",
  "setComposingText(Ljava/lang/CharSequence;I)Z",
  "setComposingText(Ljava/lang/CharSequence;ILandroid/view/inputmethod/TextAttribute;)Z",
  "setSelection(II)Z", "setImeConsumesInput(Z)Z", "takeSnapshot()Landroid/view/inputmethod/TextSnapshot;",
];
const splitSig = (sig: string) => {
  const i = sig.indexOf("(");
  return { name: sig.slice(0, i), desc: sig.slice(i) };
};
rt.register({
  name: "android/view/inputmethod/InputConnection", ctor: class extends JObj {},
  statics: {
    GET_TEXT_WITH_STYLES: 1, GET_EXTRACTED_TEXT_MONITOR: 1,
    CURSOR_UPDATE_IMMEDIATE: 1, CURSOR_UPDATE_MONITOR: 2,
    CURSOR_UPDATE_FILTER_EDITOR_BOUNDS: 4, CURSOR_UPDATE_FILTER_CHARACTER_BOUNDS: 8,
    CURSOR_UPDATE_FILTER_INSERTION_MARKER: 16, CURSOR_UPDATE_FILTER_VISIBLE_LINE_BOUNDS: 32,
    INPUT_CONTENT_GRANT_READ_URI_PERMISSION: 1,
  },
});

// BaseInputConnection: a real edit surface over the target view's Editable. `fullEditor`
// false means "no editable of our own to show the IME" in AOSP too — it still accepts text
// and forwards key events, which is exactly the path Compose uses for backspace fallback.
class JBaseInputConnection extends JObj {
  view: JView | null = null;
  full = 0;
  own: JEditable | null = null;
  sel = 0; selEnd = 0;
  compStart = -1; compEnd = -1;
  batch = 0;

  editable(): JEditable {
    const v = this.view;
    if (this.full && v instanceof JTextView) return v.getEditable();
    return this.own ?? (this.own = new JEditable());
  }
  /** Write text back through the view so TextWatchers fire, exactly as a real editor does. */
  async setText(s: string) {
    const v = this.view;
    if (this.full && v instanceof JTextView) await vcall(v, "setText", "(Ljava/lang/CharSequence;)V", s);
    else this.editable().text = s;
    invalidate();
  }
  /** The range the next commit replaces: the composing region if one is active, else the selection. */
  target(): [number, number] {
    return this.compStart >= 0 ? [this.compStart, this.compEnd] : [Math.min(this.sel, this.selEnd), Math.max(this.sel, this.selEnd)];
  }
  clamp(len: number) {
    this.sel = Math.max(0, Math.min(len, this.sel));
    this.selEnd = Math.max(0, Math.min(len, this.selEnd));
  }
}
async function replaceAt(ic: JBaseInputConnection, a: number, b: number, ins: string, newCursor: number) {
  const t = ic.editable().text;
  a = Math.max(0, Math.min(t.length, a)); b = Math.max(a, Math.min(t.length, b));
  await ic.setText(t.slice(0, a) + ins + t.slice(b));
  // newCursorPosition > 0 counts from the END of the inserted text, <= 0 from its start.
  ic.sel = ic.selEnd = newCursor > 0 ? a + ins.length + (newCursor - 1) : a + newCursor;
  ic.clamp(ic.editable().text.length);
}
rt.register({
  name: "android/view/inputmethod/BaseInputConnection", ctor: JBaseInputConnection,
  ifaces: ["android/view/inputmethod/InputConnection"],
  methods: {
    "<init>(Landroid/view/View;Z)V": function (this: JBaseInputConnection, v: JView, full: number) {
      this.view = v; this.full = full;
      const len = v instanceof JTextView ? v.text.length : 0;
      this.sel = this.selEnd = len;
    },
    "getEditable()Landroid/text/Editable;": function (this: JBaseInputConnection) { return this.editable(); },
    "beginBatchEdit()Z": function (this: JBaseInputConnection) { this.batch++; return 1; },
    "endBatchEdit()Z": function (this: JBaseInputConnection) { this.batch = Math.max(0, this.batch - 1); return this.batch > 0 ? 1 : 0; },
    "getTextBeforeCursor(II)Ljava/lang/CharSequence;": function (this: JBaseInputConnection, n: number) {
      const a = Math.min(this.sel, this.selEnd);
      return this.editable().text.slice(Math.max(0, a - n), a);
    },
    "getTextAfterCursor(II)Ljava/lang/CharSequence;": function (this: JBaseInputConnection, n: number) {
      const b = Math.max(this.sel, this.selEnd);
      return this.editable().text.slice(b, b + n);
    },
    "getSelectedText(I)Ljava/lang/CharSequence;": function (this: JBaseInputConnection) {
      const [a, b] = [Math.min(this.sel, this.selEnd), Math.max(this.sel, this.selEnd)];
      return a === b ? null : this.editable().text.slice(a, b);
    },
    "getExtractedText(Landroid/view/inputmethod/ExtractedTextRequest;I)Landroid/view/inputmethod/ExtractedText;":
      function (this: JBaseInputConnection) {
        const e = new JExtractedText();
        e.text = this.editable().text;
        e.selectionStart = Math.min(this.sel, this.selEnd);
        e.selectionEnd = Math.max(this.sel, this.selEnd);
        return e;
      },
    "getCursorCapsMode(I)I": () => 0,
    "commitText(Ljava/lang/CharSequence;I)Z": async function (this: JBaseInputConnection, cs: unknown, pos: number) {
      const [a, b] = this.target();
      this.compStart = this.compEnd = -1;
      await replaceAt(this, a, b, await csText(cs), pos);
      return 1;
    },
    "setComposingText(Ljava/lang/CharSequence;I)Z": async function (this: JBaseInputConnection, cs: unknown, pos: number) {
      const [a, b] = this.target();
      const s = await csText(cs);
      await replaceAt(this, a, b, s, pos);
      this.compStart = a; this.compEnd = a + s.length;
      return 1;
    },
    "setComposingRegion(II)Z": function (this: JBaseInputConnection, a: number, b: number) {
      this.compStart = Math.min(a, b); this.compEnd = Math.max(a, b);
      return 1;
    },
    "finishComposingText()Z": function (this: JBaseInputConnection) { this.compStart = this.compEnd = -1; return 1; },
    "deleteSurroundingText(II)Z": async function (this: JBaseInputConnection, before: number, after: number) {
      const t = this.editable().text;
      const a = Math.max(0, Math.min(this.sel, this.selEnd) - before);
      const b = Math.min(t.length, Math.max(this.sel, this.selEnd) + after);
      const keepFrom = Math.min(this.sel, this.selEnd), keepTo = Math.max(this.sel, this.selEnd);
      await this.setText(t.slice(0, a) + t.slice(keepFrom, keepTo) + t.slice(b));
      this.sel = a; this.selEnd = a + (keepTo - keepFrom);
      this.compStart = this.compEnd = -1;
      return 1;
    },
    // Our text is a JS string (UTF-16); code points only differ across surrogate pairs,
    // which no editable path here produces, so the count maps straight through.
    "deleteSurroundingTextInCodePoints(II)Z": function (this: JBaseInputConnection, a: number, b: number) {
      return vcall(this, "deleteSurroundingText", "(II)Z", a, b);
    },
    "setSelection(II)Z": function (this: JBaseInputConnection, a: number, b: number) {
      this.sel = a; this.selEnd = b; this.clamp(this.editable().text.length);
      return 1;
    },
    "sendKeyEvent(Landroid/view/KeyEvent;)Z": async function (this: JBaseInputConnection, ev: unknown) {
      if (this.view) await vcall(this.view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", ev);
      return 1;
    },
    "performEditorAction(I)Z": () => 1,
    "performContextMenuAction(I)Z": () => 1,
    "performPrivateCommand(Ljava/lang/String;Landroid/os/Bundle;)Z": () => 1,
    "performSpellCheck()Z": () => 1,
    "clearMetaKeyStates(I)Z": () => 1,
    "commitCompletion(Landroid/view/inputmethod/CompletionInfo;)Z": () => 0,
    "commitCorrection(Landroid/view/inputmethod/CorrectionInfo;)Z": () => 0,
    "commitContent(Landroid/view/inputmethod/InputContentInfo;ILandroid/os/Bundle;)Z": () => 0,
    "reportFullscreenMode(Z)Z": () => 0,
    "requestCursorUpdates(I)Z": () => 0,
    "requestCursorUpdates(II)Z": () => 0,
    "setImeConsumesInput(Z)Z": () => 1,
    "getHandler()Landroid/os/Handler;": () => null,
    "getSurroundingText(III)Landroid/view/inputmethod/SurroundingText;": () => null,
    "takeSnapshot()Landroid/view/inputmethod/TextSnapshot;": () => null,
    "performHandwritingGesture(Landroid/view/inputmethod/HandwritingGesture;Ljava/util/concurrent/Executor;Ljava/util/function/IntConsumer;)V": () => {},
    "previewHandwritingGesture(Landroid/view/inputmethod/PreviewableHandwritingGesture;Landroid/os/CancellationSignal;)Z": () => 0,
    // TextAttribute only carries IME styling hints; the text edit is identical.
    "commitText(Ljava/lang/CharSequence;ILandroid/view/inputmethod/TextAttribute;)Z": function (this: JBaseInputConnection, cs: unknown, p: number) {
      return vcall(this, "commitText", "(Ljava/lang/CharSequence;I)Z", cs, p);
    },
    "setComposingText(Ljava/lang/CharSequence;ILandroid/view/inputmethod/TextAttribute;)Z": function (this: JBaseInputConnection, cs: unknown, p: number) {
      return vcall(this, "setComposingText", "(Ljava/lang/CharSequence;I)Z", cs, p);
    },
    "setComposingRegion(IILandroid/view/inputmethod/TextAttribute;)Z": function (this: JBaseInputConnection, a: number, b: number) {
      return vcall(this, "setComposingRegion", "(II)Z", a, b);
    },
    "closeConnection()V": function (this: JBaseInputConnection) { this.compStart = this.compEnd = -1; },
    "static removeComposingSpans(Landroid/text/Spannable;)V": () => {},
    "static getComposingSpanStart(Landroid/text/Spannable;)I": () => -1,
    "static getComposingSpanEnd(Landroid/text/Spannable;)I": () => -1,
  },
});

// InputConnectionWrapper: pure delegation, generated from the interface's own signature list.
class JICWrapper extends JObj { targetIc: unknown = null; mutable = 0; }
const wrapMethods: Record<string, unknown> = {
  "<init>(Landroid/view/inputmethod/InputConnection;Z)V": function (this: JICWrapper, t: unknown, mutable: number) {
    this.targetIc = t; this.mutable = mutable;
  },
  "setTarget(Landroid/view/inputmethod/InputConnection;)V": function (this: JICWrapper, t: unknown) { this.targetIc = t; },
  "getTarget()Landroid/view/inputmethod/InputConnection;": function (this: JICWrapper) { return this.targetIc; },
};
for (const sig of IC_SIGS) {
  const { name, desc } = splitSig(sig);
  const ret = desc.slice(desc.indexOf(")") + 1);
  const miss = ret === "V" ? undefined : ret === "Z" || ret === "I" ? 0 : null;
  wrapMethods[sig] = function (this: JICWrapper, ...a: unknown[]) {
    return this.targetIc === null ? miss : vcall(this.targetIc, name, desc, ...a);
  };
}
rt.register({
  name: "android/view/inputmethod/InputConnectionWrapper", ctor: JICWrapper,
  ifaces: ["android/view/inputmethod/InputConnection"],
  methods: wrapMethods as NativeSpec["methods"],
});

// Value types the connection surface passes around. They only ever arrive FROM an IME, and
// there is no IME here — but a class that names them must still link.
class JCompletionInfo extends JObj { id = 0n; position = 0; text: unknown = null; label: unknown = null; }
rt.register({
  name: "android/view/inputmethod/CompletionInfo", ctor: JCompletionInfo, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>(JILjava/lang/CharSequence;)V": function (this: JCompletionInfo, id: bigint, pos: number, t: unknown) {
      this.id = id; this.position = pos; this.text = t;
    },
    "<init>(JILjava/lang/CharSequence;Ljava/lang/CharSequence;)V": function (this: JCompletionInfo, id: bigint, pos: number, t: unknown, l: unknown) {
      this.id = id; this.position = pos; this.text = t; this.label = l;
    },
    "getId()J": function (this: JCompletionInfo) { return this.id; },
    "getPosition()I": function (this: JCompletionInfo) { return this.position; },
    "getText()Ljava/lang/CharSequence;": function (this: JCompletionInfo) { return this.text; },
    "getLabel()Ljava/lang/CharSequence;": function (this: JCompletionInfo) { return this.label; },
    "describeContents()I": () => 0,
  },
});
for (const n of ["android/view/inputmethod/CorrectionInfo", "android/view/inputmethod/InputContentInfo",
  "android/view/inputmethod/TextAttribute", "android/view/inputmethod/SurroundingText",
  "android/view/inputmethod/TextSnapshot", "android/view/inputmethod/HandwritingGesture",
  "android/view/inputmethod/PreviewableHandwritingGesture"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}

// ── android.text.Editable$Factory — TextView's hook for swapping in a different Editable
// implementation (androidx emoji2 subclasses it). AOSP hands back a SpannableStringBuilder.
class JEditableFactory extends JObj {}
let editableFactory: JEditableFactory | null = null;
rt.register({
  name: "android/text/Editable$Factory", ctor: JEditableFactory,
  methods: {
    "<init>()V": function () {},
    "static getInstance()Landroid/text/Editable$Factory;": () => editableFactory ?? (editableFactory = new JEditableFactory()),
    "newEditable(Ljava/lang/CharSequence;)Landroid/text/Editable;": async (cs: unknown) => {
      const o = new (rt.link("android/text/SpannableStringBuilder").ctor)() as JSpannable;
      o.text = await csText(cs);
      if (cs instanceof JSpannable) o.spans = cs.spans.slice();
      return o;
    },
  },
});

// ── CursorAnchorInfo: an editor's report of where its cursor and text sit, assembled through a
// Builder. No IME reads it here, but the editor drives collect/build/reset, and build() keeps
// AOSP's rule that positional data without a matrix is an IllegalArgumentException.
class JCursorAnchorInfo extends JObj {
  selStart = -1; selEnd = -1; compStart = -1; compText: unknown = null;
  marker: number[] | null = null; markerFlags = 0;
  bounds: number[] = []; matrix: JMatrix | null = null;
}
rt.register({
  name: "android/view/inputmethod/CursorAnchorInfo", ctor: JCursorAnchorInfo, ifaces: ["android/os/Parcelable"],
  methods: {
    "getSelectionStart()I": function (this: JCursorAnchorInfo) { return this.selStart; },
    "getSelectionEnd()I": function (this: JCursorAnchorInfo) { return this.selEnd; },
    "getComposingTextStart()I": function (this: JCursorAnchorInfo) { return this.compStart; },
    "getComposingText()Ljava/lang/CharSequence;": function (this: JCursorAnchorInfo) { return this.compText; },
    "getInsertionMarkerFlags()I": function (this: JCursorAnchorInfo) { return this.markerFlags; },
    "getInsertionMarkerHorizontal()F": function (this: JCursorAnchorInfo) { return this.marker ? this.marker[0] : NaN; },
    "getInsertionMarkerTop()F": function (this: JCursorAnchorInfo) { return this.marker ? this.marker[1] : NaN; },
    "getInsertionMarkerBaseline()F": function (this: JCursorAnchorInfo) { return this.marker ? this.marker[2] : NaN; },
    "getInsertionMarkerBottom()F": function (this: JCursorAnchorInfo) { return this.marker ? this.marker[3] : NaN; },
    "getMatrix()Landroid/graphics/Matrix;": function (this: JCursorAnchorInfo) {
      const m = new JMatrix();
      if (this.matrix) m.m = [...this.matrix.m];
      return m;
    },
    ...PARCELABLE,
  },
});
class JCursorAnchorInfoBuilder extends JObj { info = new JCursorAnchorInfo(); matrixSet = false; }
const CAB = "Landroid/view/inputmethod/CursorAnchorInfo$Builder;";
rt.register({
  name: "android/view/inputmethod/CursorAnchorInfo$Builder", ctor: JCursorAnchorInfoBuilder,
  methods: {
    "<init>()V": function () {},
    [`setSelectionRange(II)${CAB}`]: function (this: JCursorAnchorInfoBuilder, a: number, b: number) {
      this.info.selStart = a; this.info.selEnd = b;
      return this;
    },
    [`setComposingText(ILjava/lang/CharSequence;)${CAB}`]: function (this: JCursorAnchorInfoBuilder, i: number, t: unknown) {
      this.info.compStart = t === null ? -1 : i; this.info.compText = t === null ? null : csText(t);
      return this;
    },
    [`setInsertionMarkerLocation(FFFFI)${CAB}`]: function (this: JCursorAnchorInfoBuilder, x: number, t: number, bl: number, b: number, f: number) {
      this.info.marker = [x, t, bl, b]; this.info.markerFlags = f;
      return this;
    },
    [`addCharacterBounds(IFFFFI)${CAB}`]: function (this: JCursorAnchorInfoBuilder, i: number, l: number, t: number, r: number, b: number, f: number) {
      if (i < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "index must not be a negative integer.");
      this.info.bounds.push(i, l, t, r, b, f);
      return this;
    },
    [`setMatrix(Landroid/graphics/Matrix;)${CAB}`]: function (this: JCursorAnchorInfoBuilder, m: JMatrix | null) {
      const c = new JMatrix();
      if (m) c.m = [...m.m];
      this.info.matrix = c; this.matrixSet = true;
      return this;
    },
    [`addEditorBoundsInfo(Landroid/view/inputmethod/EditorBoundsInfo;)${CAB}`]: function (this: JCursorAnchorInfoBuilder) { return this; },
    [`addVisibleLineBounds(FFFF)${CAB}`]: function (this: JCursorAnchorInfoBuilder) { return this; },
    [`clearVisibleLineBounds()${CAB}`]: function (this: JCursorAnchorInfoBuilder) { return this; },
    "reset()V": function (this: JCursorAnchorInfoBuilder) { this.info = new JCursorAnchorInfo(); this.matrixSet = false; },
    "build()Landroid/view/inputmethod/CursorAnchorInfo;": function (this: JCursorAnchorInfoBuilder) {
      const i = this.info;
      if (!this.matrixSet && (i.marker || i.bounds.length)) {
        throw rt.mkThrowable("java/lang/IllegalArgumentException", "Coordinate transformation matrix is required when positional parameters are specified.");
      }
      const out = new JCursorAnchorInfo();
      Object.assign(out, i, { bounds: i.bounds.slice() });
      return out;
    },
  },
});

// ── InputMethodManager. With no IME attached the editor-side notifications are sinks, but they
// must exist — a TextView tells the manager about every selection change it makes.
rt.register({
  name: "android/view/inputmethod/InputMethodManager", ctor: class extends JObj {},
  methods: {
    "hideSoftInputFromWindow(Landroid/os/IBinder;I)Z": () => { focusEditText(null); return 1; },
    "showSoftInput(Landroid/view/View;I)Z": () => 1,
    "toggleSoftInput(II)V": () => {},
    "isActive()Z": () => 0,
    "isActive(Landroid/view/View;)Z": (v: unknown) => (v !== null && v === focusedEdit ? 1 : 0),
    "restartInput(Landroid/view/View;)V": () => {},
    "updateSelection(Landroid/view/View;IIII)V": () => {},
    "updateExtractedText(Landroid/view/View;ILandroid/view/inputmethod/ExtractedText;)V": () => {},
    "updateCursorAnchorInfo(Landroid/view/View;Landroid/view/inputmethod/CursorAnchorInfo;)V": () => {},
    "dispatchKeyEventFromInputMethod(Landroid/view/View;Landroid/view/KeyEvent;)V": () => {},
    "startStylusHandwriting(Landroid/view/View;)V": () => {},
  },
});

// ── AutoCompleteTextView: an EditText plus an adapter and a dropdown. The dropdown never
// opens here; what has to be right is the linkage, the threshold/filter contract, and the
// completion path, because that is what a subclass (and the filter) calls into.
class JAutoComplete extends JEditText {
  adapter: unknown = null;
  threshold = 2;
  itemClickL: unknown = null;
  itemSelectedL: unknown = null;
  popupShowing = 0;
}
rt.register({
  name: "android/widget/AutoCompleteTextView", ctor: JAutoComplete, sup: "android/widget/EditText",
  ifaces: ["android/widget/Filter$FilterListener"],
  methods: {
    // EditText owns the underline chrome and the min height; route the 3-arg form through
    // its 2-arg constructor rather than inheriting TextView's, which applies neither.
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": async function (this: JAutoComplete, c: unknown, set: unknown) {
      await vcall(this, "<init>", "(Landroid/content/Context;Landroid/util/AttributeSet;)V", c, set);
    },
    "setAdapter(Landroid/widget/ListAdapter;)V": function (this: JAutoComplete, a: unknown) { this.adapter = a; },
    "getAdapter()Landroid/widget/ListAdapter;": function (this: JAutoComplete) { return this.adapter; },
    "setThreshold(I)V": function (this: JAutoComplete, t: number) { this.threshold = t <= 0 ? 1 : t; },
    "getThreshold()I": function (this: JAutoComplete) { return this.threshold; },
    "enoughToFilter()Z": function (this: JAutoComplete) { return this.text.length >= this.threshold ? 1 : 0; },
    "setOnItemClickListener(Landroid/widget/AdapterView$OnItemClickListener;)V": function (this: JAutoComplete, l: unknown) { this.itemClickL = l; },
    "getOnItemClickListener()Landroid/widget/AdapterView$OnItemClickListener;": function (this: JAutoComplete) { return this.itemClickL; },
    "setOnItemSelectedListener(Landroid/widget/AdapterView$OnItemSelectedListener;)V": function (this: JAutoComplete, l: unknown) { this.itemSelectedL = l; },
    "getOnItemSelectedListener()Landroid/widget/AdapterView$OnItemSelectedListener;": function (this: JAutoComplete) { return this.itemSelectedL; },
    "showDropDown()V": function (this: JAutoComplete) { this.popupShowing = 1; },
    "dismissDropDown()V": function (this: JAutoComplete) { this.popupShowing = 0; },
    "isPopupShowing()Z": function (this: JAutoComplete) { return this.popupShowing; },
    "setDropDownBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": () => {},
    "setDropDownBackgroundResource(I)V": () => {},
    "setDropDownWidth(I)V": () => {}, "setDropDownHeight(I)V": () => {},
    "setDropDownVerticalOffset(I)V": () => {}, "setDropDownHorizontalOffset(I)V": () => {},
    "setDropDownAnchor(I)V": () => {},
    "setCompletionHint(Ljava/lang/CharSequence;)V": () => {},
    "clearListSelection()V": () => {},
    "getListSelection()I": () => -1,
    "setText(Ljava/lang/CharSequence;Z)V": async function (this: JAutoComplete, cs: unknown) {
      await vcall(this, "setText", "(Ljava/lang/CharSequence;)V", cs);
    },
    "convertSelectionToString(Ljava/lang/Object;)Ljava/lang/CharSequence;": async (o: unknown) =>
      (o === null ? "" : await vcall(o, "toString", "()Ljava/lang/String;")),
    "performFiltering(Ljava/lang/CharSequence;I)V": async function (this: JAutoComplete, cs: unknown) {
      if (this.adapter && rt.iof(this.adapter, "android/widget/Filterable")) {
        const f = await vcall(this.adapter, "getFilter", "()Landroid/widget/Filter;");
        if (f) await vcall(f, "filter", "(Ljava/lang/CharSequence;Landroid/widget/Filter$FilterListener;)V", cs, this);
      }
    },
    "onFilterComplete(I)V": function (this: JAutoComplete, count: number) { this.popupShowing = count > 0 ? 1 : 0; },
    "replaceText(Ljava/lang/CharSequence;)V": async function (this: JAutoComplete, cs: unknown) {
      await vcall(this, "setText", "(Ljava/lang/CharSequence;)V", cs);
    },
    "performCompletion()V": function () {},
  },
});
rt.register({ name: "android/widget/Filter$FilterListener", ctor: class extends JObj {} });
