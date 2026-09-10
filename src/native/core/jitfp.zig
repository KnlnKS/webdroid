// The SIMD&FP half of the A64 emitter: scalar floating point, and the loads and stores of V
// registers. The V file stays in the Cpu struct, where the interpreter reads it, so nothing
// spills or reloads around a fallback; a scalar write zeroes the rest of its register, as the
// architecture does. The min/max families and the fused double multiply-add keep their NaN
// rules in fp.zig and are called there; everything else is a wasm operation.

const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const simd = @import("simd.zig");
const wasm = @import("wasm.zig");
const a64 = @import("a64.zig");
const Emit = jit.Emit;
const O = wasm.Op;
const L_CPU = jit.L_CPU;
const OFF_V = @offsetOf(cpu.Cpu, "v");

inline fn is(w: u32, mask: u32, val: u32) bool {
    return (w & mask) == val;
}
inline fn bits(w: u32, lo: u5, n: u6) u32 {
    return (w >> lo) & (@as(u32, 0xffff_ffff) >> @intCast(32 - @as(u32, n)));
}
inline fn sx(v: u32, n: u5) i64 {
    const sh: u5 = @intCast(32 - @as(u32, n));
    return @as(i32, @bitCast(v << sh)) >> sh;
}
inline fn voff(n: u8) u32 {
    return OFF_V + 16 * @as(u32, n);
}
/// pushes Vn's low element
fn getF(e: *Emit, n: u8, dp: bool) void {
    e.b.get(L_CPU);
    e.b.memop(if (dp) O.f64_load else O.f32_load, voff(n));
}
/// the stack holds [cpu, value]: stores it as Vd's low element and clears the rest
fn setF(e: *Emit, d: u8, dp: bool) void {
    e.b.memop(if (dp) O.f64_store else O.f32_store, voff(d));
    zeroTop(e, d, dp);
}
fn zeroTop(e: *Emit, d: u8, from8: bool) void {
    const b = e.b;
    if (!from8) {
        b.get(L_CPU);
        b.i32c(0);
        b.memop(O.i32_store, voff(d) + 4);
    }
    b.get(L_CPU);
    b.i64c(0);
    b.memop(O.i64_store, voff(d) + 8);
}
/// nearest, ceil, floor, trunc: the order of FCVT's rmode and FRINT's opcodes
fn roundOp(dp: bool, mode: u32) u8 {
    const base: u8 = if (dp) O.f64_ceil else O.f32_ceil;
    return switch (mode) {
        1 => base,
        2 => base + 1,
        3 => base + 2,
        else => base + 3,
    };
}

/// a scalar FP word; anything else in the space falls back
pub fn emitSimd(e: *Emit, w: u32, pc: u32, k: u32) void {
    const ftype = bits(w, 22, 2);
    if (!is(w, 0x5000_0000, 0x1000_0000) or w & 0x2000_0000 != 0 or ftype > 1) return e.fallback(pc, k);
    const b = e.b;
    const dp = ftype == 1;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const sf = w >> 31 != 0;
    // FP <-> integer conversion, and the FMOV general forms
    if (is(w, 0x5f20_fc00, 0x1e20_0000)) {
        const rmode = bits(w, 19, 2);
        const opcode = bits(w, 16, 3);
        if (opcode >= 6) {
            if (rmode != 0 or dp != sf) return e.fallback(pc, k);
            if (opcode == 6) {
                b.get(L_CPU);
                b.memop(if (sf) O.i64_load else O.i64_load32_u, voff(rn));
                e.setX(rd);
            } else {
                b.get(L_CPU);
                e.getX(rn);
                if (!sf) b.op(O.i32_wrap_i64);
                b.memop(if (sf) O.i64_store else O.i32_store, voff(rd));
                zeroTop(e, rd, sf);
            }
            return;
        }
        if (opcode == 2 or opcode == 3) {
            b.get(L_CPU);
            e.getX(rn);
            if (!sf) b.op(O.i32_wrap_i64);
            const base: u8 = if (dp) O.f64_convert_i32_s else O.f32_convert_i32_s;
            b.op(base + @as(u8, if (sf) 2 else 0) + @as(u8, if (opcode == 3) 1 else 0));
            setF(e, rd, dp);
            return;
        }
        // FCVTAS/FCVTAU round ties away, which wasm has no operation for
        if (opcode >= 4) return e.fallback(pc, k);
        getF(e, rn, dp);
        b.op(roundOp(dp, rmode));
        b.op(O.fc_prefix);
        b.u((if (sf) @as(u32, 4) else 0) + (if (dp) @as(u32, 2) else 0) + (opcode & 1));
        if (sf) e.setX(rd) else e.setW(rd);
        return;
    }
    // the fixed-point conversions, and everything below wants sf = 0
    if (is(w, 0x5f20_0000, 0x1e00_0000) or sf) return e.fallback(pc, k);
    if (is(w, 0x5f20_7c00, 0x1e20_4000)) {
        const opcode = bits(w, 15, 6);
        switch (opcode) {
            0, 1, 2, 3 => {
                b.get(L_CPU);
                getF(e, rn, dp);
                switch (opcode) {
                    1 => b.op(if (dp) O.f64_abs else O.f32_abs),
                    2 => b.op(if (dp) O.f64_neg else O.f32_neg),
                    3 => b.op(if (dp) O.f64_sqrt else O.f32_sqrt),
                    else => {},
                }
                setF(e, rd, dp);
            },
            // FCVT: to single from a double (4), to double from a single (5)
            4, 5 => {
                if ((opcode == 4) != dp) return e.fallback(pc, k);
                b.get(L_CPU);
                getF(e, rn, dp);
                b.op(if (dp) O.f32_demote_f64 else O.f64_promote_f32);
                setF(e, rd, !dp);
            },
            8, 9, 10, 11 => {
                b.get(L_CPU);
                getF(e, rn, dp);
                b.op(roundOp(dp, opcode - 8));
                setF(e, rd, dp);
            },
            else => e.fallback(pc, k),
        }
        return;
    }
    if (is(w, 0x5f20_3c00, 0x1e20_2000)) {
        if (w & 7 != 0) return e.fallback(pc, k);
        fcmp(e, rn, if (w & 8 != 0) null else rm, dp);
        return;
    }
    if (is(w, 0x5f20_1c00, 0x1e20_1000)) {
        const imm = simd.vfpImm(bits(w, 13, 8), dp);
        b.get(L_CPU);
        if (dp) b.i64c(@bitCast(imm)) else b.i32c(@bitCast(@as(u32, @truncate(imm))));
        b.memop(if (dp) O.i64_store else O.i32_store, voff(rd));
        zeroTop(e, rd, dp);
        return;
    }
    if (is(w, 0x5f20_0c00, 0x1e20_0400)) {
        e.cond(@intCast(bits(w, 12, 4)));
        b.blockStart(O.if_, wasm.VOID);
        fcmp(e, rn, rm, dp);
        b.op(O.else_);
        for ([_]u32{ jit.L_N, jit.L_Z, jit.L_C, jit.L_V }, 0..) |l, i| {
            b.i32c(@intCast((w >> @intCast(3 - i)) & 1));
            b.set(l);
        }
        b.op(O.end);
        return;
    }
    if (is(w, 0x5f20_0c00, 0x1e20_0800)) {
        const opcode = bits(w, 12, 4);
        if (opcode > 8) return e.fallback(pc, k);
        b.get(L_CPU);
        getF(e, rn, dp);
        getF(e, rm, dp);
        switch (opcode) {
            0 => b.op(if (dp) O.f64_mul else O.f32_mul),
            1 => b.op(if (dp) O.f64_div else O.f32_div),
            2 => b.op(if (dp) O.f64_add else O.f32_add),
            3 => b.op(if (dp) O.f64_sub else O.f32_sub),
            8 => {
                b.op(if (dp) O.f64_mul else O.f32_mul);
                b.op(if (dp) O.f64_neg else O.f32_neg);
            },
            // FMAX, FMIN, FMAXNM, FMINNM: the NaN rules live in fp.zig
            else => {
                const base: u32 = if (dp) jit.F_FMAX64 else jit.F_FMAX32;
                b.call(base + (opcode - 4));
            },
        }
        setF(e, rd, dp);
        return;
    }
    if (is(w, 0x5f20_0c00, 0x1e20_0c00)) {
        b.get(L_CPU);
        b.get(L_CPU);
        b.memop(if (dp) O.i64_load else O.i32_load, voff(rn));
        b.get(L_CPU);
        b.memop(if (dp) O.i64_load else O.i32_load, voff(rm));
        e.cond(@intCast(bits(w, 12, 4)));
        b.op(O.select);
        b.memop(if (dp) O.i64_store else O.i32_store, voff(rd));
        zeroTop(e, rd, dp);
        return;
    }
    // FMADD / FMSUB / FNMADD / FNMSUB: one rounding; a single is exact in double arithmetic
    if (is(w, 0x5f00_0000, 0x1f00_0000)) {
        const o1 = bits(w, 21, 1) != 0;
        const o0 = bits(w, 15, 1) != 0;
        b.get(L_CPU);
        getF(e, rn, dp);
        if (o1 != o0) b.op(if (dp) O.f64_neg else O.f32_neg);
        if (!dp) b.op(O.f64_promote_f32);
        getF(e, rm, dp);
        if (!dp) b.op(O.f64_promote_f32);
        if (!dp) b.op(O.f64_mul);
        getF(e, @intCast(bits(w, 10, 5)), dp);
        if (o1) b.op(if (dp) O.f64_neg else O.f32_neg);
        if (dp) b.call(jit.F_FMA64) else {
            b.op(O.f64_promote_f32);
            b.op(O.f64_add);
            b.op(O.f32_demote_f64);
        }
        setF(e, rd, dp);
        return;
    }
    e.fallback(pc, k);
}
/// NZCV of a compare (with zero when rm is null): less 1000, equal 0110, greater 0010, unordered 0011
fn fcmp(e: *Emit, rn: u8, rm: ?u8, dp: bool) void {
    const b = e.b;
    getF(e, rn, dp);
    if (!dp) b.op(O.f64_promote_f32);
    b.set(jit.L_F0);
    if (rm) |m| {
        getF(e, m, dp);
        if (!dp) b.op(O.f64_promote_f32);
    } else b.f64c(0);
    b.set(jit.L_F1);
    b.get(jit.L_F0);
    b.get(jit.L_F1);
    b.op(O.f64_lt);
    b.tee(jit.L_N);
    b.op(O.i32_eqz);
    b.set(jit.L_C);
    b.get(jit.L_F0);
    b.get(jit.L_F1);
    b.op(O.f64_eq);
    b.set(jit.L_Z);
    b.get(jit.L_F0);
    b.get(jit.L_F0);
    b.op(O.f64_ne);
    b.get(jit.L_F1);
    b.get(jit.L_F1);
    b.op(O.f64_ne);
    b.op(O.i32_or);
    b.set(jit.L_V);
}

/// Vt <- `width` bytes at L_A + off, the rest zeroed
fn vload(e: *Emit, t: u8, off: u32, width: u32) void {
    const b = e.b;
    b.get(L_CPU);
    b.get(jit.L_A);
    b.memop(switch (width) {
        1 => O.i64_load8_u,
        2 => O.i64_load16_u,
        4 => O.i64_load32_u,
        else => O.i64_load,
    }, off);
    b.memop(O.i64_store, voff(t));
    b.get(L_CPU);
    if (width == 16) {
        b.get(jit.L_A);
        b.memop(O.i64_load, off + 8);
    } else b.i64c(0);
    b.memop(O.i64_store, voff(t) + 8);
}
fn vstore(e: *Emit, t: u8, off: u32, width: u32) void {
    const b = e.b;
    e.storeCheck(off);
    if (width == 16) e.storeCheck(off + 8);
    b.get(jit.L_A);
    b.get(L_CPU);
    b.memop(O.i64_load, voff(t));
    b.memop(switch (width) {
        1 => O.i64_store8,
        2 => O.i64_store16,
        4 => O.i64_store32,
        else => O.i64_store,
    }, off);
    if (width == 16) {
        b.get(jit.L_A);
        b.get(L_CPU);
        b.memop(O.i64_load, voff(t) + 8);
        b.memop(O.i64_store, off + 8);
    }
}
pub fn emitVldrlit(e: *Emit, o: *const a64.Op) void {
    const b = e.b;
    const a: u32 = @truncate(o.imm);
    const width = @as(u32, 4) << @intCast(o.b);
    b.get(L_CPU);
    b.i32c(0);
    b.memop(if (width == 4) O.i64_load32_u else O.i64_load, a);
    b.memop(O.i64_store, voff(o.rd));
    b.get(L_CPU);
    if (width == 16) {
        b.i32c(0);
        b.memop(O.i64_load, a + 8);
    } else b.i64c(0);
    b.memop(O.i64_store, voff(o.rd) + 8);
}
/// LDR/STR and LDP/STP of a V register; the structure loads and stores fall back
pub fn emitVmem(e: *Emit, w: u32, pc: u32, k: u32) void {
    const b = e.b;
    const rt: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    if (is(w, 0xbfbf0000, 0x0c000000) or is(w, 0xbfa00000, 0x0c800000) or is(w, 0xbf9f0000, 0x0d000000) or is(w, 0xbf800000, 0x0d800000)) return e.fallback(pc, k);
    if (is(w, 0x3a000000, 0x28000000)) {
        const opc = bits(w, 30, 2);
        if (opc == 3) return e.fallback(pc, k);
        const Ld = bits(w, 22, 1) != 0;
        const width = @as(u32, 4) << @intCast(opc);
        const off: i64 = sx(bits(w, 15, 7), 7) * width;
        const kind = bits(w, 23, 2);
        const rt2: u8 = @intCast(bits(w, 10, 5));
        e.getSP(rn);
        if (kind != 1 and off != 0) {
            b.i64c(off);
            b.op(O.i64_add);
        }
        e.address();
        if (kind == 1 or kind == 3) {
            e.getSP(rn);
            b.i64c(off);
            b.op(O.i64_add);
            e.setSP(rn);
        }
        if (Ld) {
            vload(e, rt, 0, width);
            vload(e, rt2, width, width);
        } else {
            vstore(e, rt, 0, width);
            vstore(e, rt2, width, width);
        }
        return;
    }
    const size = bits(w, 30, 2);
    const opc = bits(w, 22, 2);
    if (opc & 2 != 0 and size != 0) return e.fallback(pc, k);
    const scale: u5 = @intCast(if (opc & 2 != 0) 4 else size);
    const width = @as(u32, 1) << scale;
    // the addressing form: an unsigned scaled offset, a register, or a 9-bit offset (unscaled, post, pre)
    const unsigned = is(w, 0x3b000000, 0x39000000);
    const reg = is(w, 0x3b200c00, 0x38200800);
    const kind = if (unsigned or reg) 0 else bits(w, 10, 2);
    if (kind == 2) return e.fallback(pc, k);
    e.getSP(rn);
    var post: i64 = 0;
    if (unsigned) {
        const imm = bits(w, 10, 12) << scale;
        if (imm != 0) {
            b.i64c(imm);
            b.op(O.i64_add);
        }
    } else if (reg) {
        e.getX(rm);
        switch (bits(w, 13, 3)) {
            2 => {
                b.i64c(0xffff_ffff);
                b.op(O.i64_and);
            },
            6 => b.op(O.i64_extend32_s),
            else => {},
        }
        if (bits(w, 12, 1) != 0 and scale != 0) {
            b.i64c(scale);
            b.op(O.i64_shl);
        }
        b.op(O.i64_add);
    } else {
        const imm9 = sx(bits(w, 12, 9), 9);
        if (kind == 1) post = imm9 else if (imm9 != 0) {
            b.i64c(imm9);
            b.op(O.i64_add);
        }
    }
    if (kind == 3) {
        b.tee(jit.L_T0);
        e.setSP(rn);
        b.get(jit.L_T0);
    }
    e.address();
    if (post != 0) {
        e.getSP(rn);
        b.i64c(post);
        b.op(O.i64_add);
        e.setSP(rn);
    }
    if (opc & 1 != 0) vload(e, rt, 0, width) else vstore(e, rt, 0, width);
}
