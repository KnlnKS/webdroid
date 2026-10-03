import { expect, test, describe, beforeAll } from "bun:test";
import "../src/natives";
import { TV } from "../src/android/axml";
import { vcall, newObj, scall, linkInit, JThread, curThread, setCurThread } from "../src/jvm/natives/jlang";
import { rt, JObj } from "../src/jvm/runtime";
import { loadFrameworkJar, loadLibcore, bootApp, packageRecord } from "./java";
import { onMain, fnRunnable, postRunnable, postTo } from "../src/android/mainloop";
import { BridgeCalls } from "../src/shell/bridgecalls";
import { PROCESS_PID, setProcessIdentity, setProcessName } from "../src/android/os";
import { binderTransport, importBinder } from "../src/android/binder";

describe("bundle-parcel", () => {
  test("a Bundle read from a Parcel stays parcelled until read, and is rewritten byte for byte", async () => {
    await loadLibcore(); await loadFrameworkJar();
    rt.linkNatives();
    const P = "Landroid/os/Parcel;", parcel = await scall("android/os/Parcel", "obtain", `()${P}`);
    const bundle = await newObj("android/os/Bundle");
    await vcall(bundle, "putString", "(Ljava/lang/String;Ljava/lang/String;)V", "s", "text");
    await vcall(bundle, "putLong", "(Ljava/lang/String;J)V", "l", 7n);
    await vcall(parcel, "writeBundle", `(Landroid/os/Bundle;)V`, bundle);
    const bytes = await vcall(parcel, "marshall", "()[B") as Int8Array;
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const read = await vcall(parcel, "readBundle", "()Landroid/os/Bundle;");
    expect(await vcall(read, "isParcelled", "()Z")).toBe(1);
    expect(await vcall(read, "getSize", "()I")).toBe(bytes.length - 8);
    const copy = await scall("android/os/Parcel", "obtain", `()${P}`);
    await vcall(copy, "writeBundle", `(Landroid/os/Bundle;)V`, read);
    expect([...await vcall(copy, "marshall", "()[B") as Int8Array]).toEqual([...bytes]);
    expect(await vcall(read, "getLong", "(Ljava/lang/String;)J", "l")).toBe(7n);
    expect(await vcall(read, "isParcelled", "()Z")).toBe(0);
    expect(await vcall(read, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "s")).toBe("text");
  });
});

describe("bitmap-parcel", () => {
  test("a Bitmap survives a Parcel round trip with its flags, geometry and pixels", async () => {
    await loadLibcore(); await loadFrameworkJar();
    rt.linkNatives();
    const config = (await linkInit("android/graphics/Bitmap$Config")).ctor as Record<string, unknown>;
    const b = await scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", 3, 2, config.s$ARGB_8888);
    await vcall(b, "setDensity", "(I)V", 320);
    await vcall(b, "setHasAlpha", "(Z)V", 0);
    await vcall(b, "setPixel", "(III)V", 2, 1, 0xff336699 | 0);
    const p = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(p, "writeParcelable", "(Landroid/os/Parcelable;I)V", b, 0);
    await vcall(p, "setDataPosition", "(I)V", 0);
    const back = await vcall(p, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
    expect(rt.iof(back, "android/graphics/Bitmap")).toBe(1);
    expect(back).not.toBe(b);
    const get = (name: string) => vcall(back, name, name.startsWith("has") ? "()Z" : "()I");
    expect([await get("getWidth"), await get("getHeight"), await get("getDensity"), await get("hasAlpha")]).toEqual([3, 2, 320, 0]);
    expect(await vcall(back, "getPixel", "(II)I", 2, 1)).toBe(0xff336699 | 0);
    expect(await vcall(back, "getPixel", "(II)I", 0, 0)).toBe(0);
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

describe("looper", () => {
  test("the main looper runs posts in order, a delayed one after its delay, and host jobs between them", async () => {
    await loadLibcore(); await loadFrameworkJar(); rt.linkNatives();
    const events: string[] = [];
    const runnable = (name: string) => fnRunnable(() => { events.push(name); });
    const t0 = performance.now();
    await onMain(async () => {
      await postRunnable(runnable("late"), 30);
      await postRunnable(runnable("a"));
      await postRunnable(runnable("b"));
    });
    await onMain(() => events.push("job"));
    expect(events).toEqual(["a", "b", "job"]);
    await new Promise((r) => setTimeout(r, 40));
    await onMain(() => {});
    expect(events).toEqual(["a", "b", "job", "late"]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(30);
  });

  test("a HandlerThread loops on its own thread, with a tid of its own, until it quits", async () => {
    await loadLibcore(); await loadFrameworkJar(); rt.linkNatives();
    const thread = await newObj("android/os/HandlerThread", "(Ljava/lang/String;)V", "worker");
    expect(await vcall(thread, "getThreadId", "()I")).toBe(-1);
    await vcall(thread, "start", "()V");
    const tid = await vcall(thread, "getThreadId", "()I");
    expect(tid).not.toBe(await scall("android/os/Process", "myTid", "()I"));
    expect(await scall("android/os/Process", "myTid", "()I")).toBe(PROCESS_PID);
    const handler = await newObj("android/os/Handler", "(Landroid/os/Looper;)V", await vcall(thread, "getLooper", "()Landroid/os/Looper;"));
    const ran = new Promise<unknown>((resolve) => postTo(handler, () => resolve(curThread)));
    expect(await ran).toBe(thread);
    expect(await vcall(thread, "quit", "()Z")).toBe(1);
    await vcall(thread, "join", "()V");
    expect(await vcall(thread, "isAlive", "()Z")).toBe(0);
  });
});

// one app process for the file, declaring the job service below
const PKG = "org.webdroid.test.os";
const app = async () => bootApp(await packageRecord(PKG, { application: [{ name: "service", attrs: [{ name: "name", str: ".Worker", ns: "", resId: 0, type: TV.STRING, data: 0 }], children: [] }] }));

describe("job-scheduler", () => {
  rt.linkNatives();
  test("enqueued work reaches a bound service's JobServiceEngine and finishing unbinds it", async () => {
    const events: string[] = [];
    rt.register({ name: "test/jobs/Engine", ctor: class extends (rt.link("android/app/job/JobServiceEngine").ctor as new () => JObj) {},
      sup: "android/app/job/JobServiceEngine", methods: {
        "onStartJob(Landroid/app/job/JobParameters;)Z": async (params: JObj) => {
          for (let item; (item = await vcall(params, "dequeueWork", "()Landroid/app/job/JobWorkItem;"));) {
            events.push(await vcall(await vcall(item, "getIntent", "()Landroid/content/Intent;"), "getAction", "()Ljava/lang/String;"));
            await vcall(params, "completeWork", "(Landroid/app/job/JobWorkItem;)V", item);
          }
          return 1;
        },
      } });
    rt.register({ name: PKG.replace(/\./g, "/") + "/Worker", ctor: class extends (rt.link("android/app/Service").ctor as new () => JObj) {}, sup: "android/app/Service", methods: {
      "onBind(Landroid/content/Intent;)Landroid/os/IBinder;": async function (this: JObj) {
        return vcall(await newObj("test/jobs/Engine", "(Landroid/app/Service;)V", this), "getBinder", "()Landroid/os/IBinder;");
      },
      "onDestroy()V": () => { events.push("destroy"); },
    } });
    const scheduler = await vcall(await app(), "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "jobscheduler");
    const component = await newObj("android/content/ComponentName", "(Ljava/lang/String;Ljava/lang/String;)V", PKG, PKG + ".Worker");
    const info = await vcall(await newObj("android/app/job/JobInfo$Builder", "(ILandroid/content/ComponentName;)V", 7, component), "build", "()Landroid/app/job/JobInfo;");
    for (const action of ["a", "b"]) {
      const item = await newObj("android/app/job/JobWorkItem", "(Landroid/content/Intent;)V", await newObj("android/content/Intent", "(Ljava/lang/String;)V", action));
      await vcall(scheduler, "enqueue", "(Landroid/app/job/JobInfo;Landroid/app/job/JobWorkItem;)I", info, item);
    }
    for (let i = 0; i < 50 && !events.includes("destroy"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(["a", "b", "destroy"]);
    expect(await vcall(scheduler, "getPendingJob", "(I)Landroid/app/job/JobInfo;", 7)).toBeNull();
  });
});

describe("keyevent-parcel", () => {
  rt.linkNatives();

  test("KeyEvent survives a Parcelable round trip", async () => {
    const event = await newObj("android/view/KeyEvent", "(II)V", 1, 87);
    const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
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
    const p = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    for (const s of strings) await vcall(p, "writeString16", "(Ljava/lang/String;)V", s);
    await vcall(p, "setDataPosition", "(I)V", 0);
    for (const s of strings) expect(await vcall(p, "readString16", "()Ljava/lang/String;")).toBe(s);
    const odd = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(odd, "setDataPosition", "(I)V", 1);
    await vcall(odd, "writeString16", "(Ljava/lang/String;)V", strings[1]);
    await vcall(odd, "setDataPosition", "(I)V", 1);
    expect(await vcall(odd, "readString16", "()Ljava/lang/String;")).toBe(strings[1]);
  });
});

describe("environment", () => {
  rt.linkNatives();
  beforeAll(app);

  test("AOSP's Environment finds shared storage through the storage service's volume", async () => {
    const env = "android/os/Environment", dir = await scall(env, "getExternalStorageDirectory", "()Ljava/io/File;");
    expect(await vcall(dir, "getPath", "()Ljava/lang/String;")).toBe("/sdcard");
    expect(await scall(env, "getExternalStorageState", "()Ljava/lang/String;")).toBe("mounted");
    expect(await scall(env, "isExternalStorageEmulated", "()Z")).toBe(1);
    expect(await scall(env, "isExternalStorageRemovable", "()Z")).toBe(0);
    const files: JObj[] = await scall(env, "buildExternalStorageAppFilesDirs", "(Ljava/lang/String;)[Ljava/io/File;", PKG);
    expect(await vcall(files[0], "getPath", "()Ljava/lang/String;")).toBe(`/sdcard/Android/data/${PKG}/files`);
  });
});

describe("procfs", () => {
  test("Java and native-facing procfs expose the current process cmdline", async () => {
    await loadLibcore();
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
  function callback(binder: unknown) {
    const result = new Callback(); result.binder = binder; return result;
  }
  const register = (list: unknown, cb: unknown, cookie: unknown = null) => vcall(list, "register", "(Landroid/os/IInterface;Ljava/lang/Object;)Z", cb, cookie);
  const count = (list: unknown) => vcall(list, "getRegisteredCallbackCount", "()I");

  test("RemoteCallbackList removes dead remote Binders and unlinks replacement registrations", async () => {
    const saved = { ...binderTransport }, watches = new Set<() => void>();
    let alive = true;
    binderTransport.alive = () => alive;
    binderTransport.watch = (_pid, died) => { watches.add(died); return () => { watches.delete(died); }; };
    try {
      const list = await newObj("android/os/RemoteCallbackList"), cb = callback(await importBinder({ pid: 987654, id: 1 }));
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

describe("long-sparse-array", () => {
  test("LongSparseArray orders full-width keys and searches insertion positions", async () => {
    const a = await newObj("android/util/LongSparseArray");
    const hi = 9007199254740993n;
    for (const [key, value] of [[hi, "high"], [-hi, "low"], [0n, "zero"]]) await vcall(a, "put", "(JLjava/lang/Object;)V", key, value);
    expect(await vcall(a, "keyAt", "(I)J", 0)).toBe(-hi);
    expect(await vcall(a, "indexOfKey", "(J)I", hi - 1n)).toBe(~2);
    expect(await vcall(a, "indexOfValue", "(Ljava/lang/Object;)I", "high")).toBe(2);
    const copy = await vcall(a, "clone", "()Landroid/util/LongSparseArray;");
    await vcall(a, "remove", "(J)V", hi);
    expect(await vcall(copy, "get", "(J)Ljava/lang/Object;", hi)).toBe("high");
  });
});
