// ClipboardService's part the broker plays across processes: one primary clip, kept with the
// descriptor rights it carries, which the foreground app's uid may read, and the processes that
// listen for its changes. One queue orders its changes and reads.
import type { ParcelData } from "../android/binder.ts";
import { rt } from "../jvm/runtime.ts";
import type { FileDescriptors } from "./file-descriptors.ts";
import { StoredParcel, StoredParcelError } from "./stored-parcel.ts";

export type ClipboardCalls = {
  clipboardSet: (data: ParcelData | null) => Promise<void>;
  clipboardGet: () => Promise<ParcelData | null>;
  clipboardHas: () => Promise<boolean>;
  clipboardListen: (active: boolean) => Promise<void>;
};
/** the broker's processes: `uid` throws for a dead one; `changed` tells a listener of a new clip */
export type ClipboardPort = { uid(pid: number): number; foregroundUid(): number | undefined; changed(pid: number): void };

export class Clipboard {
  private clip: StoredParcel | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<number>();
  private descriptors: FileDescriptors; private port: ClipboardPort;
  constructor(descriptors: FileDescriptors, port: ClipboardPort) { this.descriptors = descriptors; this.port = port; }

  /** the calls of process `pid`, as its ClipboardManager makes them */
  calls(pid: number): ClipboardCalls {
    return {
      clipboardSet: data => this.set(pid, data && structuredClone(data)),
      clipboardGet: () => this.work(async () => this.readable(pid) ? this.clip!.replay(pid) : null),
      clipboardHas: () => this.work(async () => this.readable(pid)),
      clipboardListen: async active => {
        this.port.uid(pid);
        if (active) this.listeners.add(pid); else this.listeners.delete(pid);
      },
    };
  }
  /** a process ended: it listens no longer */
  forget(pid: number): void { this.listeners.delete(pid); }

  private set(pid: number, data: ParcelData | null): Promise<void> {
    return this.work(async () => {
      this.port.uid(pid);
      let next: StoredParcel | null = null;
      try { next = data && await StoredParcel.retain(this.descriptors, pid, data); }
      catch (error) {
        if (error instanceof StoredParcelError) throw rt.mkThrowable("android/os/BadParcelableException", error.message);
        throw error;
      }
      try { this.port.uid(pid); } catch (error) { await next?.close(); throw error; }
      const previous = this.clip;
      this.clip = next;
      await previous?.close();
      for (const listener of this.listeners) this.port.changed(listener);
    });
  }
  private readable(pid: number): boolean { return this.port.uid(pid) === this.port.foregroundUid() && this.clip !== null; }
  private work<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(run);
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }
}
