import { T, sleb, uleb, vt, type VT, type FuncBytes, functionIndex } from "./wasmbin.ts";
/** instruction emitter for one function body */
export class Code {
  nparams: number;
  b: FuncBytes = [];
  /** locals declared beyond params: type per local index offset */
  localTypes: VT[] = [];
  /** DEX pc of the instruction being emitted; calls and throws record (byte offset, pc) so a Wasm frame offset maps back to a pc */
  pc = -1;
  marks: number[] = [];
  /** length of the local declarations finish() prepends */
  prefixLen = 0;
  constructor(nparams: number) { this.nparams = nparams; }
  private scratchI32 = -1;
  /** an i32 local for values that live within one expression */
  scratch(): number { return this.scratchI32 < 0 ? (this.scratchI32 = this.newLocal(T.i32)) : this.scratchI32; }
  locals = new Set<number>();
  compactLocals = false;
  localMap = new Map<number, number>();
  private materializing = false;
  /** Snapshotting includes dead reference temporaries; live reads still require their original non-null type. */
  nullableLocals = false;
  nonNullLocals = new Set<number>();
  newLocal(t: VT): number {
    const i = this.nparams + this.localTypes.length;
    if (this.nullableLocals && typeof t !== "number" && !t.nullable) { this.nonNullLocals.add(i); t = { ...t, nullable: true }; }
    this.localTypes.push(t); return i;
  }
  raw(...x: number[]): this { for (const v of x) this.b.push(v); return this; }
  u(n: number): this { uleb(n, this.b); return this; }
  s(n: number | bigint): this { sleb(n, this.b); return this; }
  i32(n: number): this { this.b.push(0x41); sleb(n | 0, this.b); return this; }
  /** an i32.const of a value patched in later (patch): its LEB128 takes five bytes whatever the value */
  i32Patched(): number { this.b.push(0x41); const at = this.b.length; this.b.push(0x80, 0x80, 0x80, 0x80, 0x00); return at; }
  patch(at: number, n: number): void { for (let i = 0; i < 4; i++) this.b[at + i] = ((n >>> (7 * i)) & 0x7f) | 0x80; this.b[at + 4] = (n >>> 28) & 0x7f; }
  i64(n: bigint): this { this.b.push(0x42); sleb(BigInt.asIntN(64, n), this.b); return this; }
  f32const(bits: number): this { this.b.push(0x43); for (let i = 0; i < 4; i++) this.b.push((bits >>> (8 * i)) & 255); return this; }
  f64const(bits: bigint): this { this.b.push(0x44); for (let i = 0n; i < 8n; i++) this.b.push(Number((bits >> (8n * i)) & 255n)); return this; }
  private local(op: number, i: number, nonNull: boolean): this {
    if (this.nullableLocals) this.locals.add(i);
    if (this.compactLocals && !this.materializing) { this.defer((c) => { c.local(op, i, nonNull); }); return this; }
    const index = this.compactLocals ? this.localMap.get(i) : i;
    if (index === undefined) throw new Error(`Unmapped outlined local ${i}`);
    this.b.push(op); uleb(index, this.b);
    if (nonNull && this.nonNullLocals.has(i)) this.refAsNonNull();
    return this;
  }
  lget(i: number, nonNull = true): this { return this.local(0x20, i, nonNull); }
  lset(i: number): this { return this.local(0x21, i, false); }
  ltee(i: number): this { return this.local(0x22, i, true); }
  gget(i: number): this { this.b.push(0x23); uleb(i, this.b); return this; }
  gset(i: number): this { this.b.push(0x24); uleb(i, this.b); return this; }
  private mark(): void { if (this.pc >= 0) this.marks.push(this.b.length, this.pc); }
  /** the functions called directly, and the number of calls through a table or a reference: what a body may run besides its own instructions */
  targets: number[] = [];
  indirect = 0;
  call(f: number): this { this.mark(); this.targets.push(f); this.b.push(0x10); functionIndex(f, this.b); return this; }
  callIndirect(type: number, table = 0): this { this.mark(); this.indirect++; this.b.push(0x11); uleb(type, this.b); uleb(table, this.b); return this; }
  callRef(type: number): this { this.indirect++; this.b.push(0x14); uleb(type, this.b); return this; }
  block(bt: number | VT | null = null): this { this.b.push(0x02); this.bt(bt); return this; }
  loop(bt: number | VT | null = null): this { this.b.push(0x03); this.bt(bt); return this; }
  if_(bt: number | VT | null = null): this { this.b.push(0x04); this.bt(bt); return this; }
  /** an if whose block type is the function type `type`: it takes that type's parameters from the stack under the condition */
  ifType(type: number): this { this.b.push(0x04); sleb(type, this.b); return this; }
  else_(): this { this.b.push(0x05); return this; }
  end(): this { this.b.push(0x0b); return this; }
  br(d: number): this { this.b.push(0x0c); uleb(d, this.b); return this; }
  brIf(d: number): this { this.b.push(0x0d); uleb(d, this.b); return this; }
  brTable(targets: number[], dflt: number): this { this.b.push(0x0e); uleb(targets.length, this.b); for (const t of targets) uleb(t, this.b); uleb(dflt, this.b); return this; }
  ret(): this { this.b.push(0x0f); return this; }
  unreachable(): this { this.b.push(0x00); return this; }
  drop(): this { this.b.push(0x1a); return this; }
  select(): this { this.b.push(0x1b); return this; }
  throw_(tag: number): this { this.mark(); this.b.push(0x08); uleb(tag, this.b); return this; }
  throwRef(): this { this.b.push(0x0a); return this; }
  /** try_table with catch clauses [kind, tag, label] ; kind 0 catch,1 catch_ref,2 catch_all,3 catch_all_ref */
  tryTable(bt: number | VT | null, catches: [number, number, number][]): this { this.b.push(0x1f); this.bt(bt); return this.catches(catches); }
  /** a block, and a try_table, whose type is the function type index `type` (the operands it takes and the results it leaves) */
  blockType(type: number): this { this.b.push(0x02); sleb(type, this.b); return this; }
  tryTableType(type: number, catches: [number, number, number][]): this { this.b.push(0x1f); sleb(type, this.b); return this.catches(catches); }
  private catches(catches: [number, number, number][]): this {
    uleb(catches.length, this.b);
    for (const [k, tag, lab] of catches) { this.b.push(k); if (k < 2) uleb(tag, this.b); uleb(lab, this.b); }
    return this;
  }
  private bt(t: number | VT | null): void {
    if (t === null) this.b.push(0x40);
    else if (typeof t === "number" && t >= 0x60 && t <= 0x7f) this.b.push(t);                 // value type byte
    else if (typeof t === "number") sleb(t, this.b);                                           // type index
    else vt(t, this.b);
  }
  refNull(ht: number): this { this.b.push(0xd0); sleb(ht, this.b); return this; }
  /** ref.null any: the null of every Java reference slot */
  anyNull(): this { this.b.push(0xd0, 0x6e); return this; }
  tableGet(t: number): this { this.b.push(0x25); uleb(t, this.b); return this; }
  /** a JS value (a string) into a reference slot; externConvertAny is the way back */
  anyConvertExtern(): this { return this.gc(0x1a); }
  /** a linear-memory access: opcode, log2 alignment, offset */
  mem(op: number, align: number, offset = 0): this { this.b.push(op); uleb(align, this.b); uleb(offset, this.b); return this; }
  memorySize(): this { this.b.push(0x3f, 0); return this; }
  memoryGrow(): this { this.b.push(0x40, 0); return this; }
  refIsNull(): this { this.b.push(0xd1); return this; }
  refEq(): this { this.b.push(0xd3); return this; }
  refAsNonNull(): this { this.b.push(0xd4); return this; }
  refFunc(f: number): this { this.b.push(0xd2); functionIndex(f, this.b); return this; }
  gc(sub: number, ...imm: number[]): this { this.b.push(0xfb); uleb(sub, this.b); for (const i of imm) uleb(i, this.b); return this; }
  structNew(t: number): this { return this.gc(0, t); }
  structGet(t: number, f: number): this { return this.gc(2, t, f); }
  structSet(t: number, f: number): this { return this.gc(5, t, f); }
  arrayNewDefault(t: number): this { return this.gc(7, t); }
  arrayNewFixed(t: number, n: number): this { return this.gc(8, t, n); }
  arrayNewData(t: number, d: number): this { return this.gc(9, t, d); }
  arrayGet(t: number): this { return this.gc(11, t); }
  arrayGetS(t: number): this { return this.gc(12, t); }
  arrayGetU(t: number): this { return this.gc(13, t); }
  arraySet(t: number): this { return this.gc(14, t); }
  arrayLen(): this { return this.gc(15); }
  arrayCopy(dst: number, src: number): this { return this.gc(17, dst, src); }
  refTest(ht: number, nullable = false): this { this.b.push(0xfb); uleb(nullable ? 21 : 20, this.b); sleb(ht, this.b); return this; }
  refCast(ht: number, nullable = false): this { this.b.push(0xfb); uleb(nullable ? 23 : 22, this.b); sleb(ht, this.b); return this; }
  externConvertAny(): this { return this.gc(27); }
  satTrunc(k: number): this { this.b.push(0xfc); uleb(k, this.b); return this; }
  private deferred: { at: number; emit: (c: Code) => void }[] = [];
  /** Insert code once the enclosing method's complete local layout is known. */
  defer(emit: (c: Code) => void): void { this.deferred.push({ at: this.b.length, emit }); }
  materialize(): void {
    if (!this.deferred.length) return;
    this.materializing = true;
    const old = this.b, marks = this.marks, refs = old.functionRefs ?? [];
    this.b = []; this.b.functionRefs = []; this.marks = [];
    let from = 0, mi = 0, ri = 0;
    for (const { at, emit } of this.deferred) {
      const offset = this.b.length - from;
      while (ri < refs.length && refs[ri] < at) this.b.functionRefs.push(refs[ri++] + offset);
      while (mi < marks.length && marks[mi] < at) { this.marks.push(marks[mi] + offset, marks[mi + 1]); mi += 2; }
      for (let i = from; i < at; i++) this.b.push(old[i]);
      emit(this); from = at;
    }
    const offset = this.b.length - from;
    while (ri < refs.length) this.b.functionRefs.push(refs[ri++] + offset);
    while (mi < marks.length) { this.marks.push(marks[mi] + offset, marks[mi + 1]); mi += 2; }
    for (let i = from; i < old.length; i++) this.b.push(old[i]);
    this.deferred = [];
    this.materializing = false;
  }
  finish(): FuncBytes {
    this.materialize();
    // locals: run-length encode consecutive identical types
    const prefix: number[] = [], types = this.localTypes, same = (a: VT, b: VT) => a === b || typeof a !== "number" && typeof b !== "number" && a.ht === b.ht && a.nullable === b.nullable;
    let groups = 0;
    for (let i = 0; i < types.length; i++) if (!i || !same(types[i], types[i - 1])) groups++;
    uleb(groups, prefix);
    for (let i = 0, j; i < types.length; i = j) {
      for (j = i + 1; j < types.length && same(types[j], types[i]); j++);
      uleb(j - i, prefix); vt(types[i], prefix);
    }
    this.prefixLen = prefix.length;
    const out: FuncBytes = prefix, b = this.b;
    for (let i = 0; i < b.length; i++) out.push(b[i]);
    out.push(0x0b);
    out.functionRefs = (this.b.functionRefs ?? []).map(at => at + this.prefixLen);
    return out;
  }
}
export const OP = {
  i32_load: 0x28, i64_load: 0x29, i32_load8_u: 0x2d, i32_load16_u: 0x2f, i32_store: 0x36, i64_store: 0x37, i32_store8: 0x3a, i32_store16: 0x3b,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49, i32_gt_s: 0x4a, i32_gt_u: 0x4b, i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
  i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54, i64_gt_s: 0x55, i64_gt_u: 0x56, i64_le_s: 0x57, i64_ge_s: 0x59,
  f32_eq: 0x5b, f32_ne: 0x5c, f32_lt: 0x5d, f32_gt: 0x5e, f32_le: 0x5f, f32_ge: 0x60, f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_rem_s: 0x6f, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
  i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_rem_s: 0x81, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
  f32_neg: 0x8c, f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94, f32_div: 0x95, f64_neg: 0x9a, f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3,
  i32_wrap_i64: 0xa7, i64_extend_i32_s: 0xac, i64_extend_i32_u: 0xad,
  f32_convert_i32_s: 0xb2, f32_convert_i64_s: 0xb4, f32_demote_f64: 0xb6, f64_convert_i32_s: 0xb7, f64_convert_i64_s: 0xb9, f64_promote_f32: 0xbb,
  i32_reinterpret_f32: 0xbc, i64_reinterpret_f64: 0xbd, f32_reinterpret_i32: 0xbe, f64_reinterpret_i64: 0xbf, i32_extend8_s: 0xc0, i32_extend16_s: 0xc1,
} as const;
