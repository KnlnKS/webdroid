// A throwable no Java frame catches: one escaping a thread, or a call no Java frame waits on
// (detached, with an Escape policy).

import { rt, JObj } from "../runtime.ts";
import { Strand } from "../suspend.ts";
import { processExited } from "../../process-exit.ts";
import { callOn, classNameOf, curThread, javaRuns, mainThread, vcall, vcallOn, type JThread } from "./jentry.ts";

/** what host code holds of a Java throwable: a TS native's (wasm/host/entry.ts hostThrowable), or a facade over Java's (bridge.ts) */
export class JThrowable extends JObj {
  msg: string | null = null;
}

/** Throwable.getCause, which libcore's InvocationTargetException, UndeclaredThrowableException and
 *  PrivilegedActionException answer from their own fields */
const causeOf = (t: JThrowable): JThrowable | null | Promise<JThrowable | null> => vcall(t, "getCause", "()Ljava/lang/Throwable;");

/** a store or cross-process transport used before the broker connects it */
export function unconnected(): never { throw rt.mkThrowable("android/os/RemoteException", "Process transport unavailable"); }
export const notConnected = async (): Promise<never> => unconnected();
/** log a throwable no Java handler takes and tell the development shell */
export function logUncaught(e: unknown): void {
  const je = rt.jx(e), java = javaRuns();
  // the cause chain travels with the throwable and is usually where the real failure is named
  let causes = "";
  const next = (t: JThrowable) => { const c = callOn(mainThread, () => causeOf(t)); return c instanceof Promise ? null : c; };
  for (let c = java && je && next(je), depth = 0; c && depth < 8; c = next(c), depth++) causes += `\n  caused by ${classNameOf(c) ?? "?"}: ${c.msg ?? ""}`;
  const jframes = (je as { jframes?: string[] } | null)?.jframes;
  console.error("[uncaught]", (java && classNameOf(je)) || "?", (je?.msg ?? "") + causes + (jframes ? "\n  at " + jframes.join("\n  at ") : ""), (e as Error | null)?.stack ?? "");
  rt.onUncaught(je);
}

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
  try { const r = rt.within(new Strand(curThread), call); if (r instanceof Promise) r.catch(escape); } catch (e) { escape(e); }
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
