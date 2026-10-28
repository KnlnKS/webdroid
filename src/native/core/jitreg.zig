// A64's V registers in a region: each one the region touches lives in its v128 local from the
// region's entry, and only its exits and interpreter fallbacks reach the copy in the Cpu struct.
const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const wasm = @import("wasm.zig");
const bt = @import("bits.zig");
const Emit = jit.Emit(true);
const S = wasm.Simd;
const get = wasm.get;
const set = wasm.set;
const sv = wasm.simd;
const vm = wasm.vm;
const L_CPU = jit.L_CPU;
const OFF_V = @offsetOf(cpu.Cpu, "v");

inline fn voff(n: u8) u32 {
    return OFF_V + 16 * @as(u32, n);
}
pub fn vget(e: *Emit, n: u8) void {
    e.b.get(jit.L_VREG + n);
}
/// the 16 bytes on the stack into Vd: a 64-bit form (`q` false) clears the upper half
pub fn vput(e: *Emit, d: u8, q: bool) void {
    if (!q) keepLow(e, 8);
    e.b.set(jit.L_VREG + d);
}
/// the low 64 bits of the vector on the stack into Vd's upper half (the "2" forms), its lower half kept
pub fn vputHigh(e: *Emit, d: u8) void {
    e.b.emit(.{ sv(S.extract_s[3]), @as(u8, 0), set(jit.L_T0) });
    vget(e, d);
    e.b.emit(.{ get(jit.L_T0), sv(S.replace[3]), @as(u8, 1) });
    vput(e, d, true);
}
/// the scalar on the stack, an i64 or f64 if `wide` and else an i32 or f32, into Vd with every byte above it cleared
pub fn vputScalar(e: *Emit, d: u8, wide: bool, float: bool) void {
    const w = @intFromBool(wide);
    e.b.emit(.{sv(if (float) S.fsplat[w] else S.splat[2 + @as(u8, w)])});
    keepLow(e, @as(usize, 4) << w);
    e.b.set(jit.L_VREG + d);
}
/// clears every byte of the vector on the stack above its low `n`
pub fn keepLow(e: *Emit, n: usize) void {
    var mask: [16]u8 = [_]u8{0} ** 16;
    @memset(mask[0..n], 0xff);
    e.b.emit(.{sv(S.const_)});
    e.b.bytes(&mask);
    e.b.emit(.{sv(S.and_)});
}
pub fn spillV(e: *Emit, mask: u32) void {
    var n: u8 = 0;
    while (n < 32) : (n += 1) if (mask & bt.bit(n) != 0) e.b.emit(.{ get(L_CPU), get(jit.L_VREG + n), vm(S.store, voff(n)) });
}
pub fn loadV(e: *Emit, mask: u32) void {
    var n: u8 = 0;
    while (n < 32) : (n += 1) if (mask & bt.bit(n) != 0) e.b.emit(.{ get(L_CPU), vm(S.load, voff(n)), set(jit.L_VREG + n) });
}
