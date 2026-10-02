// StatsEvent and StatsLog stay TS while a measured regression stands: with AOSP's bytecode, the
// first FrameworkStatsLog.write (ChangeReporter's) leaves mihon's main thread in GC for the rest
// of a lat run (~12 s of 20 s) and its theme taps take 170-540 ms instead of ~55 ms.
import { JObj, rt } from "../jvm/runtime";
import { i8, utf8 } from "../jvm/abi";
import { uptimeMillis } from "../guest-clock";

class JStatsEvent extends JObj { atom = 0; bytes = new Int8Array(0); }
class JStatsBuilder extends JObj {
  bytes = new Uint8Array(256); view = new DataView(this.bytes.buffer);
  pos = 2; count = 0; atom = 0; error = 0; last = 0; annotations = 0; max = 51200;
  constructor() { super(); this.bytes[0] = 7; this.long(BigInt(Math.floor(uptimeMillis() * 1e6))); }
  reserve(size: number): boolean {
    if (this.pos + size > this.max) { this.error |= 4; return false; }
    if (this.pos + size > this.bytes.length) {
      const bytes = new Uint8Array(Math.min(this.max, Math.max(this.bytes.length * 2, this.pos + size)));
      bytes.set(this.bytes); this.bytes = bytes; this.view = new DataView(bytes.buffer);
    }
    return true;
  }
  field(type: number, size: number): boolean {
    this.count++; this.annotations = 0;
    if (!this.reserve(size + 1)) return false;
    this.last = this.pos; this.bytes[this.pos++] = type; return true;
  }
  int(value: number) { if (this.field(0, 4)) { this.view.setInt32(this.pos, value, true); this.pos += 4; } return this; }
  long(value: bigint) { if (this.field(1, 8)) { this.view.setBigInt64(this.pos, value, true); this.pos += 8; } return this; }
  array(type: number, value: Uint8Array) {
    if (this.field(type, 4 + value.length)) {
      this.view.setInt32(this.pos, value.length, true); this.pos += 4;
      this.bytes.set(value, this.pos); this.pos += value.length;
    }
    return this;
  }
  annotation(id: number, type: number, value: number) {
    if (this.count < 2) this.error |= 0x20;
    else if (this.annotations >= 15) this.error |= 0x100;
    else if (this.reserve(type === 5 ? 3 : 6)) {
      this.bytes[this.pos++] = id; this.bytes[this.pos++] = type;
      if (type === 5) this.bytes[this.pos++] = +!!value;
      else { this.view.setInt32(this.pos, value, true); this.pos += 4; }
      this.bytes[this.last] = (++this.annotations << 4) | (this.bytes[this.last] & 15);
    }
    return this;
  }
}
rt.register({ name: "android/util/StatsEvent", ctor: JStatsEvent, methods: {
  "static newBuilder()Landroid/util/StatsEvent$Builder;": () => { rt.link("android/util/StatsEvent$Builder"); return new JStatsBuilder(); },
  "getAtomId()I": function (this: JStatsEvent) { return this.atom; },
  "getNumBytes()I": function (this: JStatsEvent) { return this.bytes.length; },
  "getBytes()[B": function (this: JStatsEvent) { return this.bytes; },
  "release()V": function () {},
} });
const B = "Landroid/util/StatsEvent$Builder;";
rt.register({ name: "android/util/StatsEvent$Builder", ctor: JStatsBuilder, methods: {
  [`setAtomId(I)${B}`]: function (this: JStatsBuilder, atom: number) {
    if (!this.atom) { this.atom = atom; if (this.count === 1) this.int(atom); else this.error |= 0x2000; } return this;
  },
  [`writeInt(I)${B}`]: function (this: JStatsBuilder, value: number) { return this.int(value); },
  [`writeLong(J)${B}`]: function (this: JStatsBuilder, value: bigint) { return this.long(value); },
  [`writeLongArray([J)${B}`]: function (this: JStatsBuilder, values: BigInt64Array | null) {
    if (!values) return rt.npe();
    if (values.length > 127) this.error |= 0x4000;
    else if (this.field(3, 2 + values.length * 8)) {
      this.bytes[this.pos++] = values.length; this.bytes[this.pos++] = 1;
      for (const value of values) { this.view.setBigInt64(this.pos, value, true); this.pos += 8; }
    }
    return this;
  },
  [`writeBoolean(Z)${B}`]: function (this: JStatsBuilder, value: number) { if (this.field(5, 1)) this.bytes[this.pos++] = +!!value; return this; },
  [`writeFloat(F)${B}`]: function (this: JStatsBuilder, value: number) { if (this.field(4, 4)) { this.view.setFloat32(this.pos, value, true); this.pos += 4; } return this; },
  [`writeString(Ljava/lang/String;)${B}`]: function (this: JStatsBuilder, value: string | null) { return this.array(2, utf8.enc.encode(value ?? "")); },
  [`writeByteArray([B)${B}`]: function (this: JStatsBuilder, value: Int8Array) { return this.array(6, new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); },
  [`addBooleanAnnotation(BZ)${B}`]: function (this: JStatsBuilder, id: number, value: number) { return this.annotation(id, 5, value); },
  [`addIntAnnotation(BI)${B}`]: function (this: JStatsBuilder, id: number, value: number) { return this.annotation(id, 0, value); },
  [`usePooledBuffer()${B}`]: function (this: JStatsBuilder) { this.max = 4064; if (this.pos > this.max) this.error |= 4; return this; },
  "build()Landroid/util/StatsEvent;": function (this: JStatsBuilder) {
    if (!this.atom) this.error |= 2;
    if (this.count > 127) this.error |= 0x200;
    if (!this.view.getBigInt64(3, true)) this.error |= 1;
    if (this.error) {
      this.pos = 11; this.bytes[this.pos++] = 0; this.view.setInt32(this.pos, this.atom, true); this.pos += 4;
      this.bytes[this.pos++] = 15; this.view.setInt32(this.pos, this.error, true); this.pos += 4; this.count = 3;
    }
    this.bytes[1] = this.count;
    rt.link("android/util/StatsEvent"); return Object.assign(new JStatsEvent(), { atom: this.atom, bytes: i8(this.bytes.slice(0, this.pos)) });
  },
} });
rt.register({ name: "android/util/StatsLog", ctor: class extends JObj {}, methods: {
  // With no statsd socket, Android's fire-and-forget telemetry write is dropped.
  "static write(Landroid/util/StatsEvent;)V": () => {},
} });
