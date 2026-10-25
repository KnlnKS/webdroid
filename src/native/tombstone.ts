// debuggerd's tombstone as a protobuf (system/core/debuggerd/proto/tombstone.proto): what
// ApplicationExitInfo.getTraceInputStream hands a crash reporter for REASON_CRASH_NATIVE. Only the
// crashing thread is unwound, by its frame-pointer chain.

export type TombstoneFrame = { pc: number; relPc: number; file: string; fn: string; fnOffset: number };
type TombstoneData = {
  a64: boolean; fingerprint: string; timestamp: number; pid: number; tid: number; uid: number; command: string; uptimeS: number;
  signal: number; signalName: string; code: number; codeName: string; faultAddress: bigint | null; abort: string;
  threadName: string; registers: [string, bigint][]; frames: TombstoneFrame[];
};

class Writer {
  private bytes: number[] = [];
  varint(field: number, v: number | bigint): this {
    if (!v) return this;
    this.key(field, 0);
    this.raw(BigInt.asUintN(64, BigInt(v)));
    return this;
  }
  string(field: number, s: string): this { return s ? this.bytesField(field, new TextEncoder().encode(s)) : this; }
  message(field: number, w: Writer): this { return this.bytesField(field, w.done()); }
  done(): Uint8Array { return Uint8Array.from(this.bytes); }
  private bytesField(field: number, b: Uint8Array): this {
    this.key(field, 2);
    this.raw(BigInt(b.length));
    for (const x of b) this.bytes.push(x);
    return this;
  }
  private key(field: number, type: number): void { this.raw(BigInt(field << 3 | type)); }
  private raw(v: bigint): void {
    do { const low = Number(v & 0x7fn); v >>= 7n; this.bytes.push(v ? low | 0x80 : low); } while (v);
  }
}

const SIGNAL_CODES: Record<number, string[]> = {
  4: ["", "ILL_ILLOPC", "ILL_ILLOPN", "ILL_ILLADR", "ILL_ILLTRP"],
  5: ["", "TRAP_BRKPT", "TRAP_TRACE"],
  7: ["", "BUS_ADRALN", "BUS_ADRERR", "BUS_OBJERR"],
  11: ["", "SEGV_MAPERR", "SEGV_ACCERR"],
};
/** debuggerd's name for a signal's si_code */
export const signalCodeName = (signal: number, code: number): string =>
  code === -6 ? "SI_TKILL" : code === 0 ? "SI_USER" : SIGNAL_CODES[signal]?.[code] ?? "";

function utcTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000000+0000`;
}

export function tombstoneProto(t: TombstoneData): Uint8Array {
  const signal = new Writer().varint(1, t.signal).string(2, t.signalName).varint(3, t.code).string(4, t.codeName);
  if (t.faultAddress !== null) signal.varint(8, 1).varint(9, t.faultAddress);
  const thread = new Writer().varint(1, t.tid).string(2, t.threadName);
  for (const [name, value] of t.registers) thread.message(3, new Writer().string(1, name).varint(2, value));
  for (const f of t.frames)
    thread.message(4, new Writer().varint(1, f.relPc).varint(2, f.pc).string(4, f.fn).varint(5, f.fnOffset).string(6, f.file));
  return new Writer()
    .varint(1, t.a64 ? 1 : 0).string(2, t.fingerprint).string(4, utcTimestamp(t.timestamp))
    .varint(5, t.pid).varint(6, t.tid).varint(7, t.uid).string(9, t.command)
    .message(10, signal).string(14, t.abort)
    .message(16, new Writer().varint(1, t.tid).message(2, thread))
    .varint(20, Math.floor(t.uptimeS)).varint(22, 4096)
    .done();
}
