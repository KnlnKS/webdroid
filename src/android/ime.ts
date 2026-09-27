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

import { rt, JObj, type NativeSpec, stubs, noops, fieldGetters, fieldSetters, driven, type Gen } from "../jvm/runtime";
import { vcall, newObj } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jutil";
import { jarray, splitSig, mangleMethod } from "../jvm/abi";
import { JEditable, JSpannable, JSpanned, csText, textSelection, setTextSelection } from "./text";
import { JView, invalidate, rootOf } from "./view";
import { JMatrix } from "./graphics";
import { AID, type JAttrSet, obtainStyled } from "./res";
import { loadDrawableRV } from "./drawable";
import { JTextView, JEditText, textViewCtors, focusedEdit, focusEditText, inputEl, editInput, fireEditorAction, editorAction } from "./textview";
import { inMainJob, onMain } from "./mainloop";
import { PARCELABLE } from "./os";
import { JService } from "./app";

rt.register({ name: "android/inputmethodservice/AbstractInputMethodService", ctor: class extends JService {}, sup: "android/app/Service", methods: {
  "<init>()V": function () {},
} });
rt.register({ name: "android/inputmethodservice/InputMethodService", ctor: class extends JService {}, sup: "android/inputmethodservice/AbstractInputMethodService", methods: {
  "<init>()V": function () {},
} });

rt.markers("android/view/textservice/SpellCheckerSession$SpellCheckerSessionListener");
rt.register({
  name: "android/view/textservice/TextServicesManager", ctor: class extends JObj {},
  methods: {
    "isSpellCheckerEnabled()Z": () => 0,
    "getEnabledSpellCheckerInfos()Ljava/util/List;": () => newArrayList(),
    "getEnabledSpellCheckers()[Landroid/view/textservice/SpellCheckerInfo;": () => jarray([], "Landroid/view/textservice/SpellCheckerInfo;"),
    "getCurrentSpellCheckerInfo()Landroid/view/textservice/SpellCheckerInfo;": () => null,
    "getCurrentSpellCheckerSubtype(Z)Landroid/view/textservice/SpellCheckerSubtype;": () => null,
    "newSpellCheckerSession(Landroid/os/Bundle;Ljava/util/Locale;Landroid/view/textservice/SpellCheckerSession$SpellCheckerSessionListener;Z)Landroid/view/textservice/SpellCheckerSession;":
      (_bundle: unknown, locale: unknown, listener: unknown, referToSettings: number) => {
        if (!listener) throw rt.mkThrowable("java/lang/NullPointerException", "listener");
        if (!referToSettings && !locale) throw rt.mkThrowable("java/lang/IllegalArgumentException", "locale");
        return null;
      },
  },
});

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
  fields: ["inputType", "imeOptions", "privateImeOptions", "actionLabel", "actionId", "initialSelStart",
    "initialSelEnd", "initialCapsMode", "hintText", "label", "packageName", "fieldId", "fieldName", "extras",
    "hintLocales", "contentMimeTypes"],
  methods: {
    "<init>()V": function () {},
    // AOSP drops flags/action bits the target SDK cannot express. We report the newest
    // level, so nothing has to be dropped.
    "makeCompatible(I)V": () => {},
    "setInitialSurroundingText(Ljava/lang/CharSequence;)V": driven(function* (this: JEditorInfo, cs: unknown): Gen {
      this.surrounding = yield csText(cs);
      this.surroundingStart = 0;
    }),
    "setInitialSurroundingSubText(Ljava/lang/CharSequence;I)V": driven(function* (this: JEditorInfo, cs: unknown, start: number): Gen {
      this.surrounding = yield csText(cs);
      this.surroundingStart = start;
    }),
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
  fields: ["text", "startOffset", "partialStartOffset", "partialEndOffset", "selectionStart", "selectionEnd", "flags"],
  methods: { "<init>()V": function () {}, "describeContents()I": () => 0, "writeToParcel(Landroid/os/Parcel;I)V": () => {} },
});
class JExtractedTextRequest extends JObj { token = 0; flags = 0; hintMaxLines = 0; hintMaxChars = 0; }
rt.register({
  name: "android/view/inputmethod/ExtractedTextRequest", ctor: JExtractedTextRequest, ifaces: ["android/os/Parcelable"],
  fields: ["token", "flags", "hintMaxLines", "hintMaxChars"],
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

const composing = new JObj();
class JBaseInputConnection extends JObj {
  view: JView | null = null; full = 0; own: JEditable | null = null; batch = 0;
  editable(): JEditable {
    if (this.full && this.view instanceof JTextView) return this.view.getEditable();
    return this.own ??= rt.make("webdroid/Editable") as JEditable;
  }
  async content() {
    const editable = await vcall(this, "getEditable", "()Landroid/text/Editable;");
    const text = await csText(editable), [start, end] = await textSelection(editable);
    return { editable, text, start: Math.max(0, start), end: Math.max(0, end) };
  }
}
const replaceAt = driven(function* replaceAt(ic: JBaseInputConnection, ins: string, newCursor: number, compose: boolean): Gen {
  const { editable, text, start, end } = yield ic.content();
  if (!editable) return 0;
  let a = yield vcall(editable, "getSpanStart", "(Ljava/lang/Object;)I", composing);
  let b = yield vcall(editable, "getSpanEnd", "(Ljava/lang/Object;)I", composing);
  if (a < 0 || b < 0) { a = Math.min(start, end); b = Math.max(start, end); }
  yield vcall(ic, "beginBatchEdit", "()Z");
  try {
    yield vcall(editable, "removeSpan", "(Ljava/lang/Object;)V", composing);
    yield vcall(editable, "replace", "(IILjava/lang/CharSequence;II)Landroid/text/Editable;", a, b, ins, 0, ins.length);
    const cursor = Math.max(0, Math.min(text.length - (b - a) + ins.length, newCursor > 0 ? a + ins.length + newCursor - 1 : a + newCursor));
    yield setTextSelection(editable, cursor, cursor);
    if (compose) yield vcall(editable, "setSpan", "(Ljava/lang/Object;III)V", composing, a, a + ins.length, 0x121);
    if (ic.full && ic.view instanceof JTextView) yield vcall(ic.view, "setText", "(Ljava/lang/CharSequence;)V", yield csText(editable));
    invalidate();
  } finally { yield vcall(ic, "endBatchEdit", "()Z"); }
  return 1;
});
rt.register({
  name: "android/view/inputmethod/BaseInputConnection", ctor: JBaseInputConnection,
  ifaces: ["android/view/inputmethod/InputConnection"],
  methods: {
    "<init>(Landroid/view/View;Z)V": function (this: JBaseInputConnection, v: JView, full: number) {
      this.view = v; this.full = full;
    },
    "getEditable()Landroid/text/Editable;": function (this: JBaseInputConnection) { return this.editable(); },
    "beginBatchEdit()Z": function (this: JBaseInputConnection) { this.batch++; return 1; },
    "endBatchEdit()Z": function (this: JBaseInputConnection) { this.batch = Math.max(0, this.batch - 1); return this.batch > 0 ? 1 : 0; },
    "getTextBeforeCursor(II)Ljava/lang/CharSequence;": driven(function* (this: JBaseInputConnection, n: number): Gen {
      const { text, start, end } = yield this.content(), a = Math.min(start, end);
      return text.slice(Math.max(0, a - n), a);
    }),
    "getTextAfterCursor(II)Ljava/lang/CharSequence;": driven(function* (this: JBaseInputConnection, n: number): Gen {
      const { text, start, end } = yield this.content(), b = Math.max(start, end);
      return text.slice(b, b + n);
    }),
    "getSelectedText(I)Ljava/lang/CharSequence;": driven(function* (this: JBaseInputConnection): Gen {
      const { text, start, end } = yield this.content();
      return start === end ? null : text.slice(Math.min(start, end), Math.max(start, end));
    }),
    "getExtractedText(Landroid/view/inputmethod/ExtractedTextRequest;I)Landroid/view/inputmethod/ExtractedText;": driven(function* (this: JBaseInputConnection): Gen {
      const { text, start, end } = yield this.content(), extracted = rt.make("android/view/inputmethod/ExtractedText") as JExtractedText;
      extracted.text = text; extracted.selectionStart = start; extracted.selectionEnd = end; return extracted;
    }),
    "commitText(Ljava/lang/CharSequence;I)Z": driven(function* (this: JBaseInputConnection, cs: unknown, pos: number): Gen {
      return replaceAt(this, yield csText(cs), pos, false);
    }),
    "setComposingText(Ljava/lang/CharSequence;I)Z": driven(function* (this: JBaseInputConnection, cs: unknown, pos: number): Gen {
      return replaceAt(this, yield csText(cs), pos, true);
    }),
    "setComposingRegion(II)Z": driven(function* (this: JBaseInputConnection, a: number, b: number): Gen {
      const { editable, text } = yield this.content();
      yield vcall(editable, "setSpan", "(Ljava/lang/Object;III)V", composing, Math.max(0, Math.min(text.length, a, b)), Math.max(0, Math.min(text.length, Math.max(a, b))), 0x121);
      return 1;
    }),
    "finishComposingText()Z": driven(function* (this: JBaseInputConnection): Gen {
      yield vcall(yield vcall(this, "getEditable", "()Landroid/text/Editable;"), "removeSpan", "(Ljava/lang/Object;)V", composing); return 1;
    }),
    "deleteSurroundingText(II)Z": driven(function* (this: JBaseInputConnection, before: number, after: number): Gen {
      const { editable, text, start, end } = yield this.content(), a = Math.min(start, end), b = Math.max(start, end);
      const left = Math.max(0, a - Math.max(0, before)), right = Math.min(text.length, b + Math.max(0, after));
      yield vcall(this, "beginBatchEdit", "()Z");
      try {
        if (right > b) yield vcall(editable, "replace", "(IILjava/lang/CharSequence;II)Landroid/text/Editable;", b, right, "", 0, 0);
        if (a > left) yield vcall(editable, "replace", "(IILjava/lang/CharSequence;II)Landroid/text/Editable;", left, a, "", 0, 0);
        yield setTextSelection(editable, start - (a - left), end - (a - left));
        if (this.full && this.view instanceof JTextView) yield vcall(this.view, "setText", "(Ljava/lang/CharSequence;)V", yield csText(editable));
        invalidate();
      } finally { yield vcall(this, "endBatchEdit", "()Z"); }
      return 1;
    }),
    "deleteSurroundingTextInCodePoints(II)Z": driven(function* (this: JBaseInputConnection, before: number, after: number): Gen {
      const { text, start, end } = yield this.content(), a = Math.min(start, end), b = Math.max(start, end);
      const left = Array.from(text.slice(0, a)).slice(-Math.max(0, before)).join("").length;
      const right = Array.from(text.slice(b)).slice(0, Math.max(0, after)).join("").length;
      return vcall(this, "deleteSurroundingText", "(II)Z", before > 0 ? left : 0, right);
    }),
    "setSelection(II)Z": driven(function* (this: JBaseInputConnection, a: number, b: number): Gen {
      const { editable, text } = yield this.content();
      if (a < 0 || b < 0 || a > text.length || b > text.length) return 0;
      yield setTextSelection(editable, a, b); return 1;
    }),
    "sendKeyEvent(Landroid/view/KeyEvent;)Z": driven(function* (this: JBaseInputConnection, ev: unknown): Gen {
      if (this.view) yield vcall(this.view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", ev);
      return 1;
    }),
    ...stubs(0, "getCursorCapsMode(I)I", "commitCompletion(Landroid/view/inputmethod/CompletionInfo;)Z",
      "commitCorrection(Landroid/view/inputmethod/CorrectionInfo;)Z",
      "commitContent(Landroid/view/inputmethod/InputContentInfo;ILandroid/os/Bundle;)Z", "reportFullscreenMode(Z)Z",
      "requestCursorUpdates(I)Z", "requestCursorUpdates(II)Z",
      "previewHandwritingGesture(Landroid/view/inputmethod/PreviewableHandwritingGesture;Landroid/os/CancellationSignal;)Z"),
    // EditableInputConnection: the editor action reaches the TextView it serves
    "performEditorAction(I)Z": driven(function* (this: JBaseInputConnection, code: number): Gen {
      if (!(this.view instanceof JTextView)) return 0;
      yield editorAction(this.view, code);
      return 1;
    }),
    ...stubs(1, "performContextMenuAction(I)Z",
      "performPrivateCommand(Ljava/lang/String;Landroid/os/Bundle;)Z", "performSpellCheck()Z",
      "clearMetaKeyStates(I)Z", "setImeConsumesInput(Z)Z"),
    ...stubs(null, "getHandler()Landroid/os/Handler;",
      "getSurroundingText(III)Landroid/view/inputmethod/SurroundingText;",
      "takeSnapshot()Landroid/view/inputmethod/TextSnapshot;"),
    ...noops("performHandwritingGesture(Landroid/view/inputmethod/HandwritingGesture;Ljava/util/concurrent/Executor;Ljava/util/function/IntConsumer;)V"),
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
    "closeConnection()V": driven(function* (this: JBaseInputConnection): Gen { yield vcall(this, "finishComposingText", "()Z"); }),
    "static removeComposingSpans(Landroid/text/Spannable;)V": driven(function* (text: unknown): Gen { yield vcall(text, "removeSpan", "(Ljava/lang/Object;)V", composing); }),
    "static getComposingSpanStart(Landroid/text/Spannable;)I": function (text: unknown) { return vcall(text, "getSpanStart", "(Ljava/lang/Object;)I", composing); },
    "static getComposingSpanEnd(Landroid/text/Spannable;)I": function (text: unknown) { return vcall(text, "getSpanEnd", "(Ljava/lang/Object;)I", composing); },
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
  const [name, desc] = splitSig(sig);
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
    ...fieldGetters({ "getId()J": "id", "getPosition()I": "position", "getText()Ljava/lang/CharSequence;": "text",
      "getLabel()Ljava/lang/CharSequence;": "label" }),
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
    "newEditable(Ljava/lang/CharSequence;)Landroid/text/Editable;": driven(function* (cs: unknown): Gen {
      const o = rt.make("android/text/SpannableStringBuilder") as JSpannable;
      o.text = yield csText(cs);
      if (cs instanceof JSpanned) o.spans = cs.spans.slice();
      return o;
    }),
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
    ...fieldGetters({ "getSelectionStart()I": "selStart", "getSelectionEnd()I": "selEnd",
      "getComposingTextStart()I": "compStart", "getComposingText()Ljava/lang/CharSequence;": "compText",
      "getInsertionMarkerFlags()I": "markerFlags" }),
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
    [`setComposingText(ILjava/lang/CharSequence;)${CAB}`]: driven(function* (this: JCursorAnchorInfoBuilder, i: number, t: unknown): Gen {
      this.info.compStart = t === null ? -1 : i; this.info.compText = t === null ? null : yield csText(t);
      return this;
    }),
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

type InputSession = { view: JView; connection: unknown; info: JEditorInfo; text: string; offset: number; start: number; end: number; compStart: number; compEnd: number };
let served: InputSession | null = null;
let imeVisible = false;
let editing = false;
const imeMain = <T>(fn: () => T | Promise<T>) => inMainJob() ? Promise.resolve(fn()) : onMain(fn);
function mirrorInput() {
  if (!inputEl || !served || focusedEdit || editing) return;
  inputEl.value = served.text;
  inputEl.setSelectionRange(served.start - served.offset, served.end - served.offset);
}
const extractedInput = driven(function* extractedInput(session: InputSession, extracted: JExtractedText): Gen {
  const text = yield csText(extracted.text);
  if (extracted.partialStartOffset < 0) { session.text = text; session.offset = extracted.startOffset; }
  else session.text = session.text.slice(0, extracted.partialStartOffset - session.offset) + text + session.text.slice(extracted.partialEndOffset - session.offset);
  session.start = extracted.selectionStart + extracted.startOffset; session.end = extracted.selectionEnd + extracted.startOffset;
  mirrorInput();
});
const connectInput = driven(function* connectInput(view: JView): Gen {
  if (served) {
    const previous = served; served = null;
    yield vcall(previous.connection, "closeConnection", "()V");
  }
  if (view instanceof JEditText) { focusEditText(view); return true; }
  focusEditText(null);
  const info = rt.make("android/view/inputmethod/EditorInfo") as JEditorInfo;
  const connection = yield vcall(view, "onCreateInputConnection", "(Landroid/view/inputmethod/EditorInfo;)Landroid/view/inputmethod/InputConnection;", info);
  if (!connection) return false;
  const session = { view, connection, info, text: info.surrounding, offset: info.surroundingStart, start: Math.max(0, info.initialSelStart), end: Math.max(0, info.initialSelEnd), compStart: -1, compEnd: -1 };
  served = session;
  const request = rt.make("android/view/inputmethod/ExtractedTextRequest");
  const extracted = yield vcall(connection, "getExtractedText", "(Landroid/view/inputmethod/ExtractedTextRequest;I)Landroid/view/inputmethod/ExtractedText;", request, 1);
  if (extracted) yield extractedInput(session, extracted);
  mirrorInput(); return true;
});
export const imeActive = () => !!focusedEdit || !!served && imeVisible;
export const imeHasAction = () => !!focusedEdit || !!served && !(served.info.imeOptions & 0x40000000) && (served.info.imeOptions & 0xff) !== 1;
export function imeInput(text: string, start = text.length, end = start, composing = false) {
  return onMain(async () => {
    if (focusedEdit) { await editInput(text); return; }
    const session = served;
    if (!session) return;
    const ic = session.connection, previous = session.text;
    let a = 0, b = previous.length, c = text.length;
    while (a < b && a < c && previous[a] === text[a]) a++;
    while (b > a && c > a && previous[b - 1] === text[c - 1]) { b--; c--; }
    if (session.compStart >= 0) {
      a = Math.min(a, session.compStart); b = Math.max(b, session.compEnd); c = text.length - (previous.length - b);
    }
    await vcall(ic, "beginBatchEdit", "()Z");
    editing = true;
    try {
      await vcall(ic, "finishComposingText", "()Z");
      if (b > a && c === a) {
        await vcall(ic, "setSelection", "(II)Z", b + session.offset, b + session.offset);
        await vcall(ic, "deleteSurroundingText", "(II)Z", b - a, 0);
      } else if (b > a || c > a) {
        await vcall(ic, "setSelection", "(II)Z", a + session.offset, b + session.offset);
        await vcall(ic, composing ? "setComposingText" : "commitText", "(Ljava/lang/CharSequence;I)Z", text.slice(a, c), 1);
      }
      await vcall(ic, "setSelection", "(II)Z", start + session.offset, end + session.offset);
      session.text = text; session.start = start + session.offset; session.end = end + session.offset;
      session.compStart = composing ? a : -1; session.compEnd = composing ? c : -1;
    } finally { try { await vcall(ic, "endBatchEdit", "()Z"); } finally { editing = false; } }
    mirrorInput(); invalidate();
  });
}
export function imeSelection(start: number, end: number) {
  return onMain(async () => {
    const session = served;
    if (!session || focusedEdit || start + session.offset === session.start && end + session.offset === session.end) return;
    await vcall(session.connection, "setSelection", "(II)Z", start + session.offset, end + session.offset);
    session.start = start + session.offset; session.end = end + session.offset;
  });
}
export const imeFinishComposition = () => onMain(async () => {
  if (served && !focusedEdit) { await vcall(served.connection, "finishComposingText", "()Z"); served.compStart = served.compEnd = -1; }
});
export const imeAction = () => onMain(async () => {
  if (focusedEdit) return fireEditorAction();
  if (!served) return false;
  return !!(await vcall(served.connection, "performEditorAction", "(I)Z", served.info.actionId || served.info.imeOptions & 0xff));
});
rt.register({
  name: "android/view/inputmethod/InputMethodManager", ctor: class extends JObj {},
  methods: {
    "hideSoftInputFromWindow(Landroid/os/IBinder;I)Z": function () { return imeMain(async () => {
      if (served) await vcall(served.connection, "finishComposingText", "()Z");
      imeVisible = false; focusEditText(null); inputEl?.blur(); return 1;
    }); },
    "showSoftInput(Landroid/view/View;I)Z": function (view: JView) { return imeMain(async () => {
      if (!view || served?.view !== view && !await connectInput(view)) return 0;
      imeVisible = true; mirrorInput(); inputEl?.focus(); return 1;
    }); },
    "toggleSoftInput(II)V": () => { imeVisible = !imeVisible; if (imeVisible) inputEl?.focus(); else inputEl?.blur(); },
    "isActive()Z": () => served || focusedEdit ? 1 : 0,
    "isActive(Landroid/view/View;)Z": (view: unknown) => view != null && (view === served?.view || view === focusedEdit) ? 1 : 0,
    "getEnabledInputMethodList()Ljava/util/List;": () => newArrayList(),
    "getInputMethodList()Ljava/util/List;": () => newArrayList(),
    "getCurrentInputMethodSubtype()Landroid/view/inputmethod/InputMethodSubtype;": () => null,
    "restartInput(Landroid/view/View;)V": function (view: JView) { return imeMain(async () => { if (view) await connectInput(view); }); },
    "updateSelection(Landroid/view/View;IIII)V": (view: JView, start: number, end: number) => {
      if (served?.view === view) { served.start = start; served.end = end; mirrorInput(); }
    },
    "updateExtractedText(Landroid/view/View;ILandroid/view/inputmethod/ExtractedText;)V": driven(function* (view: JView, _token: number, extracted: JExtractedText): Gen {
      if (served?.view === view) yield extractedInput(served, extracted);
    }),
    "updateCursorAnchorInfo(Landroid/view/View;Landroid/view/inputmethod/CursorAnchorInfo;)V": () => {},
    "dispatchKeyEventFromInputMethod(Landroid/view/View;Landroid/view/KeyEvent;)V": function (view: JView, event: unknown) { return imeMain(async () => { await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", event); }); },
    "startStylusHandwriting(Landroid/view/View;)V": () => {},
  },
});

// ── AutoCompleteTextView: an EditText plus an adapter and a ListPopupWindow dropdown.
class JAutoComplete extends JEditText {
  adapter: unknown = null;
  threshold = 2;
  dropDownAnchor = -1;
  dropDownBackground: unknown = null;
  itemClickL: unknown = null;
  itemSelectedL: unknown = null;
  dismissL: unknown = null;
  popup: JObj | null = null;
  dropDown = { w: -2, h: -2, x: 0, y: 0 };
  /** AOSP's mPopup, made on first use: the list shows the adapter and a pick completes the text */
  listPopup(): unknown { return rt.drive(this.listPopup$()); }
  *listPopup$(): Gen<JObj> {
    if (this.popup) return this.popup;
    const p: JObj = yield newObj("android/widget/ListPopupWindow", "(Landroid/content/Context;)V", this.ctx);
    this.popup = p;
    const self = this;
    yield vcall(p, "setAdapter", "(Landroid/widget/ListAdapter;)V", this.adapter);
    yield vcall(p, "setOnItemClickListener", "(Landroid/widget/AdapterView$OnItemClickListener;)V", Object.assign(new JObj(), {
      [mangleMethod("onItemClick", "(Landroid/widget/AdapterView;Landroid/view/View;IJ)V")]: (_l: unknown, v: unknown, pos: number, id: bigint) => performCompletion(self, v, pos, id),
    }));
    if (this.dismissL) yield vcall(p, "setOnDismissListener", "(Landroid/widget/PopupWindow$OnDismissListener;)V", this.dismissL);
    if (this.dropDownBackground) yield vcall(p, "setBackgroundDrawable", "(Landroid/graphics/drawable/Drawable;)V", this.dropDownBackground);
    return p;
  }
}
const popupShowing = (v: JAutoComplete) => v.popup ? vcall(v.popup, "isShowing", "()Z") : 0;
/** AutoCompleteTextView.performCompletion: the picked item's text replaces the field's */
const performCompletion = driven(function* performCompletion(v: JAutoComplete, row: unknown, pos: number, id: bigint): Gen {
  if (yield popupShowing(v)) {
    const item = pos >= 0 && v.adapter ? yield vcall(v.adapter, "getItem", "(I)Ljava/lang/Object;", pos) : null;
    if (item == null) return;
    yield vcall(v, "replaceText", "(Ljava/lang/CharSequence;)V", yield vcall(v, "convertSelectionToString", "(Ljava/lang/Object;)Ljava/lang/CharSequence;", item));
    if (v.itemClickL) yield vcall(v.itemClickL, "onItemClick", "(Landroid/widget/AdapterView;Landroid/view/View;IJ)V",
      yield vcall(v.popup, "getListView", "()Landroid/widget/ListView;"), row, pos, id);
  }
  yield vcall(v, "dismissDropDown", "()V");
});
rt.register({
  name: "android/widget/AutoCompleteTextView", ctor: JAutoComplete, sup: "android/widget/EditText",
  ifaces: ["android/widget/Filter$FilterListener"],
  methods: {
    // AOSP builds the dropdown's ListPopupWindow under the widget's own style: its popupBackground
    ...textViewCtors<JAutoComplete>("autoCompleteTextViewStyle", driven(function* (v: JAutoComplete, set: JAttrSet | null, dsa: number, dsr: number): Gen {
      const bg = v.jres && obtainStyled(v.jres, v.theme, set, [AID("popupBackground")], dsa, dsr).vals[0];
      if (bg) v.dropDownBackground = yield loadDrawableRV(v.jres!, bg, v.theme);
    })),
    "setThreshold(I)V": function (this: JAutoComplete, t: number) { this.threshold = t <= 0 ? 1 : t; },
    "setDropDownAnchor(I)V": function (this: JAutoComplete, id: number) { this.dropDownAnchor = id; },
    "getDropDownAnchor()I": function (this: JAutoComplete) { return this.dropDownAnchor; },
    "setDropDownBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JAutoComplete, drawable: unknown) {
      this.dropDownBackground = drawable;
      if (this.popup) return vcall(this.popup, "setBackgroundDrawable", "(Landroid/graphics/drawable/Drawable;)V", drawable);
    },
    "setDropDownBackgroundResource(I)V": driven(function* (this: JAutoComplete, id: number): Gen {
      const resources = id ? yield vcall(this, "getResources", "()Landroid/content/res/Resources;") : null;
      yield vcall(this, "setDropDownBackgroundDrawable", "(Landroid/graphics/drawable/Drawable;)V",
        id ? yield vcall(resources, "getDrawable", "(I)Landroid/graphics/drawable/Drawable;", id) : null);
    }),
    "getDropDownBackground()Landroid/graphics/drawable/Drawable;": function (this: JAutoComplete) { return this.dropDownBackground; },
    "enoughToFilter()Z": function (this: JAutoComplete) { return this.text.length >= this.threshold ? 1 : 0; },
    "refreshAutoCompleteResults()V": driven(function* (this: JAutoComplete): Gen {
      if (yield vcall(this, "enoughToFilter", "()Z")) {
        yield vcall(this, "performFiltering", "(Ljava/lang/CharSequence;I)V", this.text, 0);
      } else {
        yield vcall(this, "dismissDropDown", "()V");
        if (this.adapter && rt.iof(this.adapter, "android/widget/Filterable")) {
          const filter = yield vcall(this.adapter, "getFilter", "()Landroid/widget/Filter;");
          if (filter) yield vcall(filter, "filter", "(Ljava/lang/CharSequence;)V", null);
        }
      }
    }),
    "showDropDown()V": driven(function* (this: JAutoComplete): Gen {
      const p = yield this.listPopup();
      if (!(yield vcall(p, "getAnchorView", "()Landroid/view/View;"))) {
        const root = rootOf(this);
        const anchor = this.dropDownAnchor !== -1 ? yield vcall(root, "findViewById", "(I)Landroid/view/View;", this.dropDownAnchor) : this;
        yield vcall(p, "setAnchorView", "(Landroid/view/View;)V", anchor);
      }
      const { w, h, x, y } = this.dropDown;
      yield vcall(p, "setWidth", "(I)V", w); yield vcall(p, "setHeight", "(I)V", h);
      yield vcall(p, "setHorizontalOffset", "(I)V", x); yield vcall(p, "setVerticalOffset", "(I)V", y);
      yield vcall(p, "show", "()V");
    }),
    "dismissDropDown()V": function (this: JAutoComplete) { if (this.popup) return vcall(this.popup, "dismiss", "()V"); },
    "isPopupShowing()Z": function (this: JAutoComplete) { return popupShowing(this); },
    "setOnDismissListener(Landroid/widget/AutoCompleteTextView$OnDismissListener;)V": function (this: JAutoComplete, listener: unknown) {
      // AOSP wraps it in the popup's own dismiss listener
      this.dismissL = listener && Object.assign(new JObj(), { [mangleMethod("onDismiss", "()V")]: () => vcall(listener, "onDismiss", "()V") });
      if (this.popup) return vcall(this.popup, "setOnDismissListener", "(Landroid/widget/PopupWindow$OnDismissListener;)V", this.dismissL);
    },
    "setAdapter(Landroid/widget/ListAdapter;)V": function (this: JAutoComplete, a: unknown) {
      this.adapter = a;
      if (this.popup) return vcall(this.popup, "setAdapter", "(Landroid/widget/ListAdapter;)V", a);
    },
    ...fieldSetters({ "setOnItemClickListener(Landroid/widget/AdapterView$OnItemClickListener;)V": "itemClickL",
      "setOnItemSelectedListener(Landroid/widget/AdapterView$OnItemSelectedListener;)V": "itemSelectedL" }),
    ...fieldGetters({ "getAdapter()Landroid/widget/ListAdapter;": "adapter", "getThreshold()I": "threshold",
      "getOnItemClickListener()Landroid/widget/AdapterView$OnItemClickListener;": "itemClickL",
      "getOnItemSelectedListener()Landroid/widget/AdapterView$OnItemSelectedListener;": "itemSelectedL" }),
    ...Object.fromEntries(([["Width", "w"], ["Height", "h"], ["HorizontalOffset", "x"], ["VerticalOffset", "y"]] as const).flatMap(([n, k]) => [
      [`setDropDown${n}(I)V`, function (this: JAutoComplete, v: number) { this.dropDown[k] = v; }],
      [`getDropDown${n}()I`, function (this: JAutoComplete) { return this.dropDown[k]; }],
    ])),
    "setText(Ljava/lang/CharSequence;Z)V": driven(function* (this: JAutoComplete, cs: unknown): Gen {
      yield vcall(this, "setText", "(Ljava/lang/CharSequence;)V", cs);
    }),
    "convertSelectionToString(Ljava/lang/Object;)Ljava/lang/CharSequence;": driven(function* (o: unknown): Gen 
      { return (o === null ? "" : yield vcall(o, "toString", "()Ljava/lang/String;")); }),
    "performFiltering(Ljava/lang/CharSequence;I)V": driven(function* (this: JAutoComplete, cs: unknown): Gen {
      if (this.adapter && rt.iof(this.adapter, "android/widget/Filterable")) {
        const f = yield vcall(this.adapter, "getFilter", "()Landroid/widget/Filter;");
        if (f) yield vcall(f, "filter", "(Ljava/lang/CharSequence;Landroid/widget/Filter$FilterListener;)V", cs, this);
      }
    }),
    // AOSP updateDropDownForFilter: results show the dropdown while the field has focus
    "onFilterComplete(I)V": driven(function* (this: JAutoComplete, count: number): Gen {
      if (count > 0 && (yield vcall(this, "enoughToFilter", "()Z"))) { if (this.focused) yield vcall(this, "showDropDown", "()V"); }
      else if (yield popupShowing(this)) yield vcall(this, "dismissDropDown", "()V");
    }),
    "replaceText(Ljava/lang/CharSequence;)V": driven(function* (this: JAutoComplete, cs: unknown): Gen {
      yield vcall(this, "setText", "(Ljava/lang/CharSequence;)V", cs);
      yield setTextSelection(this.getEditable(), this.text.length, this.text.length);
    }),
    ...noops("setCompletionHint(Ljava/lang/CharSequence;)V",
      "clearListSelection()V", "performCompletion()V"),
    ...stubs(-1, "getListSelection()I"),
  },
});
rt.markers("android/widget/Filter$FilterListener");
rt.markers("android/widget/AutoCompleteTextView$OnDismissListener");
