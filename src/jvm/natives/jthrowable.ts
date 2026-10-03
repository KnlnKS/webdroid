// java.lang.Throwable: its captured stack, the traces Java reads from it (stacklines.ts resolves
// their lines), and a throwable no Java frame catches: one escaping a thread, or a call no Java
// frame waits on (detached, with an Escape policy).

import { awaited, rt, JObj, type ClassInfo, type NativeSpec, driven, type Gen } from "../runtime";
import { mangleMethod, mangleField, demangle, frameOf, jarray, dotName } from "../abi";
import { coldStack, COLD_SOURCE, type ColdAt } from "../cold";
import { frameSource, type FrameAt } from "../stacklines";
import { inStrand, newStrand } from "../suspend";
import { processExited } from "../../process-exit";
import { after, callOn, curThread, mainThread, vcall, vcallOn, type JThread } from "./jentry";
import { jclsName } from "./jlang";

export class JThrowable extends JObj {
  msg: string | null = null;
  cause: JThrowable | null = null;
  suppressed: JThrowable[] = [];
  /** captured by fillInStackTrace(), which Throwable's constructors call virtually */
  jsErr: Error | null = null;
  /** the cold frames it was thrown through, innermost last */
  coldFrames: readonly ColdAt[] = NO_FRAMES;
  get jsStack(): string | undefined { return this.jsErr?.stack; }
  /** memoised getStackTrace(), or what setStackTrace() was handed */
  trace: unknown[] | null = null;
}
const STACK_DEPTH = 64, NO_FRAMES: readonly ColdAt[] = [];
/** the JS stack here, deep enough to hold the Java frames a trace reports */
function jsStackHere(): Error {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_DEPTH;
  const js = new Error();
  Error.stackTraceLimit = limit;
  return js;
}
function captureStack(t: JThrowable): void {
  if (rt.throwables && rt.throwables.length < 500) rt.throwables.push(t);
  const quiet = rt.quiet.types;
  t.trace = null;
  if (quiet !== null && quiet.split("|").some((n) => (t.constructor as { $i?: ClassInfo }).$i?.types.has(n))) {
    t.jsErr = null;
    t.coldFrames = NO_FRAMES;
    return;
  }
  t.jsErr = jsStackHere();
  t.coldFrames = coldStack.length ? coldStack.slice(-STACK_DEPTH).map(({ method, next }) => ({ method, next })) : NO_FRAMES;
}
/** A trace's frame: class, method, and where it was (null for a native method's) */
type JavaFrame = [cls: string, method: string, at: FrameAt | null];
/** The Java frames of a captured JS stack, innermost first. A compiled body's function name names
 *  its class and method (abi's frameName), each cold handler frame is the next interpreted method
 *  outward, and a class's own source ("wd/pkg/Class.js") holds its native methods' stubs. */
function javaFrames(js: string | undefined, cold: readonly ColdAt[]): JavaFrame[] {
  const out: JavaFrame[] = [];
  let k = cold.length;
  for (const line of (js ?? "").split("\n")) {
    const at = /^\s*at (?:(.*) \()?(.*?)(?::(\d+):\d+)?\)?$/.exec(line);
    if (!at) continue;
    const [, fn = "", url, row] = at, compiled = frameOf(fn);
    if (compiled) out.push([compiled[0], compiled[1], { url, line: Number(row), methodIdx: compiled[2] }]);
    else if (url === COLD_SOURCE) {
      const c = cold[--k];
      if (c) {
        const name = c.method.name, dot = name.indexOf(".");
        out.push([name.slice(0, dot), name.slice(dot + 1, name.indexOf("(", dot)), c]);
      }
    } else {
      const cls = /^wd\/([^.?]*)\.js$/.exec(url)?.[1];
      const named = cls && demangle(/\[as (\S+)\]$/.exec(fn)?.[1] ?? fn.slice(fn.lastIndexOf(".") + 1));
      if (named) out.push([cls, named[0], null]);
    }
  }
  return out;
}
/**
 * StackTraceElements for Java frames. An EMPTY trace is not a thing any JVM produces, and library
 * code counts on that: kotlinx.coroutines' stack-trace recovery does `copyOfRange(trace, 1, trace.size)`
 * on the way out of a *caught* exception, which on an empty array throws — turning a handled
 * failure into a fatal one.
 */
function stackTrace(frames: JavaFrame[]): unknown[] {
  const ste = rt.link("java/lang/StackTraceElement");
  rt.ensureCompiled(ste);
  const element = (cls: string, method: string, [file, line]: [string | null, number]) => {
    const e = new ste.ctor();
    e[STE_CLASS] = dotName(cls); e[STE_METHOD] = method; e[STE_FILE] = file; e[STE_LINE] = line;
    return e;
  };
  const out = frames.map(([cls, method, at]) => element(cls, method, frameSource(rt, cls, at)));
  if (!out.length) out.push(element("", "", ["", -1]));
  return jarray(out, "Ljava/lang/StackTraceElement;");
}
const STE = "java/lang/StackTraceElement", STE_CLASS = mangleField(STE, "declaringClass"), STE_METHOD = mangleField(STE, "methodName"),
  STE_FILE = mangleField(STE, "fileName"), STE_LINE = mangleField(STE, "lineNumber");
/** ART starts a throwable's trace below the frames of its own class hierarchy (its constructors) */
function throwableTrace(t: JThrowable): unknown[] {
  const frames = javaFrames(t.jsStack, t.coldFrames), own = new Set<string>();
  for (let info: ClassInfo | null | undefined = (t.constructor as { $i?: ClassInfo }).$i; info; info = info.superInfo) own.add(info.name);
  let skip = 0;
  while (skip < frames.length && own.has(frames[skip][0])) skip++;
  return stackTrace(frames.slice(skip));
}
const framesHere = () => javaFrames(jsStackHere().stack, coldStack);
rt.javaFrames = () => framesHere().map(([cls, method]) => dotName(cls) + "." + method);
/** Thread.getStackTrace: ART's trace names the natives that took it */
const VM_STACK: JavaFrame = ["dalvik/system/VMStack", "getThreadStackTrace", null];
/** the running thread's frames as its traces report them, without looking up their lines */
const threadFrames = (): JavaFrame[] => framesHere().map(([cls, method]) => [cls, method, null]);
export function threadTrace(): unknown[] { return stackTrace([VM_STACK, ["java/lang/Thread", "getStackTrace", null], ...threadFrames()]); }
/** VMStack.getStackClassN: the class `n` frames out from the native's caller */
const stackClass = (n: number) => { const frame = framesHere()[n]; return frame ? rt.classFor(frame[0]) : null; };
rt.register({ name: "dalvik/system/VMStack", ctor: class extends JObj {}, methods: {
  "static getStackClass1()Ljava/lang/Class;": () => stackClass(1),
  "static getStackClass2()Ljava/lang/Class;": () => stackClass(2),
  // the defining loader of the innermost frame whose class is not the platform's
  "static getClosestUserClassLoader()Ljava/lang/ClassLoader;": () => {
    for (const [cls] of framesHere()) if (!rt.platformClasses.has(cls) && !rt.natives.has(cls)) return (rt.link(cls).owner ?? rt).classLoader ?? null;
    return null;
  },
  // another cooperative thread's frames are not on the JS stack: none, as for a thread not running
  "static getThreadStackTrace(Ljava/lang/Thread;)[Ljava/lang/StackTraceElement;": (t: JThread | null) =>
    stackTrace(t === curThread ? [VM_STACK, ...threadFrames()] : []),
} });

const printStackTraceTo = driven(function* (this: JThrowable, out: unknown): Gen {
  yield vcall(out, "println", "(Ljava/lang/String;)V", yield* awaited(stackTraceText(this)));
});
/** JVM-shaped stack trace text: header from the (overridable) toString, then the trace's frames. */
export const stackTraceText = driven(function* (t: JThrowable): Gen<string> {
  function* described(c: JThrowable): Gen<string> {
    let text = String(yield vcall(c, "toString", "()Ljava/lang/String;"));
    for (const e of c.trace ??= throwableTrace(c)) text += "\n\tat " + (yield vcall(e, "toString", "()Ljava/lang/String;"));
    return text;
  }
  let out = yield* described(t);
  const seen = new Set<JThrowable>([t]);
  for (let c = yield* awaited(causeOf(t)); c && !seen.has(c); c = yield* awaited(causeOf(c))) {
    seen.add(c);
    out += "\nCaused by: " + (yield* described(c));
  }
  return out;
});
/** Throwable.getCause, which libcore's InvocationTargetException, UndeclaredThrowableException and
 *  PrivilegedActionException answer from their own fields */
const causeOf = (t: JThrowable): JThrowable | null | Promise<JThrowable | null> => vcall(t, "getCause", "()Ljava/lang/Throwable;");
const M_fillInStackTrace = mangleMethod("fillInStackTrace", "()Ljava/lang/Throwable;");
/** Throwable's constructors fill the trace through the virtual method: subclasses that override
 *  it to skip the capture (coroutine and Compose cancellations) never pay for a JS stack. */
export function fillInStackTrace(t: JThrowable): void { (t as unknown as Record<string, () => unknown>)[M_fillInStackTrace](); }
const throwableConstructors: NonNullable<NativeSpec["methods"]> = {
  "<init>()V": function (this: JThrowable) { fillInStackTrace(this); },
  "<init>(Ljava/lang/String;)V": function (this: JThrowable, m: string) { this.msg = m; fillInStackTrace(this); },
  "<init>(Ljava/lang/String;Ljava/lang/Throwable;)V": function (this: JThrowable, m: string, c: JThrowable) { this.msg = m; this.cause = c; fillInStackTrace(this); },
  "<init>(Ljava/lang/Throwable;)V": function (this: JThrowable, c: JThrowable) {
    this.cause = c;
    fillInStackTrace(this);
    if (c) return after(vcall(c, "toString", "()Ljava/lang/String;"), (m: string) => { this.msg = m; });
  },
  "<init>(Ljava/lang/String;Ljava/lang/Throwable;ZZ)V": function (this: JThrowable, m: string, c: JThrowable, _suppression: number, writable: number) {
    this.msg = m; this.cause = c;
    if (writable) fillInStackTrace(this);
  },
};
rt.register({
  name: "java/lang/Throwable",
  ctor: JThrowable,
  ifaces: ["java/io/Serializable"],
  methods: {
    ...throwableConstructors,
    "getMessage()Ljava/lang/String;": function (this: JThrowable) { return this.msg; },
    "getLocalizedMessage()Ljava/lang/String;": function (this: JThrowable) { return vcall(this, "getMessage", "()Ljava/lang/String;"); },
    "getCause()Ljava/lang/Throwable;": function (this: JThrowable) { return this.cause; },
    "initCause(Ljava/lang/Throwable;)Ljava/lang/Throwable;": function (this: JThrowable, c: JThrowable) { this.cause = c; return this; },
    "toString()Ljava/lang/String;": function (this: JThrowable) {
      const n = dotName(jclsName(this));
      return after(vcall(this, "getLocalizedMessage", "()Ljava/lang/String;"), (m: string | null) => (m !== null ? n + ": " + m : n));
    },
    "printStackTrace()V": function (this: JThrowable) {
      console.warn("[java] " + jclsName(this) + ": " + this.msg, this.jsStack, this.cause ? "caused by " + jclsName(this.cause) + ": " + this.cause.msg : "");
    },
    // apps route caught exceptions through these (logcat/Timber's Throwable.asLog())
    "printStackTrace(Ljava/io/PrintWriter;)V": printStackTraceTo,
    "printStackTrace(Ljava/io/PrintStream;)V": printStackTraceTo,
    "fillInStackTrace()Ljava/lang/Throwable;": function (this: JThrowable) { captureStack(this); return this; },
    "getStackTrace()[Ljava/lang/StackTraceElement;": function (this: JThrowable) { return this.trace ??= throwableTrace(this); },
    "setStackTrace([Ljava/lang/StackTraceElement;)V": function (this: JThrowable, t: unknown[]) { this.trace = t ?? null; },
    "addSuppressed(Ljava/lang/Throwable;)V": function (this: JThrowable, t: JThrowable) { this.suppressed.push(t); },
    "getSuppressed()[Ljava/lang/Throwable;": function (this: JThrowable) { return jarray(this.suppressed.slice(), "Ljava/lang/Throwable;"); },
  },
});

/** log a throwable no Java handler takes and tell the development shell */
export function logUncaught(e: unknown): void {
  const je = rt.jx(e);
  // the cause chain travels with the throwable and is usually where the real failure is named
  let causes = "";
  const next = (t: JThrowable) => { const c = callOn(mainThread, () => causeOf(t)); return c instanceof Promise ? null : c; };
  for (let c = je && next(je), depth = 0; c && depth < 8; c = next(c), depth++) {
    causes += `\n  caused by ${(c.constructor as any)?.$i?.name ?? "?"}: ${c.msg ?? ""}`;
  }
  const jframes = (je as { jframes?: string[] } | null)?.jframes;
  console.error("[uncaught]", (je?.constructor as any)?.$i?.name ?? "?", (je?.msg ?? "") + causes + (jframes ? "\n  at " + jframes.join("\n  at ") : ""), (je as any)?.jsStack ?? (e as any)?.stack ?? "");
  rt.onUncaught(je);
}

/** a throwable made without running its constructors: `cls` linked, its message set, its trace
 *  taken here (a class that is not a throwable, or cannot link, makes a plain Throwable) */
rt.mkThrowable = (cls: string, msg: string | null) => {
  let ctor: new () => JThrowable = JThrowable;
  try {
    const info = rt.link(cls);
    if (info.ctor.prototype instanceof JThrowable) { rt.ensureCompiled(info); ctor = info.ctor; }
  } catch { /* fall through */ }
  const e = new ctor();
  e.msg = msg;
  captureStack(e);
  return e;
};

/** what becomes of an exception no Java frame waits for */
export type Escape = (e: unknown) => void;
/** it escapes `thread`, which dispatches it to its uncaught handler */
export const toThread = (thread: JThread = curThread): Escape => (e) => void dispatchUncaught(thread, e);
/** A call no Java frame waits on (a listener, a posted task), as a chain of its own: its exception,
 *  thrown now or when it resumes, goes to `escape` rather than to the native that made the call.
 *  system_server's work escapes to logUncaught: there its default handler would end system_server
 *  and the runtime restart it, which this page cannot do under the apps it hosts. */
export function detached(call: () => unknown, escape: Escape = toThread()): void {
  if (processExited()) return;
  try { const r = inStrand(newStrand(), call); if (r instanceof Promise) r.catch(escape); } catch (e) { escape(e); }
}
/** ART's Thread::HandleUncaughtExceptions: Thread.dispatchUncaughtException on the thread, whose
 *  own exception is cleared. A JS error is the Java throwable its frames would have seen. */
export async function dispatchUncaught(t: JThread, e: unknown): Promise<void> {
  if (processExited()) return;
  // the development report, with the JS stack that locates a throwable a native raised
  const je = rt.jx(e);
  logUncaught(je);
  try { await vcallOn(t, t, "dispatchUncaughtException", "(Ljava/lang/Throwable;)V", je); }
  catch (inner) { console.error("[thread " + t.jname + "] uncaught exception handler threw"); logUncaught(inner); }
}
