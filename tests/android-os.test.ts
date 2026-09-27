import { expect, test, describe } from "bun:test";
import "../src/natives";
import { JActivity, JApplication, JService } from "../src/android/app";
import { appHost, setAppHost } from "../src/android/apphost";
import { packages, PackageRecord } from "../src/android/packages";
import { Resources } from "../src/android/res";
import { TV, type XmlAttr } from "../src/android/axml";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { vcall, newObj, vcallAsync, JThread, curThread, mainThread, setCurThread } from "../src/jvm/natives/jlang";
import { rt, JObj } from "../src/jvm/runtime";
import { onMain } from "../src/android/mainloop";
import { JBitmap } from "../src/android/graphics";
import { BridgeCalls } from "../src/shell/bridgecalls";
import { JHandler, JMessage, PROCESS_UID, setProcessIdentity, setProcessName } from "../src/android/os";
import { JBinder, binderTransport, importBinder } from "../src/android/binder";

describe("activity-main-queue", () => {
  rt.linkNatives();

  test("Activity.runOnUiThread runs inline in the main job", async () => {
    const events: string[] = [];
    const runnable = { [mangleMethod("run", "()V")]: () => { events.push("run"); } };
    await onMain(async () => {
      await vcall(new JActivity(), "runOnUiThread", "(Ljava/lang/Runnable;)V", runnable);
      events.push("after");
    });
    expect(events).toEqual(["run", "after"]);
  });
});

describe("bitmap-parcel", () => {
  rt.linkNatives();

  test("a Bitmap survives a Parcel round trip with its flags, geometry and pixels", async () => {
    const b = JBitmap.create(3, 2);
    b.density = 320; b.hasAlpha = false;
    await vcall(b, "setPixel", "(III)V", 2, 1, 0xff336699 | 0);
    const p = await newObj("android/os/Parcel", "()V");
    await vcall(p, "writeParcelable", "(Landroid/os/Parcelable;I)V", b, 0);
    await vcall(p, "setDataPosition", "(I)V", 0);
    const back: JBitmap = await vcall(p, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
    expect(back).toBeInstanceOf(JBitmap);
    expect(back).not.toBe(b);
    expect([back.w, back.h, back.density, back.hasAlpha]).toEqual([3, 2, 320, false]);
    expect(await vcall(back, "getPixel", "(II)I", 2, 1)).toBe(0xff336699 | 0);
    expect(await vcall(back, "getPixel", "(II)I", 0, 0)).toBe(0);
    const creator = (rt.link("android/graphics/Bitmap").ctor as any)[mangleStaticField("CREATOR")];
    expect(rt.iof(creator, "android/os/Parcelable$Creator")).toBe(1);
  });
});

describe("bridgecalls", () => {
  test("bridge replies belong to the peer that received the call", async () => {
    let sent: (message: string) => void = () => {};
    const message = new Promise<string>((resolve) => { sent = resolve; });
    const owner = { send(value: string) { sent(value); } };
    const other = { send(_value: string) {} };
    const bridge = new BridgeCalls<typeof owner>();
    const pending = bridge.call(new Request("http://localhost/webview-call", { method: "POST", body: "{}" }), owner, () => true);
    const seq = (await message).split("\n", 1)[0];
    bridge.reply(other, `${seq}\nwrong`);
    bridge.reply(owner, `${seq}\nright`);
    expect(await (await pending).text()).toBe("right");
  });
});

describe("cancellation-signal", () => {
  class CancelListener extends JObj { calls = 0; }
  rt.register({
    name: "test/CancelListener", ctor: CancelListener, ifaces: ["android/os/CancellationSignal$OnCancelListener"],
    methods: { "onCancel()V": function (this: CancelListener) { this.calls++; } },
  });
  rt.linkNatives();

  test("CancellationSignal dispatches exactly once and immediately for late listeners", async () => {
    const signal = await newObj("android/os/CancellationSignal");
    const first = new CancelListener();
    await vcall(signal, "setOnCancelListener", "(Landroid/os/CancellationSignal$OnCancelListener;)V", first);
    await vcall(signal, "cancel", "()V");
    await vcall(signal, "cancel", "()V");
    expect(first.calls).toBe(1);
    expect(await vcall(signal, "isCanceled", "()Z")).toBe(1);
    const late = new CancelListener();
    await vcall(signal, "setOnCancelListener", "(Landroid/os/CancellationSignal$OnCancelListener;)V", late);
    expect(late.calls).toBe(1);
    await expect(vcallAsync(signal, "throwIfCanceled", "()V")).rejects.toMatchObject({
      constructor: { $i: { name: "android/os/OperationCanceledException" } },
    });
  });

  test("SQLite cancellation overloads reject canceled work before touching the database", async () => {
    const signal = await newObj("android/os/CancellationSignal");
    await vcall(signal, "cancel", "()V");
    const db = rt.make("android/database/sqlite/SQLiteDatabase");
    await expect(vcallAsync(db, "rawQuery", "(Ljava/lang/String;[Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;", "select 1", null, signal))
      .rejects.toMatchObject({ constructor: { $i: { name: "android/os/OperationCanceledException" } } });
    await expect(vcallAsync(db, "rawQueryWithFactory", "(Landroid/database/sqlite/SQLiteDatabase$CursorFactory;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/database/Cursor;", null, "select 1", null, null, signal))
      .rejects.toMatchObject({ constructor: { $i: { name: "android/os/OperationCanceledException" } } });
  });
});

describe("handler", () => {
  class RecordingHandler extends JHandler {
    delivered: number[] = [];
  }
  class RecordingRunnable extends JObj {
    runs = 0;
    onRun: (() => void) | null = null;
  }
  rt.register({
    name: "test/RecordingHandler", ctor: RecordingHandler, sup: "android/os/Handler",
    methods: {
      "handleMessage(Landroid/os/Message;)V": function (this: RecordingHandler, message: JMessage) {
        this.delivered.push(message.arg1);
      },
    },
  });
  rt.register({
    name: "test/RecordingRunnable", ctor: RecordingRunnable, ifaces: ["java/lang/Runnable"],
    methods: { "run()V": function (this: RecordingRunnable) { this.runs++; this.onRun?.(); } },
  });
  rt.linkNatives();

  function message(what: number, value: number): JMessage {
    const result = new JMessage();
    result.what = what;
    result.arg1 = value;
    return result;
  }

  test("removing queued messages preserves other keys and a later replacement", async () => {
    const handler = new RecordingHandler();
    await onMain(async () => {
      await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(3, 1));
      await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(4, 2));
      expect(await vcall(handler, "hasMessages", "(I)Z", 3)).toBe(1);
      await vcall(handler, "removeMessages", "(I)V", 3);
      expect(await vcall(handler, "hasMessages", "(I)Z", 3)).toBe(0);
      await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(3, 3));
    });
    await onMain(() => {});
    expect(handler.delivered).toEqual([2, 3]);
  });

  test("a delayed message can be removed after its timer expires behind a busy looper", async () => {
    const handler = new RecordingHandler();
    await onMain(async () => {
      await vcall(handler, "sendMessageDelayed", "(Landroid/os/Message;J)Z", message(3, 1), 1n);
      await Bun.sleep(20);
      expect(await vcall(handler, "hasMessages", "(I)Z", 3)).toBe(1);
      await vcall(handler, "removeMessages", "(I)V", 3);
      await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(3, 2));
    });
    await onMain(() => {});
    expect(handler.delivered).toEqual([2]);
  });

  test("removing queued callbacks permits reposting the same runnable", async () => {
    const handler = new RecordingHandler(), removed = new RecordingRunnable(), kept = new RecordingRunnable();
    await onMain(async () => {
      await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", removed);
      await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", kept);
      await vcall(handler, "removeCallbacks", "(Ljava/lang/Runnable;)V", removed);
      await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", removed);
    });
    await onMain(() => {});
    expect(removed.runs).toBe(1);
    expect(kept.runs).toBe(1);
  });

  test("hasCallbacks reflects queued runnable identity", async () => {
    const handler = new RecordingHandler(), runnable = new RecordingRunnable();
    await onMain(async () => {
      expect(await vcall(handler, "hasCallbacks", "(Ljava/lang/Runnable;)Z", runnable)).toBe(0);
      await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", runnable);
      expect(await vcall(handler, "hasCallbacks", "(Ljava/lang/Runnable;)Z", runnable)).toBe(1);
      await vcall(handler, "removeCallbacks", "(Ljava/lang/Runnable;)V", runnable);
      expect(await vcall(handler, "hasCallbacks", "(Ljava/lang/Runnable;)Z", runnable)).toBe(0);
    });
  });

  test("removeCallbacksAndMessages cancels queued messages and runnables", async () => {
    const handler = new RecordingHandler(), runnable = new RecordingRunnable();
    await onMain(async () => {
      await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(3, 1));
      await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", runnable);
      await vcall(handler, "removeCallbacksAndMessages", "(Ljava/lang/Object;)V", null);
      await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", runnable);
    });
    await onMain(() => {});
    expect(handler.delivered).toEqual([]);
    expect(runnable.runs).toBe(1);
  });

  test("removeCallbacksAndMessages keeps work belonging to another token", async () => {
    const handler = new RecordingHandler();
    const removedToken = new JObj(), keptToken = new JObj();
    const removed = new RecordingRunnable(), kept = new RecordingRunnable();
    await onMain(async () => {
      const first = message(3, 1), second = message(3, 2);
      first.obj = removedToken; second.obj = keptToken;
      await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", first);
      await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", second);
      await vcall(handler, "postDelayed", "(Ljava/lang/Runnable;Ljava/lang/Object;J)Z", removed, removedToken, 0n);
      await vcall(handler, "postDelayed", "(Ljava/lang/Runnable;Ljava/lang/Object;J)Z", kept, keptToken, 0n);
      await vcall(handler, "removeCallbacksAndMessages", "(Ljava/lang/Object;)V", removedToken);
    });
    await onMain(() => {});
    expect(handler.delivered).toEqual([2]);
    expect(removed.runs).toBe(0);
    expect(kept.runs).toBe(1);
  });

  test("a long-lived Handler releases completed callback keys", async () => {
    const handler = new RecordingHandler();
    await onMain(() => {
      for (let i = 0; i < 1000; i++) handler.post(new RecordingRunnable(), 0);
    });
    await onMain(() => {});
    expect(handler.pending.size).toBe(0);
  });

  test("a callback can repost itself while being dispatched", async () => {
    const handler = new RecordingHandler(), runnable = new RecordingRunnable();
    runnable.onRun = () => { if (runnable.runs === 1) handler.post(runnable, 0); };
    await onMain(() => handler.post(runnable, 0));
    await onMain(() => {});
    await onMain(() => {});
    expect(runnable.runs).toBe(2);
    expect(handler.pending.size).toBe(0);
  });

  class IdleHandler extends JObj { calls = 0; keep = true; wake: (() => void) | null = null; }
  rt.register({ name: "test/QueueIdleHandler", ctor: IdleHandler, ifaces: ["android/os/MessageQueue$IdleHandler"], methods: {
    "queueIdle()Z": function (this: IdleHandler) { this.calls++; this.wake?.(); return +this.keep; },
  } });
  rt.link("test/QueueIdleHandler");
  test("queue idle state excludes future messages and removes cancelled due work", async () => {
    const handler = new RecordingHandler();
    const queue = await vcall(handler.looper, "getQueue", "()Landroid/os/MessageQueue;");
    await onMain(async () => {
      handler.send(message(1, 0), 10000);
      expect(await vcall(queue, "isIdle", "()Z")).toBe(1);
      handler.send(message(2, 0), 0);
      expect(await vcall(queue, "isIdle", "()Z")).toBe(0);
      handler.cancel(2);
      expect(await vcall(queue, "isIdle", "()Z")).toBe(1);
      handler.cancel(1);
    });
  });
  test("idle handlers run once per idle transition and can be removed", async () => {
    const handler = new RecordingHandler(), idle = new IdleHandler();
    const queue = await vcall(handler.looper, "getQueue", "()Landroid/os/MessageQueue;");
    let notified = new Promise<void>(resolve => { idle.wake = resolve; });
    await vcall(queue, "addIdleHandler", "(Landroid/os/MessageQueue$IdleHandler;)V", idle);
    await notified;
    expect(idle.calls).toBe(1);
    notified = new Promise<void>(resolve => { idle.wake = resolve; });
    handler.send(message(1, 2), 0);
    await notified;
    expect(idle.calls).toBe(2);
    await vcall(queue, "removeIdleHandler", "(Landroid/os/MessageQueue$IdleHandler;)V", idle);
    handler.send(message(1, 3), 0);
    await onMain(() => {});
    expect(idle.calls).toBe(2);
  });
});

describe("handler-thread-dispatch", () => {
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
});

describe("job-scheduler", () => {
  rt.linkNatives();
  test("enqueued work reaches a bound service's JobServiceEngine and finishing unbinds it", async () => {
    const pkg = "test.jobs", events: string[] = [];
    const attr = (name: string, str: string): XmlAttr => ({ name, str, ns: "", resId: 0, type: TV.STRING, data: 0 });
    packages.set(pkg, new PackageRecord({ name: "manifest", attrs: [attr("package", pkg)], children: [
      { name: "application", attrs: [], children: [{ name: "service", attrs: [attr("name", ".Worker")], children: [] }] },
    ] }, new Resources(null, {}), "/t.apk", 12345, async () => []));
    rt.register({ name: "test/jobs/Engine", ctor: class extends (rt.link("android/app/job/JobServiceEngine").ctor as new () => JObj) {},
      sup: "android/app/job/JobServiceEngine", methods: {
        "onStartJob(Landroid/app/job/JobParameters;)Z": async (params: JObj) => {
          for (let item; (item = await vcall(params, "dequeueWork", "()Landroid/app/job/JobWorkItem;"));) {
            events.push((await vcall(item, "getIntent", "()Landroid/content/Intent;")).action);
            await vcall(params, "completeWork", "(Landroid/app/job/JobWorkItem;)V", item);
          }
          return 1;
        },
      } });
    rt.register({ name: "test/jobs/Worker", ctor: class extends JService {}, sup: "android/app/Service", methods: {
      "<init>()V": function () {},
      "onBind(Landroid/content/Intent;)Landroid/os/IBinder;": async function (this: JService) {
        return vcall(await newObj("test/jobs/Engine", "(Landroid/app/Service;)V", this), "getBinder", "()Landroid/os/IBinder;");
      },
      "onDestroy()V": () => { events.push("destroy"); },
    } });
    const previous = appHost, app = new JApplication(), host = { pkg, application: app } as never;
    Reflect.set(app, "$host", host); setAppHost(host);
    try {
      const scheduler = rt.make("android/app/job/JobScheduler");
      const component = await newObj("android/content/ComponentName", "(Ljava/lang/String;Ljava/lang/String;)V", pkg, pkg + ".Worker");
      const info = await vcall(await newObj("android/app/job/JobInfo$Builder", "(ILandroid/content/ComponentName;)V", 7, component), "build", "()Landroid/app/job/JobInfo;");
      for (const action of ["a", "b"]) {
        const item = await newObj("android/app/job/JobWorkItem", "(Landroid/content/Intent;)V", await newObj("android/content/Intent", "(Ljava/lang/String;)V", action));
        await vcall(scheduler, "enqueue", "(Landroid/app/job/JobInfo;Landroid/app/job/JobWorkItem;)I", info, item);
      }
      for (let i = 0; i < 50 && !events.includes("destroy"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(events).toEqual(["a", "b", "destroy"]);
      expect(await vcall(scheduler, "getPendingJob", "(I)Landroid/app/job/JobInfo;", 7)).toBeNull();
    } finally { setAppHost(previous); packages.delete(pkg); }
  });
});

describe("keyevent-parcel", () => {
  rt.linkNatives();

  test("KeyEvent survives a Parcelable round trip", async () => {
    const event = await newObj("android/view/KeyEvent", "(II)V", 1, 87);
    const parcel = await newObj("android/os/Parcel", "()V");
    await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", event, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const restored = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
    expect(restored).not.toBe(event);
    expect(await vcall(restored, "getAction", "()I")).toBe(1);
    expect(await vcall(restored, "getKeyCode", "()I")).toBe(87);
  });
});

describe("parcel-string16", () => {
  rt.linkNatives();

  test("String16 keeps lone surrogates in short, long and unaligned strings", async () => {
    const strings = ["a\ud800", "x\udc00".repeat(20) + "😀", "\ud800y".repeat(9000)];
    const p = await newObj("android/os/Parcel", "()V");
    for (const s of strings) await vcall(p, "writeString16", "(Ljava/lang/String;)V", s);
    await vcall(p, "setDataPosition", "(I)V", 0);
    for (const s of strings) expect(await vcall(p, "readString16", "()Ljava/lang/String;")).toBe(s);
    const odd = await newObj("android/os/Parcel", "()V");
    await vcall(odd, "setDataPosition", "(I)V", 1);
    await vcall(odd, "writeString16", "(Ljava/lang/String;)V", strings[1]);
    await vcall(odd, "setDataPosition", "(I)V", 1);
    expect(await vcall(odd, "readString16", "()Ljava/lang/String;")).toBe(strings[1]);
  });
});

describe("process-user-handle", () => {
  rt.linkNatives();

  test("Process returns the canonical handle for its Android user", async () => {
    const process = rt.link("android/os/Process").ctor;
    const userHandle = rt.link("android/os/UserHandle").ctor;
    const current = await vcall(process, "myUserHandle", "()Landroid/os/UserHandle;");
    const byUid = await vcall(userHandle, "getUserHandleForUid", "(I)Landroid/os/UserHandle;", 10001);
    expect(current).toBe(byUid);
    expect(await vcall(current, "getIdentifier", "()I")).toBe(0);
    const secondary = await vcall(userHandle, "getUserHandleForUid", "(I)Landroid/os/UserHandle;", 1_012_345);
    expect(await vcall(secondary, "getIdentifier", "()I")).toBe(10);
  });
});

describe("procfs", () => {
  test("Java and native-facing procfs expose the current process cmdline", async () => {
    setProcessIdentity(2468, 10001);
    setProcessName("com.example.app");
    for (const path of ["/proc/self/cmdline", "/proc/2468/cmdline"]) {
      const file = await newObj("java/io/File", "(Ljava/lang/String;)V", path);
      expect(await vcall(file, "exists", "()Z")).toBe(1);
      const stream = await newObj("java/io/FileInputStream", "(Ljava/io/File;)V", file);
      const bytes = new Int8Array(64);
      const length = await vcall(stream, "read", "([B)I", bytes);
      expect(new TextDecoder().decode(new Uint8Array(bytes.buffer, 0, length))).toBe("com.example.app\0");
    }
    expect(await vcall(await newObj("java/io/File", "(Ljava/lang/String;)V", "/proc/9999/cmdline"), "exists", "()Z")).toBe(0);
    const status = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/proc/2468/status");
    const bytes = new Int8Array(512);
    const length = await vcall(status, "read", "([B)I", bytes);
    const text = new TextDecoder().decode(new Uint8Array(bytes.buffer, 0, length));
    expect(text).toContain("Pid:\t2468\n");
    expect(text).toContain("Uid:\t10001\t10001\t10001\t10001\n");
    expect(text).toContain("Cpus_allowed_list:\t");
  });
});

describe("remotecallbacklist", () => {
  class Callback extends JObj { binder: unknown = null; }
  rt.register({ name: "test/TwitchRemoteCallback", ctor: Callback, ifaces: ["android/os/IInterface"], methods: {
    "asBinder()Landroid/os/IBinder;": function (this: Callback) { return this.binder; },
  } });
  rt.linkNatives();
  function callback(binder: unknown = new JBinder()) {
    const result = new Callback(); result.binder = binder; return result;
  }
  const register = (list: unknown, cb: unknown, cookie: unknown = null) => vcall(list, "register", "(Landroid/os/IInterface;Ljava/lang/Object;)Z", cb, cookie);
  const unregister = (list: unknown, cb: unknown) => vcall(list, "unregister", "(Landroid/os/IInterface;)Z", cb);
  const count = (list: unknown) => vcall(list, "getRegisteredCallbackCount", "()I");

  test("RemoteCallbackList keys registrations by Binder and broadcasts a stable snapshot", async () => {
    const list = await newObj("android/os/RemoteCallbackList"), first = callback(), replacement = callback(first.binder);
    expect(await register(list, first, "old")).toBe(1);
    expect(await register(list, replacement, "new")).toBe(1);
    expect(await count(list)).toBe(1);
    expect(await vcall(list, "beginBroadcast", "()I")).toBe(1);
    expect(await unregister(list, first)).toBe(1);
    expect(await register(list, callback())).toBe(1);
    expect(await vcall(list, "getBroadcastItem", "(I)Landroid/os/IInterface;", 0)).toBe(replacement);
    expect(await vcall(list, "getBroadcastCookie", "(I)Ljava/lang/Object;", 0)).toBe("new");
    await expect(vcallAsync(list, "beginBroadcast", "()I")).rejects.toBeDefined();
    await vcall(list, "finishBroadcast", "()V");
    await expect(vcallAsync(list, "finishBroadcast", "()V")).rejects.toBeDefined();
    await vcall(list, "kill", "()V");
    expect(await count(list)).toBe(0);
    expect(await register(list, first)).toBe(0);
    expect(await vcall(list, "beginBroadcast", "()I")).toBe(0);
    await vcall(list, "finishBroadcast", "()V");
  });

  test("RemoteCallbackList removes dead remote Binders and unlinks replacement registrations", async () => {
    const saved = { ...binderTransport }, watches = new Set<() => void>();
    let alive = true;
    binderTransport.alive = () => alive;
    binderTransport.watch = (_pid, died) => { watches.add(died); return () => { watches.delete(died); }; };
    try {
      const list = await newObj("android/os/RemoteCallbackList"), cb = callback(importBinder({ pid: 987654, id: 1 }));
      expect(await register(list, cb)).toBe(1);
      expect(await register(list, cb)).toBe(1);
      expect(watches.size).toBe(1);
      const previousThread = curThread;
      setCurThread(new JThread()); const first = register(list, cb);
      setCurThread(new JThread()); const second = register(list, cb);
      setCurThread(previousThread);
      await Promise.all([first, second]);
      expect(watches.size).toBe(1);
      alive = false;
      for (const died of watches) died();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(await count(list)).toBe(0);
      expect(await register(list, cb)).toBe(0);
    } finally { Object.assign(binderTransport, saved); }
  });
});

describe("stats-event", () => {
  rt.linkNatives();

  test("StatsEvent encodes typed fields and annotations and reports invalid atom order", async () => {
    const builder = await vcall(rt.link("android/util/StatsEvent").ctor, "newBuilder", "()Landroid/util/StatsEvent$Builder;");
    await vcall(builder, "setAtomId", "(I)Landroid/util/StatsEvent$Builder;", 42);
    await vcall(builder, "writeInt", "(I)Landroid/util/StatsEvent$Builder;", -1);
    await vcall(builder, "addBooleanAnnotation", "(BZ)Landroid/util/StatsEvent$Builder;", 3, 1);
    const event = await vcall(builder, "build", "()Landroid/util/StatsEvent;");
    const bytes: Int8Array = await vcall(event, "getBytes", "()[B");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([...bytes.slice(0, 3)]).toEqual([7, 3, 1]);
    expect(view.getInt32(12, true)).toBe(42);
    expect(bytes[16]).toBe(0x10);
    expect(view.getInt32(17, true)).toBe(-1);
    expect([...bytes.slice(21)]).toEqual([3, 5, 1]);
    const bad = await vcall(rt.link("android/util/StatsEvent").ctor, "newBuilder", "()Landroid/util/StatsEvent$Builder;");
    await vcall(bad, "writeInt", "(I)Landroid/util/StatsEvent$Builder;", 10);
    await vcall(bad, "setAtomId", "(I)Landroid/util/StatsEvent$Builder;", 42);
    const failed = await vcall(bad, "build", "()Landroid/util/StatsEvent;");
    const error: Int8Array = await vcall(failed, "getBytes", "()[B");
    expect(error[16]).toBe(15);
    expect(new DataView(error.buffer, error.byteOffset).getInt32(17, true)).toBe(0x2000);
  });

  test("StatsEvent long arrays retain the list header and signed 64-bit values", async () => {
    const builder = await vcall(rt.link("android/util/StatsEvent").ctor, "newBuilder", "()Landroid/util/StatsEvent$Builder;");
    await vcall(builder, "setAtomId", "(I)Landroid/util/StatsEvent$Builder;", 42);
    await vcall(builder, "writeLongArray", "([J)Landroid/util/StatsEvent$Builder;", BigInt64Array.of(-1n, 9223372036854775807n));
    const event = await vcall(builder, "build", "()Landroid/util/StatsEvent;");
    const bytes: Int8Array = await vcall(event, "getBytes", "()[B");
    expect(Array.from(bytes.slice(16, 19))).toEqual([3, 2, 1]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getBigInt64(19, true)).toBe(-1n);
    expect(view.getBigInt64(27, true)).toBe(9223372036854775807n);
  });
});

describe("system-health", () => {
  rt.linkNatives();

  test("system health exposes an empty UID snapshot without invented measurements", async () => {
    const context = rt.make("android/content/Context");
    const manager = await vcall(context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "systemhealth");
    expect(manager).not.toBeNull();
    const snapshot = await vcall(manager, "takeUidSnapshot", "(I)Landroid/os/health/HealthStats;", PROCESS_UID);
    expect(await vcall(snapshot, "getDataType", "()Ljava/lang/String;")).toBe("UidHealthStats");
    expect(await vcall(snapshot, "hasMeasurement", "(I)Z", 10001)).toBe(0);
    await expect(vcallAsync(manager, "takeUidSnapshot", "(I)Landroid/os/health/HealthStats;", PROCESS_UID + 1)).rejects.toBeDefined();
  });
});
