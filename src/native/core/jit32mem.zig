//! ARM32 memory access outside the integer core, as the interpreter runs it: the exclusives and
//! CLREX, NEON VLD1/VST1 of whole registers and single lanes, and barriers. Anything else falls
//! back to the interpreter.
const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const wasm = @import("wasm.zig");
const bits = @import("bits.zig").bits;
const Emit = jit.Emit(false);
const O = wasm.Op;
const S = wasm.Simd;
const get = wasm.get;
const set = wasm.set;
const c32 = wasm.c32;
const mo = wasm.mo;
const L_CPU = jit.L_CPU;
const L_X = jit.L_X;
const L_A = jit.L_A;
const OFF_EXCL = @offsetOf(cpu.Cpu, "excl");
const OFF_V = @offsetOf(cpu.Cpu, "v");

/// The unconditional (cc = 15) ARM space: CLREX and NEON VLD1/VST1.
pub fn emitArmUnconditional(e: *Emit, w: u32) bool {
    if (w == 0xf57f_f01f) return clearExclusive(e);
    return w & 0xff10_0000 == 0xf400_0000 and neonOne(e, w);
}
fn neonOne(e: *Emit, w: u32) bool {
    return if (w & (1 << 23) != 0) neonLane(e, w) else neonWhole(e, w);
}

/// LDREX/STREX (word, doubleword, byte, half) in ARM's extra load/store space.
pub fn armExclusive(e: *Emit, w: u32) bool {
    const size = bits(w, 21, 2);
    const rn = bits(w, 16, 4);
    const rd = bits(w, 12, 4);
    const rm = w & 15;
    const ld = w & (1 << 20) != 0;
    const rt = if (ld) rd else rm;
    // LDREX encodes its unused Rt field (bits 3:0) as 15; a doubleword's pair is Rt and Rt + 1
    if (w & 0x0f80_0ff0 != 0x0180_0f90 or rn == 15 or rd == 15 or rt == 15 or (size == 1 and rt >= 14)) return false;
    exclusive(e, ld, size, rn, rt, rt + 1, rd, 0);
    return true;
}

/// Thumb's exclusives and CLREX, NEON whole-register loads and stores (the ARM word under Thumb's
/// top byte), and DSB/DMB/ISB, which order nothing on one host thread.
pub fn emitThumb(e: *Emit, h: u32, h2: u32) bool {
    const ld = h & 0x10 != 0;
    const rn = h & 15;
    const rt = h2 >> 12;
    if (h & 0xffe0 == 0xe840) {
        const rd = (h2 >> 8) & 15;
        // LDREX encodes its unused status field as 15; STREX's status must be a real register
        if (rn == 15 or rt == 15 or (rd == 15) != ld) return false;
        exclusive(e, ld, 0, rn, rt, 0, rd, (h2 & 255) * 4);
        return true;
    }
    if (h & 0xffe0 == 0xe8c0 and h2 & 0xc0 == 0x40) {
        // byte, half and doubleword: the status field moves to bits 3:0 and bits 11:8 hold Rt2
        const size: u32 = switch (bits(h2, 4, 4)) {
            4 => 2,
            5 => 3,
            7 => 1,
            else => return false,
        };
        const rt2 = bits(h2, 8, 4);
        if (rn == 15 or rt == 15 or (rt2 == 15) == (size == 1) or (h2 & 15 == 15) != ld) return false;
        exclusive(e, ld, size, rn, rt, rt2, h2 & 15, 0);
        return true;
    }
    if (h & 0xff10 == 0xf900) return neonOne(e, 0xf400_0000 | (h & 0xff) << 16 | h2);
    if (h == 0xf3bf and h2 & 0xfff0 == 0x8f20) return clearExclusive(e);
    return h == 0xf3bf and (h2 & 0xfff0 == 0x8f40 or h2 & 0xfff0 == 0x8f50 or h2 & 0xfff0 == 0x8f60);
}

fn clearExclusive(e: *Emit) bool {
    e.b.emit(.{ get(L_CPU), c32(0), mo(O.i32_store, OFF_EXCL) });
    return true;
}

/// One monitor flag, which a load opens and a store consumes, storing only while it is open.
/// `size` is the ARM encoding's: 0 word, 1 doubleword (`rt2` the second word), 2 byte, 3 half.
fn exclusive(e: *Emit, ld: bool, size: u32, rn: u32, rt: u32, rt2: u32, status: u32, offset: u32) void {
    const b = e.b;
    b.get(L_X + rn);
    if (offset != 0) b.emit(.{ c32(@intCast(offset)), O.i32_add });
    b.set(L_A);
    e.checkLowAddress();
    if (ld) {
        b.emit(.{ get(L_CPU), c32(1), mo(O.i32_store, OFF_EXCL) });
        // Rt2 first: arm.zig's Thumb LDREXD leaves Rt's word when both name one register
        if (size == 1) b.emit(.{ get(L_A), mo(O.i32_load, 4), set(L_X + rt2) });
        b.emit(.{ get(L_A), mo(switch (size) { 2 => O.i32_load8_u, 3 => O.i32_load16_u, else => O.i32_load }, 0), set(L_X + rt) });
        return;
    }
    b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_EXCL) });
    e.ifc(15);
    e.storeCheck(0, switch (size) { 2 => 1, 3 => 2, else => 4 });
    b.emit(.{ get(L_A), get(L_X + rt), mo(switch (size) { 2 => O.i32_store8, 3 => O.i32_store16, else => O.i32_store }, 0) });
    if (size == 1) {
        e.storeCheck(4, 4);
        b.emit(.{ get(L_A), get(L_X + rt2), mo(O.i32_store, 4) });
    }
    e.endif();
    b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_EXCL), c32(1), O.i32_xor, set(L_X + status), get(L_CPU), c32(0), mo(O.i32_store, OFF_EXCL) });
}

/// VLD1/VST1 of one to four whole D registers: eight bytes each straight to or from memory, as
/// neonStruct copies them, with its alignment fault and post-increment writeback.
fn neonWhole(e: *Emit, w: u32) bool {
    if (w & (1 << 23) != 0) return false;
    const regs: u32 = switch (bits(w, 8, 4)) {
        7 => 1,
        10 => 2,
        6 => 3,
        2 => 4,
        else => return false,
    };
    const alignment = bits(w, 4, 2);
    const n = bits(w, 16, 4);
    const m = w & 15;
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    if ((regs & 1 != 0 and alignment > 1) or (regs == 2 and alignment == 3) or n == 15 or d + regs > 32) return false;
    const b = e.b;
    b.emit(.{ get(L_X + n), set(L_A) });
    e.checkAddress(if (alignment != 0) (@as(u32, 4) << @intCast(alignment)) - 1 else 0);
    for (0..regs) |i| {
        const off: u32 = @intCast(i * 8);
        const reg = OFF_V + (d + @as(u32, @intCast(i))) * 8;
        if (w & (1 << 21) != 0) {
            b.emit(.{ get(L_CPU), get(L_A), mo(O.i64_load, off), mo(O.i64_store, reg) });
        } else {
            e.storeCheck(off, 8);
            b.emit(.{ get(L_A), get(L_CPU), mo(O.i64_load, reg), mo(O.i64_store, off) });
        }
    }
    if (m == 13) b.emit(.{ get(L_X + n), c32(@intCast(regs * 8)), O.i32_add, set(L_X + n) }) else if (m != 15) b.emit(.{ get(L_X + n), get(L_X + m), O.i32_add, set(L_X + n) });
    return true;
}

/// VLD1/VST1 of one lane, or VLD1 of one element to all lanes of one or two D registers, with
/// arm_neon.neonLane's alignment fault and writeback.
fn neonLane(e: *Emit, w: u32) bool {
    if (bits(w, 8, 2) != 0) return false;
    const ld = w & (1 << 21) != 0;
    const replicate = bits(w, 10, 2) == 3;
    const size = if (replicate) bits(w, 6, 2) else bits(w, 10, 2);
    const index_align = bits(w, 4, 4);
    if (replicate) {
        if (!ld or size == 3 or (size == 0 and index_align & 1 != 0)) return false;
    } else if (switch (size) {
        0 => index_align & 1 != 0,
        1 => index_align & 2 != 0,
        else => index_align & 7 != 0 and index_align & 7 != 3,
    }) return false;
    const bytes = @as(u32, 1) << @intCast(size);
    const regs: u32 = if (replicate) 1 + bits(w, 5, 1) else 1;
    const n = bits(w, 16, 4);
    const m = w & 15;
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    if (n == 15 or d + regs > 32) return false;
    const b = e.b;
    b.emit(.{ get(L_X + n), set(L_A) });
    e.checkAddress(if (index_align & 1 != 0) bytes - 1 else 0);
    const load: u8 = switch (size) { 0 => O.i32_load8_u, 1 => O.i32_load16_u, else => O.i32_load };
    if (replicate) {
        b.emit(.{ get(L_A), mo(load, 0), wasm.simd(S.splat[size]), set(jit.L_VA) });
        for (0..regs) |i| b.emit(.{ get(L_CPU), get(jit.L_VA), wasm.vm(S.store64_lane, OFF_V + (d + @as(u32, @intCast(i))) * 8), 0 });
    } else {
        const lane = OFF_V + d * 8 + (index_align >> @intCast(size + 1)) * bytes;
        const store: u8 = switch (size) { 0 => O.i32_store8, 1 => O.i32_store16, else => O.i32_store };
        if (ld) b.emit(.{ get(L_CPU), get(L_A), mo(load, 0), mo(store, lane) }) else {
            e.storeCheck(0, bytes);
            b.emit(.{ get(L_A), get(L_CPU), mo(load, lane), mo(store, 0) });
        }
    }
    if (m == 13) b.emit(.{ get(L_X + n), c32(@intCast(bytes)), O.i32_add, set(L_X + n) }) else if (m != 15) b.emit(.{ get(L_X + n), get(L_X + m), O.i32_add, set(L_X + n) });
    return true;
}
