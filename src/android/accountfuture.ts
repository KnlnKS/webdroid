import { JObj, rt, maySuspend } from "../jvm/runtime";
import { curThread, mainThread, park, vcall, type JThread } from "../jvm/natives/jlang";
import { JFnRunnable, mainHandler, type JHandler } from "./os";

type Outcome = { kind: "pending" } | { kind: "result"; value: unknown } | { kind: "error"; error: unknown } | { kind: "canceled" };
export class JAccountFuture extends JObj {
  outcome: Outcome = { kind: "pending" };
  callback: unknown = null;
  handler: JHandler | null = null;
  cleanup = () => {};
  private waiters = new Set<() => void>();
  get pending(): boolean { return this.outcome.kind === "pending"; }
  finish(outcome: Exclude<Outcome, { kind: "pending" }>): number {
    if (!this.pending) return 0;
    this.outcome = outcome; this.cleanup(); this.cleanup = () => {};
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    if (this.callback) {
      rt.link("webdroid/FnRunnable");
      const run = new JFnRunnable(); run.fn = () => vcall(this.callback, "run", "(Landroid/accounts/AccountManagerFuture;)V", this);
      (this.handler ?? mainHandler()).post(run, 0);
    }
    return 1;
  }
  done(): Promise<void> { return this.pending ? new Promise(resolve => this.waiters.add(resolve)) : Promise.resolve(); }
  async result(ms?: number, thread: JThread = curThread): Promise<unknown> {
    if (this.pending && thread === mainThread) throw rt.mkThrowable("java/lang/IllegalStateException", "AccountManagerFuture cannot block the main thread");
    if (this.pending) {
      try {
        if (ms !== undefined && ms <= 0 || !await park(thread, wake => { this.waiters.add(wake); return () => { this.waiters.delete(wake); }; }, ms)) this.finish({ kind: "canceled" });
      } catch (error) {
        if (!rt.iof(error, "java/lang/InterruptedException")) throw error;
        this.finish({ kind: "canceled" });
      }
    }
    const outcome = this.outcome;
    if (outcome.kind === "result") return outcome.value;
    if (outcome.kind === "error") throw outcome.error;
    throw rt.mkThrowable("android/accounts/OperationCanceledException", "Account request canceled");
  }
}
export function accountFuture(callback: unknown, handler: JHandler | null, value?: unknown): JAccountFuture {
  rt.link("webdroid/AccountFuture");
  const future = new JAccountFuture(); future.callback = callback; future.handler = handler;
  if (arguments.length === 3) future.finish({ kind: "result", value });
  return future;
}
rt.register({ name: "webdroid/AccountFuture", ctor: JAccountFuture, ifaces: ["android/accounts/AccountManagerFuture"], methods: {
  "getResult()Ljava/lang/Object;": async function (this: JAccountFuture) { return this.result(); },
  "getResult(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": async function (this: JAccountFuture, timeout: bigint, unit: unknown) {
    if (this.pending && curThread === mainThread) throw rt.mkThrowable("java/lang/IllegalStateException", "AccountManagerFuture cannot block the main thread");
    const thread = curThread;
    return this.result(Number(await vcall(unit, "toMillis", "(J)J", timeout)), thread);
  },
  "isDone()Z": function (this: JAccountFuture) { return +!this.pending; },
  "isCancelled()Z": function (this: JAccountFuture) { return +(this.outcome.kind === "canceled"); },
  "cancel(Z)Z": maySuspend(function (this: JAccountFuture) { return this.finish({ kind: "canceled" }); }),
} });
