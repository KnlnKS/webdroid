const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const wasm = @import("wasm.zig");
const bt = @import("bits.zig");
const Emit = jit.Emit(true);
const O = wasm.Op;
const S = wasm.Simd;
const get = wasm.get;
const set = wasm.set;
const tee = wasm.tee;
const c32 = wasm.c32;
const c64 = wasm.c64;
const mo = wasm.mo;
const sv = wasm.simd;
const vm = wasm.vm;
const L_CPU = jit.L_CPU;
const OFF_V = @offsetOf(cpu.Cpu, "v");

pub inline fn voff(n: u8) u32 {
    return OFF_V + 16 * @as(u32, n);
}
pub fn zeroTop(e: *Emit, d: u8, from8: bool) void {
    if (!from8) e.b.emit(.{ get(L_CPU), c32(0), mo(O.i32_store, voff(d) + 4) });
    e.b.emit(.{ get(L_CPU), c64(0), mo(O.i64_store, voff(d) + 8) });
}
pub fn vget(e: *Emit, n: u8) void {
    if (e.vloaded & bt.bit(n) == 0) {
        e.b.emit(.{ get(L_CPU), vm(S.load, voff(n)), set(jit.L_VREG + n) });
        e.vloaded |= bt.bit(n);
    }
    e.b.get(jit.L_VREG + n);
}
pub fn maskLowHalf(e: *Emit) void {
    e.b.emit(.{sv(S.const_)});
    e.b.bytes(&([_]u8{0xff} ** 8 ++ [_]u8{0} ** 8));
    e.b.emit(.{sv(S.and_)});
}
pub fn vput(e: *Emit, d: u8, q: bool) void {
    if (!q) maskLowHalf(e);
    e.b.emit(.{ tee(jit.L_VREG + d), vm(S.store, voff(d)) });
    e.vloaded |= bt.bit(d);
    e.vcachedWrite = true;
}
