import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { JEditText, editorAction } from "../src/android/textview";

rt.linkNatives();
class KeyListener extends JObj { keys: [number, number][] = []; [mangleMethod("onKey", "(Landroid/view/View;ILandroid/view/KeyEvent;)Z")](_v: unknown, code: number, ev: any) { this.keys.push([ev.action, code]); return 1; } }
class ActionListener extends JObj { actions: number[] = []; consume = 1; [mangleMethod("onEditorAction", "(Landroid/widget/TextView;ILandroid/view/KeyEvent;)Z")](_v: unknown, action: number) { this.actions.push(action); return this.consume; } }

test("an editor action nobody listens for arrives as an ENTER key press", async () => {
  const field = new JEditText(); field.enabled = true;
  const keys = new KeyListener(); field.keyL = keys;
  expect(await editorAction(field, 3)).toBe(true);
  expect(keys.keys).toEqual([[0, 66], [1, 66]]);
});

test("a consuming editor-action listener takes the action and no key is sent", async () => {
  const field = new JEditText(); field.enabled = true;
  const keys = new KeyListener(), actions = new ActionListener();
  field.keyL = keys; field.editorActionL = actions;
  expect(await editorAction(field, 3)).toBe(true);
  expect(actions.actions).toEqual([3]);
  expect(keys.keys).toEqual([]);
  actions.consume = 0;
  await editorAction(field, 2);
  expect(keys.keys).toEqual([[0, 66], [1, 66]]);
  await editorAction(field, 6);
  expect(keys.keys.length).toBe(2);
});
