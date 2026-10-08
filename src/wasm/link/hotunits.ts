export interface HotUnit {
  generation: number;
  slots: number[];
  functions: WeakRef<Function>[];
  sites: Set<string>;
  ready: Set<string>;
}

/** Only hot units still using symbolic adapters need dependency metadata. */
export class HotUnits {
  private generation = 0;
  private slots = new Map<number, HotUnit>();
  private sites = new Map<string, Set<HotUnit>>();
  private dirty = new Set<HotUnit>();

  get(slot: number): HotUnit | undefined { return this.slots.get(slot); }
  hasPending(): boolean { return this.dirty.size !== 0; }
  pending(): Iterable<HotUnit> { return this.dirty; }
  live(unit: HotUnit, table: WebAssembly.Table): boolean {
    return unit.slots.every((slot, i) => this.slots.get(slot) === unit && table.get(slot) === unit.functions[i].deref());
  }
  forget(slot: number): void {
    const unit = this.slots.get(slot);
    if (!unit) return;
    this.dirty.delete(unit);
    for (const at of unit.slots) if (this.slots.get(at) === unit) this.slots.delete(at);
    for (const name of unit.sites) {
      const owners = this.sites.get(name)!;
      owners.delete(unit);
      if (!owners.size) this.sites.delete(name);
    }
  }
  publish(slots: number[], names: Iterable<string>, table: WebAssembly.Table): HotUnit | undefined {
    slots.forEach(slot => this.forget(slot));
    const sites = new Set(names);
    if (!sites.size) return;
    const unit: HotUnit = { generation: ++this.generation, slots: [...slots],
      functions: slots.map(slot => new WeakRef(table.get(slot) as Function)), sites, ready: new Set() };
    slots.forEach(slot => this.slots.set(slot, unit));
    for (const name of sites) {
      const owners = this.sites.get(name) ?? this.sites.set(name, new Set()).get(name)!;
      owners.add(unit);
    }
    return unit;
  }
  resolved(name: string): void {
    for (const unit of this.sites.get(name) ?? []) {
      unit.ready.add(name);
      this.dirty.add(unit);
    }
  }
}
