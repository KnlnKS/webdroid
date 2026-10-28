//! ARM32 VFP in compiled regions, as the interpreter's arm_vfp.vfp runs it: arithmetic, compares and
//! conversions, moves between core registers and the VFP file, and single and multiple
//! loads and stores. Anything else falls back to the interpreter.
const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const simd = @import("simd.zig");
const wasm = @import("wasm.zig");
const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
const Emit = jit.Emit(false);
const O = wasm.Op;
const F = wasm.F;
const get = wasm.get;
const set = wasm.set;
const c32 = wasm.c32;
const mo = wasm.mo;
const L_CPU = jit.L_CPU;
const L_A = jit.L_A;
const OFF_V = @offsetOf(cpu.Cpu, "v");
const OFF_FPCR = @offsetOf(cpu.Cpu, "fpcr");

/// The instruction word in ARM encoding (Thumb's coprocessor forms are the same word).
pub fn emit(e: *Emit, w: u32) bool {
    return arithmetic(e, w) or loadStore(e, w) or loadStoreMultiple(e, w) or coreMove(e, w);
}

fn arithmetic(e: *Emit, w: u32) bool {
    if (!is(w, 0x0f000e10, 0x0e000a00)) return false;
    const op = bits(w, 20, 4) & 0xb;
    const sub = w & 0x40 != 0;
    const unary = bits(w, 16, 4);
    const supported = switch (op) {
        0, 1, 2, 3 => true,
        8 => !sub,
        11 => !sub or unary <= 1 or unary == 4 or unary == 5 or unary == 8 or unary == 12 or unary == 13 or (unary == 7 and w & 0x80 != 0),
        else => false,
    };
    if (!supported) return false;
    const f: u1 = @intCast(bits(w, 8, 1));
    if (op == 11 and sub and unary >= 4) return compareOrConvert(e.b, w, f, unary);
    const stride: u32 = if (f == 1) 8 else 4;
    const d = if (f == 1) (bits(w, 22, 1) << 4) | bits(w, 12, 4) else (bits(w, 12, 4) << 1) | bits(w, 22, 1);
    const n = if (f == 1) (bits(w, 7, 1) << 4) | bits(w, 16, 4) else (bits(w, 16, 4) << 1) | bits(w, 7, 1);
    const m = if (f == 1) (bits(w, 5, 1) << 4) | bits(w, 0, 4) else (bits(w, 0, 4) << 1) | bits(w, 5, 1);
    const b = e.b;
    b.get(L_CPU);
    if (op == 11 and !sub) {
        const imm = simd.vfpImm(unary << 4 | (w & 15), f == 1);
        if (f == 1) b.i64c(@bitCast(imm)) else b.i32c(@bitCast(@as(u32, @truncate(imm))));
        b.memop(F.istore[f], OFF_V + d * stride);
        return true;
    }
    if (op <= 1) b.emit(.{ get(L_CPU), mo(F.load[f], OFF_V + d * stride) });
    if (op == 1) b.byte(F.neg[f]);
    if (op != 11) b.emit(.{ get(L_CPU), mo(F.load[f], OFF_V + n * stride) });
    b.emit(.{ get(L_CPU), mo(F.load[f], OFF_V + m * stride) });
    switch (op) {
        0, 1 => b.emit(.{ F.mul[f], if (sub) F.sub[f] else F.add[f] }),
        2 => { b.byte(F.mul[f]); if (sub) b.byte(F.neg[f]); },
        3 => b.byte(if (sub) F.sub[f] else F.add[f]),
        8 => b.byte(F.div[f]),
        else => if (unary == 1) b.byte(if (w & 0x80 != 0) F.sqrt[f] else F.neg[f]) else if (w & 0x80 != 0) b.byte(F.abs[f]),
    }
    b.memop(F.store[f], OFF_V + d * stride);
    return true;
}

/// VCMP/VCMPE into FPSCR's NZCV, and the VCVT forms, as the interpreter's vfpArith computes them.
fn compareOrConvert(b: *wasm.Buf, w: u32, f: u1, unary: u32) bool {
    const stride: u32 = if (f == 1) 8 else 4;
    const vd = bits(w, 12, 4);
    const d = if (f == 1) (bits(w, 22, 1) << 4) | vd else (vd << 1) | bits(w, 22, 1);
    const m = if (f == 1) (bits(w, 5, 1) << 4) | bits(w, 0, 4) else (bits(w, 0, 4) << 1) | bits(w, 5, 1);
    const sd = (vd << 1) | bits(w, 22, 1);
    const sm = (bits(w, 0, 4) << 1) | bits(w, 5, 1);
    const o7 = w & 0x80 != 0;
    switch (unary) {
        4, 5 => {
            b.emit(.{ get(L_CPU), get(L_CPU), mo(O.i32_load, OFF_FPCR), c32(0x0fff_ffff), O.i32_and });
            b.emit(.{ get(L_CPU), mo(F.load[f], OFF_V + d * stride) });
            if (f == 0) b.byte(O.f64_promote_f32);
            b.set(jit.L_F0);
            if (unary == 5) b.f64c(0) else {
                b.emit(.{ get(L_CPU), mo(F.load[f], OFF_V + m * stride) });
                if (f == 0) b.byte(O.f64_promote_f32);
            }
            b.set(jit.L_F1);
            b.emit(.{ c32(@bitCast(@as(u32, 0x8000_0000))), c32(0x6000_0000), c32(0x2000_0000), c32(0x3000_0000),
                get(jit.L_F0), get(jit.L_F1), O.f64_gt, O.select, get(jit.L_F0), get(jit.L_F1), O.f64_eq, O.select,
                get(jit.L_F0), get(jit.L_F1), O.f64_lt, O.select, O.i32_or, mo(O.i32_store, OFF_FPCR) });
        },
        7 => {
            const dst = if (f == 1) sd * 4 else ((bits(w, 22, 1) << 4) | vd) * 8;
            b.emit(.{ get(L_CPU), get(L_CPU), mo(F.load[f], OFF_V + m * stride), F.cvt[f], mo(F.store[f ^ 1], OFF_V + dst) });
        },
        8 => b.emit(.{ get(L_CPU), get(L_CPU), mo(O.i32_load, OFF_V + sm * 4), F.convert_i32_s[f] + @as(u8, if (o7) 0 else 1), mo(F.store[f], OFF_V + d * stride) }),
        else => {
            b.emit(.{ get(L_CPU), get(L_CPU), mo(F.load[f], OFF_V + m * stride) });
            if (!o7) b.byte(F.ceil[f] + 3);
            b.byte(O.fc_prefix);
            b.u(@as(u32, f) * 2 + @as(u32, if (unary == 13) 0 else 1));
            b.memop(O.i32_store, OFF_V + sd * 4);
        },
    }
    return true;
}

/// Moves between core registers and the VFP file (VMOV to and from a single, a double or a pair
/// of singles) and VMRS/VMSR on FPSCR. A VMRS into APSR replaces NZCV outright.
fn coreMove(e: *Emit, w: u32) bool {
    const b = e.b;
    const rt = bits(w, 12, 4);
    if (w & 0x0fff_ffff == 0x0ef1_fa10) {
        e.eager(15);
        for (jit.L_N..jit.L_V + 1, 0..) |l, i| b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_FPCR), c32(@intCast(31 - i)), O.i32_shr_u, c32(1), O.i32_and, set(@intCast(l)) });
        return true;
    }
    if (rt == 15) return false;
    if (w & 0x0fff_0fff == 0x0ef1_0a10) {
        b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_FPCR), set(jit.L_X + rt) });
    } else if (w & 0x0fff_0fff == 0x0ee1_0a10) {
        b.emit(.{ get(L_CPU), get(jit.L_X + rt), mo(O.i32_store, OFF_FPCR) });
    } else if (w & 0x0fe0_0f7f == 0x0e00_0a10) {
        const n = (bits(w, 16, 4) << 1) | bits(w, 7, 1);
        if (w & (1 << 20) != 0) b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_V + n * 4), set(jit.L_X + rt) }) else b.emit(.{ get(L_CPU), get(jit.L_X + rt), mo(O.i32_store, OFF_V + n * 4) });
    } else if (w & 0x0f90_0f5f == 0x0e80_0b10) {
        const n = (bits(w, 7, 1) << 4) | bits(w, 16, 4);
        const q = w & (1 << 21) != 0;
        if (q and n & 1 != 0) return false;
        const esz: u32 = if (w & (1 << 22) != 0) 0 else if (w & 0x20 != 0) 1 else 2;
        b.emit(.{ get(L_CPU), get(jit.L_X + rt), wasm.simd(wasm.Simd.splat[esz]) });
        if (q) b.emit(.{wasm.vm(wasm.Simd.store, OFF_V + n * 8)}) else b.emit(.{ wasm.vm(wasm.Simd.store64_lane, OFF_V + n * 8), 0 });
    } else if (w & 0x0f00_0f1f == 0x0e00_0b10 and (w & (1 << 20) != 0 or w & (1 << 23) == 0)) {
        return laneMove(b, w, rt);
    } else if (w & 0x0fe0_0ed0 == 0x0c40_0a10) {
        const rt2 = bits(w, 16, 4);
        if (rt2 == 15) return false;
        const lo = if (bits(w, 8, 1) != 0) ((bits(w, 5, 1) << 4) | bits(w, 0, 4)) * 2 else (bits(w, 0, 4) << 1) | bits(w, 5, 1);
        for ([_]u32{ rt, rt2 }, 0..) |r, i| {
            const off = OFF_V + (lo + @as(u32, @intCast(i))) * 4;
            if (w & (1 << 20) != 0) b.emit(.{ get(L_CPU), mo(O.i32_load, off), set(jit.L_X + r) }) else b.emit(.{ get(L_CPU), get(jit.L_X + r), mo(O.i32_store, off) });
        }
    } else return false;
    return true;
}

/// VMOV between a core register and one lane of a D register: a byte, half or word, a load
/// sign- or zero-extending it.
fn laneMove(b: *wasm.Buf, w: u32, rt: u32) bool {
    const esz: u5 = if (w & (1 << 22) != 0) 0 else if (w & 0x20 != 0) 1 else 2;
    if (esz == 2 and w & 0x80_0040 != 0) return false;
    const index = (bits(w, 21, 1) << (2 - esz)) | (if (esz == 0) bits(w, 5, 2) else if (esz == 1) bits(w, 6, 1) else 0);
    const off = OFF_V + ((bits(w, 7, 1) << 4) | bits(w, 16, 4)) * 8 + (index << @intCast(esz));
    if (w & (1 << 20) != 0) {
        const unsigned = w & (1 << 23) != 0;
        const op = switch (esz) {
            0 => if (unsigned) O.i32_load8_u else O.i32_load8_s,
            1 => if (unsigned) O.i32_load16_u else O.i32_load16_s,
            else => O.i32_load,
        };
        b.emit(.{ get(L_CPU), mo(op, off), set(jit.L_X + rt) });
    } else b.emit(.{ get(L_CPU), get(jit.L_X + rt), mo(switch (esz) { 0 => O.i32_store8, 1 => O.i32_store16, else => O.i32_store }, off) });
    return true;
}

fn loadStore(e: *Emit, w: u32) bool {
    if (w & 0x0f200000 != 0x0d000000) return false;
    const cp = bits(w, 8, 4);
    if (cp != 10 and cp != 11) return false;
    const rn = bits(w, 16, 4);
    const dp = cp == 11;
    const d = if (dp) (bits(w, 22, 1) << 4) | bits(w, 12, 4) else (bits(w, 12, 4) << 1) | bits(w, 22, 1);
    const slot = if (dp) d * 2 else d;
    const offset = (w & 255) * 4;
    const load_mem = bits(w, 20, 1) != 0;
    const add = bits(w, 23, 1) != 0;
    const b = e.b;
    if (rn == 15) {
        // PC reads as the word-aligned pc + 8 in ARM and pc + 4 in Thumb
        const base = if (e.r.isa == .thumb) (e.pc +% 4) & ~@as(u32, 3) else e.pc +% 8;
        b.i32c(@bitCast(if (add) base +% offset else base -% offset));
    } else b.emit(.{ get(jit.L_X + rn), c32(@intCast(offset)), if (add) O.i32_add else O.i32_sub });
    b.set(L_A);
    if (load_mem) e.checkLowAddress() else if (dp) e.rangeCheck(0, 8) else e.storeCheck(0, 4);
    for (0..(if (dp) @as(usize, 2) else 1)) |i| {
        const off: u32 = @intCast(i * 4);
        const reg_off = OFF_V + slot * 4 + off;
        if (load_mem) {
            b.emit(.{ get(L_CPU), get(L_A), mo(O.i32_load, off), mo(O.i32_store, reg_off) });
        } else b.emit(.{ get(L_A), get(L_CPU), mo(O.i32_load, reg_off), mo(O.i32_store, off) });
    }
    return true;
}

/// VLDM/VSTM (so VPUSH/VPOP), increment-after or decrement-before, with optional writeback.
fn loadStoreMultiple(e: *Emit, w: u32) bool {
    if (w & 0x0e00_0000 != 0x0c00_0000) return false;
    const cp = bits(w, 8, 4);
    const P = bits(w, 24, 1) != 0;
    const U = bits(w, 23, 1) != 0;
    const W = bits(w, 21, 1) != 0;
    const rn = bits(w, 16, 4);
    if ((cp != 10 and cp != 11) or rn == 15 or !((!P and U) or (P and !U and W))) return false;
    const dp = cp == 11;
    const d = if (dp) (bits(w, 22, 1) << 4) | bits(w, 12, 4) else (bits(w, 12, 4) << 1) | bits(w, 22, 1);
    const imm8 = w & 255;
    const count = if (dp) imm8 >> 1 else imm8;
    if (count == 0 or d + count > 32) return false;
    const nbytes = imm8 * 4;
    const load_mem = bits(w, 20, 1) != 0;
    const b = e.b;
    b.get(jit.L_X + rn);
    if (!U) b.emit(.{ c32(@intCast(nbytes)), O.i32_sub });
    b.set(L_A);
    if (load_mem) e.checkLowAddress() else e.rangeCheck(0, nbytes);
    const words: u32 = if (dp) 2 else 1;
    var off: u32 = 0;
    for (0..count) |i| for (0..words) |k| {
        const slot = if (dp) (d + @as(u32, @intCast(i))) * 2 + @as(u32, @intCast(k)) else d + @as(u32, @intCast(i));
        if (load_mem) {
            b.emit(.{ get(L_CPU), get(L_A), mo(O.i32_load, off), mo(O.i32_store, OFF_V + slot * 4) });
        } else b.emit(.{ get(L_A), get(L_CPU), mo(O.i32_load, OFF_V + slot * 4), mo(O.i32_store, off) });
        off += 4;
    };
    if (W) b.emit(.{ get(jit.L_X + rn), c32(@intCast(nbytes)), if (U) O.i32_add else O.i32_sub, set(jit.L_X + rn) });
    return true;
}
