import { expect, test } from "bun:test";
import "../natives";
import { rt, JObj } from "../jvm/runtime";
import { vcall, newObj } from "../jvm/natives/jlang";
import { JContext, systemService } from "./context";
import { mangleMethod } from "../jvm/abi";
import { textSelection } from "./text";
import { JView } from "./view";
import { imeInput, imeSelection, imeAction } from "./ime";
import { inMainJob, onMain } from "./mainloop";
test("the text services manager reports no installed spelling service", async () => {
  const manager = systemService(new JContext(), "textservices");
  expect(rt.iof(manager, "android/view/textservice/TextServicesManager")).toBe(1);
  expect(await vcall(manager, "isSpellCheckerEnabled", "()Z")).toBe(0);
  const checkers = await vcall(manager, "getEnabledSpellCheckerInfos", "()Ljava/util/List;");
  rt.link("java/util/ArrayList");
  expect(await vcall(checkers, "size", "()I")).toBe(0);
  const signature = "(Landroid/os/Bundle;Ljava/util/Locale;Landroid/view/textservice/SpellCheckerSession$SpellCheckerSessionListener;Z)Landroid/view/textservice/SpellCheckerSession;";
  expect(await vcall(manager, "newSpellCheckerSession", signature, null, null, new JObj(), 1)).toBeNull();
  expect(await vcall(manager, "newSpellCheckerSession", signature, null, new JObj(), new JObj(), 0)).toBeNull();
  await expect(vcall(manager, "newSpellCheckerSession", signature, null, null, null, 1)).rejects.toMatchObject({ msg: "listener" });
  await expect(vcall(manager, "newSpellCheckerSession", signature, null, null, new JObj(), 0)).rejects.toMatchObject({ msg: "locale" });
});

test("View and EditText retain independent automatic handwriting preferences", async () => {
  const view = new (rt.link("android/view/View").ctor)();
  const editor = new (rt.link("android/widget/EditText").ctor)();
  expect(await vcall(view, "isAutoHandwritingEnabled", "()Z")).toBe(1);
  expect(await vcall(editor, "isAutoHandwritingEnabled", "()Z")).toBe(1);
  await vcall(editor, "setAutoHandwritingEnabled", "(Z)V", 0);
  expect(await vcall(editor, "isAutoHandwritingEnabled", "()Z")).toBe(0);
  expect(await vcall(view, "isAutoHandwritingEnabled", "()Z")).toBe(1);
  await vcall(editor, "setAutoHandwritingEnabled", "(Z)V", 1);
  expect(await vcall(editor, "isAutoHandwritingEnabled", "()Z")).toBe(1);
});


class EditingState extends rt.link("android/text/SpannableStringBuilder").ctor { replacements = 0; }
rt.register({ name: "webdroid/ImeTestEditingState", ctor: EditingState, sup: "android/text/SpannableStringBuilder", methods: {
  "replace(IILjava/lang/CharSequence;II)Landroid/text/Editable;": async function (this: EditingState, ...args: unknown[]) {
    expect(inMainJob()).toBe(true); this.replacements++;
    return rt.link("android/text/SpannableStringBuilder").ctor.prototype[mangleMethod("replace", "(IILjava/lang/CharSequence;II)Landroid/text/Editable;")].apply(this, args);
  },
} });
class Connection extends rt.link("android/view/inputmethod/BaseInputConnection").ctor {
  state = new EditingState(); closed = false; action = -1;
}
rt.register({ name: "webdroid/ImeTestConnection", ctor: Connection, sup: "android/view/inputmethod/BaseInputConnection", methods: {
  "getEditable()Landroid/text/Editable;": function (this: Connection) { return this.state; },
  "closeConnection()V": function (this: Connection) { expect(inMainJob()).toBe(true); this.closed = true; },
  "performEditorAction(I)Z": function (this: Connection, action: number) { expect(inMainJob()).toBe(true); this.action = action; return 1; },
} });
class Editor extends JView { connection: Connection | null = null; }
rt.register({ name: "webdroid/ImeTestEditor", ctor: Editor, sup: "android/view/View", methods: {
  "onCreateInputConnection(Landroid/view/inputmethod/EditorInfo;)Landroid/view/inputmethod/InputConnection;": async function (this: Editor, info: { imeOptions: number }) {
    expect(inMainJob()).toBe(true); info.imeOptions = 6;
    this.connection = await newObj("webdroid/ImeTestConnection", "(Landroid/view/View;Z)V", this, 1) as Connection; return this.connection;
  },
} });

test("browser IME uses an editor's virtual InputConnection and Editable on the main queue", async () => {
  rt.link("webdroid/ImeTestEditingState");
  const manager = await newObj("android/view/inputmethod/InputMethodManager"), editor = await newObj("webdroid/ImeTestEditor") as Editor;
  expect(await vcall(manager, "showSoftInput", "(Landroid/view/View;I)Z", editor, 0)).toBe(1);
  const connection = editor.connection!;
  await imeInput("1. e4 e5");
  expect(connection.state.text).toBe("1. e4 e5"); expect(connection.state.replacements).toBe(1);
  expect(await textSelection(connection.state)).toEqual([8, 8]);
  await imeSelection(3, 5); expect(await textSelection(connection.state)).toEqual([3, 5]);
  await imeInput("1. d4 e5", 5); expect(connection.state.text).toBe("1. d4 e5");
  await imeInput("1. d4", 5); expect(connection.state.text).toBe("1. d4");
  await imeInput("1. d4 ♟", 7, 7, true); await imeInput("1. d4 ♞", 7, 7, true);
  expect(connection.state.text).toBe("1. d4 ♞"); expect(await textSelection(connection.state)).toEqual([7, 7]);
  expect(await imeAction()).toBe(true); expect(connection.action).toBe(6);
  await imeInput("A😀B"); await imeSelection(3, 3);
  await onMain(() => vcall(connection, "deleteSurroundingTextInCodePoints", "(II)Z", 1, 0));
  expect(connection.state.text).toBe("AB"); expect(await textSelection(connection.state)).toEqual([1, 1]);
  await vcall(manager, "restartInput", "(Landroid/view/View;)V", editor);
  expect(connection.closed).toBe(true); expect(editor.connection).not.toBe(connection);
  await vcall(manager, "hideSoftInputFromWindow", "(Landroid/os/IBinder;I)Z", null, 0);
  expect(await vcall(manager, "showSoftInput", "(Landroid/view/View;I)Z", new JView(), 0)).toBe(0);
});


test("browser typing preserves the existing EditText path", async () => {
  const editor = await newObj("android/widget/EditText"), manager = await newObj("android/view/inputmethod/InputMethodManager");
  await vcall(manager, "showSoftInput", "(Landroid/view/View;I)Z", editor, 0);
  await imeInput("ordinary field");
  expect(editor.text).toBe("ordinary field"); expect(editor.rawText).toBe("ordinary field");
  await vcall(manager, "hideSoftInputFromWindow", "(Landroid/os/IBinder;I)Z", null, 0);
});

test("EditText input connections retain deletions in the view and its linked editable", async () => {
  const editor = await newObj("android/widget/EditText");
  await vcall(editor, "setText", "(Ljava/lang/CharSequence;)V", "abcde");
  const connection = await newObj("android/view/inputmethod/BaseInputConnection", "(Landroid/view/View;Z)V", editor, 1);
  const editable = await vcall(connection, "getEditable", "()Landroid/text/Editable;");
  expect(rt.iof(editable, "android/text/Editable")).toBe(1);
  await vcall(connection, "setSelection", "(II)Z", 2, 3);
  await vcall(connection, "deleteSurroundingText", "(II)Z", 1, 1);
  expect(editor.text).toBe("ace"); expect(editor.rawText).toBe("ace");
  expect(await vcall(connection, "getEditable", "()Landroid/text/Editable;")).toBe(editable);
  expect(editable.text).toBe("ace"); expect(await textSelection(editable)).toEqual([1, 2]);
  expect(await vcall(connection, "getTextBeforeCursor", "(II)Ljava/lang/CharSequence;", 10, 0)).toBe("a");
  expect(await vcall(connection, "getSelectedText", "(I)Ljava/lang/CharSequence;", 0)).toBe("c");
  expect(await vcall(connection, "getTextAfterCursor", "(II)Ljava/lang/CharSequence;", 10, 0)).toBe("e");
});
