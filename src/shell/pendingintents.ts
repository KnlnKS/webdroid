import type { ParcelData } from "../android/binder.ts";

export type PendingOperation = {
  pkg: string; process: string; uid: number; kind: "activity" | "broadcast" | "service" | "foreground-service";
  code: number; flags: number; intent: ParcelData; intents?: ParcelData[];
};
/** what the registry asks of the intents it holds: AOSP's Intent.filterEquals, and replaceExtras
 *  for FLAG_UPDATE_CURRENT, run where a JVM can read them */
export type IntentCodec = {
  filterEquals: (a: ParcelData, b: ParcelData) => Promise<boolean>;
  replaceExtras: (target: ParcelData, source: ParcelData) => Promise<ParcelData>;
};
type Record = { key: string; operation: PendingOperation; cancellations: Set<() => void> };
/** PendingIntentController's records, keyed as PendingIntentRecord.Key: creator, kind, request code,
 *  flags and an intent equal under filterEquals */
export class PendingIntents {
  private codec: IntentCodec; private dispatch: (operation: PendingOperation, fill: ParcelData | null, alarmCount: number) => void | Promise<void>;
  private records = new Map<number, Record>();
  private nextId = 1;
  constructor(codec: IntentCodec, dispatch: (operation: PendingOperation, fill: ParcelData | null, alarmCount: number) => void | Promise<void>) { this.codec = codec; this.dispatch = dispatch; }
  private async find(key: string, intent: ParcelData, codec: IntentCodec): Promise<number | undefined> {
    for (const [id, record] of this.records) if (record.key === key && await codec.filterEquals(record.operation.intent, intent)) return id;
    return undefined;
  }
  private creating: Promise<unknown> = Promise.resolve();
  /** one at a time, so two equal requests find one record; `codec` runs where the creator's JVM can */
  create(operation: PendingOperation, codec = this.codec): Promise<number | null> {
    const created = this.creating.then(() => this.create0(operation, codec));
    this.creating = created.catch(() => {});
    return created;
  }
  private async create0(operation: PendingOperation, codec: IntentCodec): Promise<number | null> {
    const { pkg, uid, kind, code, intent } = operation, flags = operation.flags & ~0x38000000;
    const key = JSON.stringify([pkg, uid, kind, code, flags]);
    let id = await this.find(key, intent, codec);
    if (id !== undefined && operation.flags & 0x10000000) { this.cancel(id); id = undefined; }
    if (id !== undefined) {
      const current = this.records.get(id)?.operation;
      if (current && operation.flags & 0x8000000) {
        current.intent = await codec.replaceExtras(current.intent, intent);
        current.intents = operation.intents && structuredClone(operation.intents);
      }
      return id;
    }
    if (operation.flags & 0x20000000) return null;
    id = this.nextId++;
    this.records.set(id, { key, operation: { ...operation, flags, intent: structuredClone(intent), intents: operation.intents && structuredClone(operation.intents) }, cancellations: new Set() });
    return id;
  }
  known(id: number): boolean { return Number.isInteger(id) && id > 0 && id < this.nextId; }
  get(id: number): PendingOperation | null { return this.records.get(id)?.operation ?? null; }
  cancel(id: number): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    for (const notify of record.cancellations) notify();
    record.cancellations.clear();
  }
  /** a removed package's senders */
  remove(pkg: string): void {
    for (const [id, record] of [...this.records]) if (record.operation.pkg === pkg) this.cancel(id);
  }
  watch(id: number, canceled: () => void): (() => void) | null {
    const record = this.records.get(id);
    if (!record) return null;
    record.cancellations.add(canceled); return () => { record.cancellations.delete(canceled); };
  }
  /** the operation a send runs; a one-shot sender is consumed by being taken */
  take(id: number): PendingOperation | null {
    const operation = this.get(id);
    if (operation && operation.flags & 0x40000000) this.cancel(id);
    return operation;
  }
  async send(id: number, fill: ParcelData | null = null, alarmCount = 0): Promise<boolean> {
    const operation = this.take(id);
    if (!operation) return false;
    await this.dispatch({ ...operation, intent: structuredClone(operation.intent), intents: operation.intents && structuredClone(operation.intents) }, fill, alarmCount); return true;
  }
}
