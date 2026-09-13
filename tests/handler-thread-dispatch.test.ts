import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { JThread, curThread, mainThread, newObj, setCurThread, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
for (const logged of [false, true]) test(`${logged ? "logged" : "unlogged"} handler callbacks retain the looper thread across awaits`, async () => {
  const thread = new JThread();
  setCurThread(thread);
  await vcall(rt.link("android/os/Looper").ctor, "prepare", "()V");
  setCurThread(mainThread);
  const events: [string, JThread][] = [];
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const printer = {
    [mangleMethod("println", "(Ljava/lang/String;)V")]: async (s: string) => {
      events.push([s.startsWith(">") ? "before" : "after", curThread]);
      await Promise.resolve();
      if (s.startsWith("<")) complete();
    },
  };
  if (logged) await vcall(thread.looper, "setMessageLogging", "(Landroid/util/Printer;)V", printer);
  const callback = {
    [mangleMethod("handleMessage", "(Landroid/os/Message;)Z")]: async () => {
      events.push(["callback", curThread]);
      await Promise.resolve();
      return 0;
    },
  };
  const handler = await newObj("android/os/Handler", "(Landroid/os/Looper;Landroid/os/Handler$Callback;)V", thread.looper, callback);
  Object.assign(handler, { [mangleMethod("handleMessage", "(Landroid/os/Message;)V")]: () => { events.push(["handler", curThread]); if (!logged) complete(); } });
  await vcall(handler, "sendEmptyMessage", "(I)Z", 1);
  await done;
  expect(events.map(([name]) => name)).toEqual(logged ? ["before", "callback", "handler", "after"] : ["callback", "handler"]);
  expect(events.map(([, observed]) => observed === thread)).toEqual(logged ? [true, true, true, true] : [true, true]);
});
