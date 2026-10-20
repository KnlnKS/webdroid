import { expect, test, describe, beforeAll } from "vite-plus/test";
import "../src/natives.ts";
import { TV } from "../src/android/axml.ts";
import { vcall, newObj, scall, linkInit, JThread, curThread, setCurThread, iof } from "../src/jvm/natives/jentry.ts";
import { rt, JObj, getDeclared } from "../src/jvm/runtime.ts";
import { bootApp, packageRecord } from "./java.ts";
import { startMainLooper } from "../src/android/mainloop.ts";
import { NativeLooper, onMain, fnRunnable, postRunnable } from "../src/android/mainloop.ts";
import { BridgeCalls } from "../src/shell/bridgecalls.ts";
import { PROCESS_PID, setProcessIdentity, setProcessName } from "../src/android/os.ts";
import { UNAME } from "../src/shell/device-properties.ts";
import { binderTransport, importBinder, onCallerDeath } from "../src/android/binder.ts";
import { procList, procText, procWrite } from "../src/shell/procfs.ts";

describe("bundle-parcel", () => {
  test("a Bundle read from a Parcel stays parcelled until read, and is rewritten byte for byte", async () => {
    await startMainLooper();
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
    await startMainLooper();
    const config = await linkInit("android/graphics/Bitmap$Config");
    const b = await scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", 3, 2, config.static("ARGB_8888"));
    await vcall(b, "setDensity", "(I)V", 320);
    await vcall(b, "setHasAlpha", "(Z)V", 0);
    await vcall(b, "setPixel", "(III)V", 2, 1, 0xff336699 | 0);
    const p = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(p, "writeParcelable", "(Landroid/os/Parcelable;I)V", b, 0);
    await vcall(p, "setDataPosition", "(I)V", 0);
    const back = await vcall(p, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
    expect(iof(back, "android/graphics/Bitmap")).toBe(true);
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
  test("a consumed wake returns immediately without preventing the next park", async () => {
    const looper = new NativeLooper(curThread);
    looper.wake();
    expect(looper.pollOnce(-1)).toBeUndefined();
    expect(looper.polling).toBe(false);
    const parked = looper.pollOnce(-1);
    expect(parked).toBeInstanceOf(Promise);
    expect(looper.polling).toBe(true);
    looper.wake(); await parked;
    expect(looper.polling).toBe(false);
  });

  test("the main looper runs posts in order, a delayed one after its delay, and host jobs between them", async () => {
    await startMainLooper();
    const events: string[] = [];
    const runnable = (name: string) => fnRunnable(() => { events.push(name); });
    const t0 = performance.now();
    await onMain(async () => {
      await postRunnable(runnable("late"), 250);
      await postRunnable(runnable("a"));
      await postRunnable(runnable("b"));
    });
    await onMain(() => events.push("job"));
    expect(events).toEqual(["a", "b", "job"]);
    await new Promise((r) => setTimeout(r, 260));
    await onMain(() => {});
    expect(events).toEqual(["a", "b", "job", "late"]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
  });

  test("a HandlerThread loops on its own thread, with a tid and a /proc task of its own, until it quits", async () => {
    await startMainLooper();
    const thread = await newObj("android/os/HandlerThread", "(Ljava/lang/String;)V", "worker");
    expect(await vcall(thread, "getThreadId", "()I")).toBe(-1);
    await vcall(thread, "start", "()V");
    // the thread has its tid once its Looper is prepared, which getLooper waits for
    const looper = await vcall(thread, "getLooper", "()Landroid/os/Looper;"), tid = await vcall(thread, "getThreadId", "()I");
    expect(tid).not.toBe(await scall("android/os/Process", "myTid", "()I"));
    expect(await scall("android/os/Process", "myTid", "()I")).toBe(PROCESS_PID);
    const comm = `/proc/self/task/${tid}/comm`;
    expect(procList("/proc/self/task")).toContain(String(tid));
    expect(procText(comm)).toBe("worker\n");
    expect(procWrite(comm, "renamed\n")).toBe(true);
    expect(procText(comm)).toBe("renamed\n");
    const handler = await newObj("android/os/Handler", "(Landroid/os/Looper;)V", looper);
    const ran = new Promise<unknown>((resolve) => postRunnable(fnRunnable(async () => resolve(await scall("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;"))), 0, handler));
    expect(await ran).toBe(thread);
    expect(await vcall(thread, "quit", "()Z")).toBe(1);
    await vcall(thread, "join", "()V");
    expect(await vcall(thread, "isAlive", "()Z")).toBe(0);
    expect(procList("/proc/self/task")).not.toContain(String(tid));
  });
});

// one app process for the file, declaring the job service below
const PKG = "org.webdroid.test.os";
const app = async () => bootApp(await packageRecord(PKG, { application: [{ name: "service", attrs: [{ name: "name", str: ".Worker", ns: "", resId: 0, type: TV.STRING, data: 0 }], children: [] }] }));

describe("job-scheduler", () => {
  test("enqueued work reaches a bound service's JobServiceEngine and finishing unbinds it", async () => {
    const events: string[] = [];
    rt.register({ name: "test/jobs/Engine", ctor: class extends JObj {},
      sup: "android/app/job/JobServiceEngine", methods: {
        "onStartJob(Landroid/app/job/JobParameters;)Z": async (params: JObj) => {
          for (let item; (item = await vcall(params, "dequeueWork", "()Landroid/app/job/JobWorkItem;"));) {
            events.push(await vcall(await vcall(item, "getIntent", "()Landroid/content/Intent;"), "getAction", "()Ljava/lang/String;"));
            await vcall(params, "completeWork", "(Landroid/app/job/JobWorkItem;)V", item);
          }
          return 1;
        },
      } });
    rt.register({ name: PKG.replace(/\./g, "/") + "/Worker", ctor: class extends JObj {}, sup: "android/app/Service", methods: {
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

describe("parcel-string16", () => {

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
  beforeAll(app);

  test("system properties distinguish configured keys from absent names", async () => {
    const cls = "android/os/SystemProperties";
    expect(await scall(cls, "get", "(Ljava/lang/String;)Ljava/lang/String;", "dalvik.vm.heapgrowthlimit")).toBe("192m");
    for (const key of ["webdroid.absent", "toString", "constructor", "__proto__"]) {
      expect(await scall(cls, "get", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", key, "absent")).toBe("absent");
      expect(await scall(cls, "find", "(Ljava/lang/String;)Landroid/os/SystemProperties$Handle;", key)).toBe(null);
    }
  });

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

describe("uname", () => {

  test("uname reports the reference kernel", async () => {
    const uts = await scall("android/system/Os", "uname", "()Landroid/system/StructUtsname;");
    const field = (name: string) => getDeclared<string>(uts, "android/system/StructUtsname", name);
    expect(field("sysname")).toBe("Linux");
    expect(field("release")).toBe(UNAME.release);
    expect(field("machine")).toBe("aarch64");
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
  function callback(binder: unknown) {
    const result = new Callback(); result.binder = binder; return result;
  }
  const register = (list: unknown, cb: unknown, cookie: unknown = null) => vcall(list, "register", "(Landroid/os/IInterface;Ljava/lang/Object;)Z", cb, cookie);
  const count = (list: unknown) => vcall(list, "getRegisteredCallbackCount", "()I");

  test.each([false, true])("RemoteCallbackList removes dead Binders and unlinks replacements (async=%s)", async (remote) => {
    const saved = { ...binderTransport }, watches = new Set<() => void>();
    let alive = true;
    binderTransport.alive = () => remote ? Promise.resolve(alive) : alive;
    binderTransport.watch = (_pid, died) => {
      watches.add(died);
      const cancel = () => { watches.delete(died); };
      return remote ? Promise.resolve(cancel) : cancel;
    };
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

test("a system service hears each caller's death once, through one watch per process", () => {
  const saved = { ...binderTransport }, watches: (() => void)[] = [], heard: string[] = [];
  binderTransport.watch = (_pid, died) => { watches.push(died); return () => {}; };
  try {
    onCallerDeath(4242, (pid) => heard.push("kept " + pid));
    const stop = onCallerDeath(4242, (pid) => heard.push("dropped " + pid));
    expect(watches.length).toBe(1);
    stop();
    watches[0]();
    expect(heard).toEqual(["kept 4242"]);
    onCallerDeath(4242, () => {});
    expect(watches.length).toBe(2);
  } finally { Object.assign(binderTransport, saved); }
});

describe("stats-log", () => {
  test("FrameworkStatsLog.write reaches libstats_jni, which StatsLog.<clinit> loads", async () => {
    await scall("com/android/internal/util/FrameworkStatsLog", "write", "(IIJII)V", 228, 10123, 123n, 1, 3);
  });
});
