import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, curThread, JThread, setCurThread, mainThread } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("native construction retains the caller thread through class initialization", async () => {
  const thread = new JThread(), seen: JThread[] = [];
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  rt.register({ name: "test/ThreadConstruction", ctor: class extends JObj {
    constructor() { super(); seen.push(curThread); }
  }, clinit: () => ready, methods: {
    "<init>()V": () => { seen.push(curThread); },
  } });
  setCurThread(thread);
  const creating = newObj("test/ThreadConstruction");
  setCurThread(mainThread);
  finish();
  await creating;
  expect(seen.map(t => t === thread)).toEqual([true, true]);
  expect(curThread).toBe(mainThread);
});
