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

const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
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

/// a SIMD&FP word: the scalar FP space, the vector forms emitVector knows, or a fallback
pub fn emitSimd(e: *Emit, w: u32, pc: u32, k: u32) void {
    if (!is(w, 0x5000_0000, 0x1000_0000)) {
        if (!emitVector(e, w)) e.fallback(pc, k);
        return;
    }
    const ftype = bits(w, 22, 2);
    if (w & 0x2000_0000 != 0 or ftype > 1) return e.fallback(pc, k);
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

// ── vectors, through simd128: a whole V register is loaded, the lanes operated on, and the
// result stored whole (Q) or as its low half with the top cleared, as the architecture does
const S = wasm.Simd;
fn vop(e: *Emit, op: u8) void {
    e.b.byte(S.prefix);
    e.b.u(op);
}
/// a v128 memory op at the V register (align hint 0)
fn vmem(e: *Emit, op: u8, off: u32) void {
    vop(e, op);
    e.b.u(0);
    e.b.u(off);
}
fn vget(e: *Emit, n: u8) void {
    e.b.get(L_CPU);
    vmem(e, S.load, voff(n));
}
/// the stack holds [cpu, v128]: stores it as Vd
fn vput(e: *Emit, d: u8, q: bool) void {
    if (q) {
        vmem(e, S.store, voff(d));
        return;
    }
    vmem(e, 0x5b, voff(d)); // store64_lane
    e.b.byte(0);
    e.b.get(L_CPU);
    e.b.i64c(0);
    e.b.memop(O.i64_store, voff(d) + 8);
}
/// the register-form lane tables have no entry (0) for a width wasm lacks
fn lane(tab: [4]u8, esz: u32) ?u8 {
    return if (tab[esz] == 0) null else tab[esz];
}
/// the vector forms the emitter knows; false leaves the word to the interpreter, and nothing
/// has been emitted by then
fn emitVector(e: *Emit, w: u32) bool {
    const b = e.b;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const q = bits(w, 30, 1) != 0;
    const U = bits(w, 29, 1) != 0;
    const size = bits(w, 22, 2);
    // the scalar forms zero above their element and keep to the interpreter
    if (w & 0x1000_0000 != 0) return false;
    // modified immediate: MOVI / MVNI / ORR / BIC / FMOV
    if (is(w, 0x9ff8_0400, 0x0f00_0400)) {
        const cmode = bits(w, 12, 4);
        const ex = simd.expandImm(bits(w, 29, 1), cmode, bits(w, 11, 1), (bits(w, 16, 3) << 5) | bits(w, 5, 5)) orelse return false;
        if (ex.kind == .fmov and U and !q) return false;
        const v: i64 = @bitCast(ex.v);
        for ([_]u32{ 0, 8 }) |off| {
            b.get(L_CPU);
            if (off == 8 and !q) {
                b.i64c(0);
            } else switch (ex.kind) {
                .orr, .bic => {
                    b.get(L_CPU);
                    b.memop(O.i64_load, voff(rd) + off);
                    b.i64c(if (ex.kind == .orr) v else ~v);
                    b.op(if (ex.kind == .orr) O.i64_or else O.i64_and);
                },
                .mvni => b.i64c(~v),
                else => b.i64c(v),
            }
            b.memop(O.i64_store, voff(rd) + off);
        }
        return true;
    }
    // copy: DUP / INS / SMOV / UMOV
    if (is(w, 0x9fe0_8400, 0x0e00_0400)) {
        const imm5 = bits(w, 16, 5);
        const imm4 = bits(w, 11, 4);
        if (imm5 & 15 == 0) return false;
        const esz: u32 = @ctz(imm5);
        const idx = imm5 >> @intCast(esz + 1);
        if (U) {
            b.get(L_CPU);
            vget(e, rd);
            vget(e, rn);
            vop(e, S.extract_u[esz]);
            b.byte(@intCast(imm4 >> @intCast(esz)));
            vop(e, S.replace[esz]);
            b.byte(@intCast(idx));
            vmem(e, S.store, voff(rd));
            return true;
        }
        switch (imm4) {
            0 => {
                b.get(L_CPU);
                vget(e, rn);
                vop(e, S.extract_u[esz]);
                b.byte(@intCast(idx));
                vop(e, S.splat[esz]);
                vput(e, rd, q);
            },
            1 => {
                b.get(L_CPU);
                e.getX(rn);
                if (esz < 3) b.op(O.i32_wrap_i64);
                vop(e, S.splat[esz]);
                vput(e, rd, q);
            },
            3 => {
                b.get(L_CPU);
                vget(e, rd);
                e.getX(rn);
                if (esz < 3) b.op(O.i32_wrap_i64);
                vop(e, S.replace[esz]);
                b.byte(@intCast(idx));
                vmem(e, S.store, voff(rd));
            },
            5, 7 => {
                if (esz == 3 and !q) return false;
                vget(e, rn);
                vop(e, if (imm4 == 5) S.extract_s[esz] else S.extract_u[esz]);
                b.byte(@intCast(idx));
                if (esz == 3) {
                    e.setX(rd);
                } else if (q) {
                    b.op(if (imm4 == 5) O.i64_extend_i32_s else O.i64_extend_i32_u);
                    e.setX(rd);
                } else e.setW(rd);
            },
            else => return false,
        }
        return true;
    }
    // three-same, bitwise: AND / BIC / ORR / ORN, EOR / BSL / BIT / BIF
    if (is(w, 0x9f20_fc00, 0x0e20_1c00)) {
        b.get(L_CPU);
        if (!U) {
            vget(e, rn);
            vget(e, rm);
            switch (size) {
                0 => vop(e, S.and_),
                1 => vop(e, S.andnot),
                2 => vop(e, S.or_),
                else => {
                    vop(e, S.not);
                    vop(e, S.or_);
                },
            }
        } else if (size == 0) {
            vget(e, rn);
            vget(e, rm);
            vop(e, S.xor);
        } else {
            // bitselect(a, b, c) = (a & c) | (b & ~c)
            const order: [3]u8 = switch (size) {
                1 => .{ rn, rm, rd },
                2 => .{ rn, rd, rm },
                else => .{ rd, rn, rm },
            };
            for (order) |r| vget(e, r);
            vop(e, S.bitselect);
        }
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0xbfff_fc00, 0x2e20_5800)) {
        b.get(L_CPU);
        vget(e, rn);
        vop(e, S.not);
        vput(e, rd, q);
        return true;
    }
    // three-same
    if (is(w, 0x9f20_0400, 0x0e20_0400)) {
        const opcode = bits(w, 11, 5);
        if (opcode >= 24) {
            const dp = size & 1 != 0;
            const fv = size & 2 != 0;
            const f: u32 = @intFromBool(dp);
            if (opcode == 27 and !U) {
                fmulx(e, rn, rm, dp);
                vput(e, rd, q);
                return true;
            }
            const op: u8 = switch (opcode) {
                26 => if (!U) (if (fv) S.fsub[f] else S.fadd[f]) else if (fv) S.fsub[f] else return false,
                27 => S.fmul[f],
                31 => if (U) S.fdiv[f] else return false,
                28 => if (!U) S.feq[f] else if (fv) S.fgt[f] else S.fge[f],
                30 => if (!U) (if (fv) S.fmin[f] else S.fmax[f]) else return false,
                else => return false,
            };
            b.get(L_CPU);
            vget(e, rn);
            vget(e, rm);
            vop(e, op);
            if (opcode == 26 and U) vop(e, S.fabs[f]);
            vput(e, rd, q);
            return true;
        }
        const op: ?u8 = switch (opcode) {
            16 => lane(if (U) S.sub else S.add, size),
            17 => if (U) lane(S.eq, size) else lane(S.ne, size),
            6 => lane(if (U) S.gt_u else S.gt_s, size),
            7 => lane(if (U) S.ge_u else S.ge_s, size),
            19 => if (U) null else lane(S.mul, size),
            18 => lane(S.mul, size),
            12 => lane(if (U) S.max_u else S.max_s, size),
            13 => lane(if (U) S.min_u else S.min_s, size),
            else => null,
        };
        const o = op orelse return false;
        b.get(L_CPU);
        if (opcode == 18) vget(e, rd);
        vget(e, rn);
        vget(e, rm);
        if (opcode == 17 and !U) {
            // CMTST: any bit in common
            vop(e, S.and_);
            vop(e, S.const_);
            for (0..16) |_| b.byte(0);
        }
        vop(e, o);
        if (opcode == 18) vop(e, lane(if (U) S.sub else S.add, size).?);
        vput(e, rd, q);
        return true;
    }
    // two-register misc
    if (is(w, 0x9f3e_0c00, 0x0e20_0800)) {
        const opcode = bits(w, 12, 5);
        const fv = size & 2 != 0;
        const dp = size & 1 != 0;
        const f: u32 = @intFromBool(dp);
        if (opcode >= 22 or (opcode >= 12 and opcode <= 15 and fv)) {
            const op: u8 = switch (opcode) {
                15 => if (fv) (if (U) S.fneg[f] else S.fabs[f]) else return false,
                31 => if (U) S.fsqrt[f] else return false,
                24 => if (U) return false else if (fv) S.fceil[f] else S.fnearest[f],
                25 => if (U) return false else if (fv) S.ftrunc[f] else S.ffloor[f],
                // the conversions: single lanes only, which wasm has
                29 => if (fv or dp) return false else if (U) S.f32x4_convert_i32x4_u else S.f32x4_convert_i32x4_s,
                27 => if (!fv or dp) return false else if (U) S.i32x4_trunc_sat_f32x4_u else S.i32x4_trunc_sat_f32x4_s,
                else => return false,
            };
            b.get(L_CPU);
            vget(e, rn);
            vop(e, op);
            vput(e, rd, q);
            return true;
        }
        if (opcode == 11) {
            const op: u8 = if (U) S.neg[size] else S.neg[size] - 1;
            b.get(L_CPU);
            vget(e, rn);
            vop(e, op);
            vput(e, rd, q);
            return true;
        }
        return false;
    }
    // shift by immediate: SSHR / USHR, SHL, SSHLL / USHLL
    if (is(w, 0x9f80_0400, 0x0f00_0400) and bits(w, 19, 4) != 0) {
        const immh = bits(w, 19, 4);
        const esz: u32 = if (immh & 8 != 0) 3 else if (immh & 4 != 0) 2 else if (immh & 2 != 0) 1 else 0;
        const bitsT: u32 = @as(u32, 8) << @intCast(esz);
        const opcode = bits(w, 11, 5);
        const amount = (immh << 3) | bits(w, 16, 3);
        const shr = 2 * bitsT - amount;
        if (opcode == 20) {
            // widen the low (or, Q, the high) half, then shift
            if (esz == 3) return false;
            b.get(L_CPU);
            vget(e, rn);
            vop(e, S.extend_low_s[esz] + @as(u8, if (q) 1 else 0) + @as(u8, if (U) 2 else 0));
            if (amount != bitsT) {
                b.i32c(@intCast(amount - bitsT));
                vop(e, S.shl[esz + 1]);
            }
            vmem(e, S.store, voff(rd));
            return true;
        }
        const op: u8 = switch (opcode) {
            0 => if (U) (if (shr >= bitsT) return false else S.shr_u[esz]) else S.shr_s[esz],
            10 => if (U) return false else S.shl[esz],
            else => return false,
        };
        b.get(L_CPU);
        vget(e, rn);
        b.i32c(@intCast(if (opcode == 10) amount - bitsT else @min(shr, bitsT - 1)));
        vop(e, op);
        vput(e, rd, q);
        return true;
    }
    // by element: FMUL, MUL
    if (is(w, 0x9f00_0400, 0x0f00_0000)) {
        const opcode = bits(w, 12, 4);
        const Lb = bits(w, 21, 1);
        const M = bits(w, 20, 1);
        const H = bits(w, 11, 1);
        const rmLow = bits(w, 16, 4);
        if (opcode == 9 and !U) {
            if (size & 2 == 0) return false;
            const dp = size & 1 != 0;
            if (dp and Lb != 0) return false;
            const idx = if (dp) H else (H << 1) | Lb;
            const f: u32 = @intFromBool(dp);
            b.get(L_CPU);
            vget(e, rn);
            vget(e, @intCast((M << 4) | rmLow));
            vop(e, S.fextract[f]);
            b.byte(@intCast(idx));
            vop(e, S.fsplat[f]);
            vop(e, S.fmul[f]);
            vput(e, rd, q);
            return true;
        }
        if (opcode == 8 and !U and (size == 1 or size == 2)) {
            const idx = if (size == 1) (H << 2) | (Lb << 1) | M else (H << 1) | Lb;
            const m: u8 = @intCast(if (size == 1) rmLow else (M << 4) | rmLow);
            b.get(L_CPU);
            vget(e, rn);
            vget(e, m);
            vop(e, S.extract_u[size]);
            b.byte(@intCast(idx));
            vop(e, S.splat[size]);
            vop(e, S.mul[size]);
            vput(e, rd, q);
            return true;
        }
        return false;
    }
    return false;
}
/// FMULX: the product, except that a zero times an infinity is ±2; leaves [cpu, v128]
fn fmulx(e: *Emit, rn: u8, rm: u8, dp: bool) void {
    const b = e.b;
    const f: u32 = @intFromBool(dp);
    const lanes: u32 = if (dp) 2 else 4;
    const zero = [_]u8{0} ** 16;
    var inf: [16]u8 = undefined;
    var sign: [16]u8 = undefined;
    var two: [16]u8 = undefined;
    for (0..lanes) |i| {
        if (dp) {
            @as(*align(1) u64, @ptrCast(&inf[8 * i])).* = 0x7ff0_0000_0000_0000;
            @as(*align(1) u64, @ptrCast(&sign[8 * i])).* = 0x8000_0000_0000_0000;
            @as(*align(1) u64, @ptrCast(&two[8 * i])).* = 0x4000_0000_0000_0000;
        } else {
            @as(*align(1) u32, @ptrCast(&inf[4 * i])).* = 0x7f80_0000;
            @as(*align(1) u32, @ptrCast(&sign[4 * i])).* = 0x8000_0000;
            @as(*align(1) u32, @ptrCast(&two[4 * i])).* = 0x4000_0000;
        }
    }
    b.get(L_CPU);
    // ±2 with the product's sign
    vget(e, rn);
    vget(e, rm);
    vop(e, S.xor);
    vop(e, S.const_);
    b.bytes(&sign);
    vop(e, S.and_);
    vop(e, S.const_);
    b.bytes(&two);
    vop(e, S.or_);
    // the product
    vget(e, rn);
    vget(e, rm);
    vop(e, S.fmul[f]);
    // where one operand is zero and the other infinite
    for ([_][2]*const [16]u8{ .{ &zero, &inf }, .{ &inf, &zero } }, 0..) |pair, i| {
        vget(e, rn);
        vop(e, S.fabs[f]);
        vop(e, S.const_);
        b.bytes(pair[0]);
        vop(e, S.feq[f]);
        vget(e, rm);
        vop(e, S.fabs[f]);
        vop(e, S.const_);
        b.bytes(pair[1]);
        vop(e, S.feq[f]);
        vop(e, S.and_);
        if (i == 1) vop(e, S.or_);
    }
    vop(e, S.bitselect);
}
/// LD1 / ST1 of one lane, and LD1R, of one register
fn emitVlane(e: *Emit, w: u32) bool {
    const b = e.b;
    const rt: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const q = bits(w, 30, 1);
    const Ld = bits(w, 22, 1) != 0;
    const post = bits(w, 23, 1) != 0;
    const opcode = bits(w, 13, 3);
    const Sb = bits(w, 12, 1);
    const size = bits(w, 10, 2);
    if (bits(w, 21, 1) != 0 or opcode & 1 != 0) return false;
    var esz: u32 = undefined;
    var idx: u32 = 0;
    if (opcode >= 6) {
        if (!Ld or Sb != 0) return false;
        esz = size;
    } else {
        const scale = opcode >> 1;
        esz = if (scale == 0) 0 else if (scale == 1) 1 else if (size & 1 != 0) 3 else 2;
        idx = switch (esz) {
            0 => (q << 3) | (Sb << 2) | size,
            1 => (q << 2) | (Sb << 1) | (size >> 1),
            2 => (q << 1) | Sb,
            else => q,
        };
    }
    e.getSP(rn);
    e.address();
    if (opcode >= 6) {
        b.get(L_CPU);
        b.get(jit.L_A);
        vmem(e, S.load8_splat + @as(u8, @intCast(esz)), 0);
        vput(e, rt, q != 0);
    } else if (Ld) {
        b.get(L_CPU);
        b.get(jit.L_A);
        vget(e, rt);
        vmem(e, S.load8_lane + @as(u8, @intCast(esz)), 0);
        b.byte(@intCast(idx));
        vmem(e, S.store, voff(rt));
    } else {
        e.storeCheck(0);
        b.get(jit.L_A);
        vget(e, rt);
        vmem(e, S.store8_lane + @as(u8, @intCast(esz)), 0);
        b.byte(@intCast(idx));
    }
    if (post) {
        e.getSP(rn);
        if (rm == 31) b.i64c(@as(i64, 1) << @intCast(esz)) else e.getX(rm);
        b.op(O.i64_add);
        e.setSP(rn);
    }
    return true;
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
    if (is(w, 0xbfbf0000, 0x0c000000) or is(w, 0xbfa00000, 0x0c800000)) return e.fallback(pc, k);
    if (is(w, 0xbf9f0000, 0x0d000000) or is(w, 0xbf800000, 0x0d800000)) {
        if (!emitVlane(e, w)) e.fallback(pc, k);
        return;
    }
    if (is(w, 0x3a000000, 0x28000000)) {
        const opc = bits(w, 30, 2);
        if (opc == 3) return e.fallback(pc, k);
        const Ld = bits(w, 22, 1) != 0;
        const width = @as(u32, 4) << @intCast(opc);
        const off: i64 = bt.sx(i64, bits(w, 15, 7), 7) * width;
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
        const imm9 = bt.sx(i64, bits(w, 12, 9), 9);
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
