import type { IntentData } from "../android/intentipc";

export type PendingOperation = {
  pkg: string; process: string; uid: number; kind: "activity" | "broadcast" | "service";
  code: number; flags: number; intent: IntentData; preceding: IntentData[];
};
type Record = { key: string; operation: PendingOperation; cancellations: Set<() => void> };
export class PendingIntents {
  private records = new Map<number, Record>();
  private keys = new Map<string, number>();
  private nextId = 1;
  constructor(private dispatch: (operation: PendingOperation, fill: IntentData | null, alarmCount: number) => Promise<void>) {}
  create(operation: PendingOperation): number | null {
    const { pkg, uid, kind, code, intent } = operation, flags = operation.flags & ~0x38000000;
    const key = JSON.stringify([pkg, uid, kind, code, flags, intent.action, intent.dataUri, intent.typeStr, intent.identifier,
      intent.pkg, intent.componentPkg, intent.component, [...intent.categories].sort()]);
    let id = this.keys.get(key);
    if (id !== undefined && operation.flags & 0x10000000) { this.cancel(id); id = undefined; }
    if (id !== undefined) {
      if (operation.flags & 0x8000000) this.records.get(id)!.operation.intent.extras = structuredClone(intent.extras);
      return id;
    }
    if (operation.flags & 0x20000000) return null;
    id = this.nextId++;
    this.records.set(id, { key, operation: structuredClone({ ...operation, flags }), cancellations: new Set() });
    this.keys.set(key, id); return id;
  }
  known(id: number): boolean { return Number.isInteger(id) && id > 0 && id < this.nextId; }
  get(id: number): PendingOperation | null { return this.records.get(id)?.operation ?? null; }
  cancel(id: number): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id); this.keys.delete(record.key);
    for (const notify of record.cancellations) notify();
    record.cancellations.clear();
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
  async send(id: number, fill: IntentData | null = null, alarmCount = 0): Promise<boolean> {
    const operation = this.take(id);
    if (!operation) return false;
    await this.dispatch(structuredClone(operation), fill, alarmCount); return true;
  }
}
