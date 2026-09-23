const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const simd = @import("simd.zig");
const wasm = @import("wasm.zig");
const a64 = @import("a64.zig");
const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
const Emit = jit.Emit(true);
const O = wasm.Op;
const F = wasm.F;
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
const L_A = jit.L_A;
const L_B = jit.L_B;
const OFF_V = @offsetOf(cpu.Cpu, "v");

inline fn voff(n: u8) u32 {
    return OFF_V + 16 * @as(u32, n);
}
fn getF(e: *Emit, n: u8, f: u1) void {
    e.b.emit(.{ get(L_CPU), mo(F.load[f], voff(n)) });
}
fn setF(e: *Emit, d: u8, f: u1) void {
    e.b.memop(F.store[f], voff(d));
    zeroTop(e, d, f == 1);
}
fn zeroTop(e: *Emit, d: u8, from8: bool) void {
    if (!from8) e.b.emit(.{ get(L_CPU), c32(0), mo(O.i32_store, voff(d) + 4) });
    e.b.emit(.{ get(L_CPU), c64(0), mo(O.i64_store, voff(d) + 8) });
}
const ROUND = [_]u8{ 3, 0, 1, 2 };
const UNARY = [_][2]u8{ F.abs, F.neg, F.sqrt };
const BINARY = [_][2]u8{ F.mul, F.div, F.add, F.sub };
fn roundOp(f: u1, mode: u32) u8 {
    return F.ceil[f] + ROUND[mode & 3];
}

pub fn emitSimd(e: *Emit, w: u32, pc: u32, k: u32) void {
    if (!is(w, 0x5000_0000, 0x1000_0000)) {
        if (!emitVector(e, w)) e.fallback(pc, k);
        return;
    }
    const ftype = bits(w, 22, 2);
    if (w & 0x2000_0000 != 0 or ftype > 1) return e.fallback(pc, k);
    const b = e.b;
    const f: u1 = @intCast(ftype);
    const dp = f == 1;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const sf = w >> 31 != 0;
    if (is(w, 0x5f20_fc00, 0x1e20_0000)) {
        const rmode = bits(w, 19, 2);
        const opcode = bits(w, 16, 3);
        if (opcode >= 6) {
            if (rmode != 0 or dp != sf) return e.fallback(pc, k);
            if (opcode == 6) {
                b.emit(.{ get(L_CPU), mo(jit.LD[if (sf) 3 else 2][0], voff(rn)) });
                e.setX(rd);
            } else {
                b.get(L_CPU);
                e.getX(rn);
                if (!sf) b.byte(O.i32_wrap_i64);
                b.memop(F.istore[f], voff(rd));
                zeroTop(e, rd, sf);
            }
            return;
        }
        if (opcode == 2 or opcode == 3) {
            b.get(L_CPU);
            e.getX(rn);
            if (!sf) b.byte(O.i32_wrap_i64);
            b.byte(F.convert_i32_s[f] + @as(u8, if (sf) 2 else 0) + @as(u8, if (opcode == 3) 1 else 0));
            setF(e, rd, f);
            return;
        }
        if (opcode >= 4) return e.fallback(pc, k);
        getF(e, rn, f);
        b.emit(.{ roundOp(f, rmode), O.fc_prefix });
        b.u((if (sf) @as(u32, 4) else 0) + (if (dp) @as(u32, 2) else 0) + (opcode & 1));
        if (sf) e.setX(rd) else e.setW(rd);
        return;
    }
    if (is(w, 0x5f20_0000, 0x1e00_0000) or sf) return e.fallback(pc, k);
    if (is(w, 0x5f20_7c00, 0x1e20_4000)) {
        const opcode = bits(w, 15, 6);
        switch (opcode) {
            0, 1, 2, 3 => {
                b.get(L_CPU);
                getF(e, rn, f);
                if (opcode != 0) b.byte(UNARY[opcode - 1][f]);
                setF(e, rd, f);
            },
            4, 5 => {
                if ((opcode == 4) != dp) return e.fallback(pc, k);
                b.get(L_CPU);
                getF(e, rn, f);
                b.byte(F.cvt[f]);
                setF(e, rd, f ^ 1);
            },
            8, 9, 10, 11 => {
                b.get(L_CPU);
                getF(e, rn, f);
                b.byte(roundOp(f, opcode - 8));
                setF(e, rd, f);
            },
            else => e.fallback(pc, k),
        }
        return;
    }
    if (is(w, 0x5f20_3c00, 0x1e20_2000)) {
        if (w & 7 != 0) return e.fallback(pc, k);
        fcmp(e, rn, if (w & 8 != 0) null else rm, f);
        return;
    }
    if (is(w, 0x5f20_1c00, 0x1e20_1000)) {
        const imm = simd.vfpImm(bits(w, 13, 8), dp);
        b.get(L_CPU);
        if (dp) b.i64c(@bitCast(imm)) else b.i32c(@bitCast(@as(u32, @truncate(imm))));
        b.memop(F.istore[f], voff(rd));
        zeroTop(e, rd, dp);
        return;
    }
    if (is(w, 0x5f20_0c00, 0x1e20_0400)) {
        e.cond(@intCast(bits(w, 12, 4)));
        b.blockStart(O.if_, wasm.VOID);
        fcmp(e, rn, rm, f);
        b.byte(O.else_);
        for (jit.L_N..jit.L_V + 1, 0..) |l, i| b.emit(.{ c32(@intCast((w >> @intCast(3 - i)) & 1)), set(@intCast(l)) });
        b.byte(O.end);
        return;
    }
    if (is(w, 0x5f20_0c00, 0x1e20_0800)) {
        const opcode = bits(w, 12, 4);
        if (opcode > 8) return e.fallback(pc, k);
        b.get(L_CPU);
        getF(e, rn, f);
        getF(e, rm, f);
        switch (opcode) {
            0, 1, 2, 3 => b.byte(BINARY[opcode][f]),
            8 => b.emit(.{ F.mul[f], F.neg[f] }),
            else => b.call(jit.F_FMAX32 + 4 * @as(u32, f) + (opcode - 4)),
        }
        setF(e, rd, f);
        return;
    }
    if (is(w, 0x5f20_0c00, 0x1e20_0c00)) {
        b.emit(.{ get(L_CPU), get(L_CPU), mo(F.iload[f], voff(rn)), get(L_CPU), mo(F.iload[f], voff(rm)) });
        e.cond(@intCast(bits(w, 12, 4)));
        b.emit(.{ O.select, mo(F.istore[f], voff(rd)) });
        zeroTop(e, rd, dp);
        return;
    }
    if (is(w, 0x5f00_0000, 0x1f00_0000)) {
        const o1 = bits(w, 21, 1) != 0;
        const o0 = bits(w, 15, 1) != 0;
        b.get(L_CPU);
        getF(e, rn, f);
        if (o1 != o0) b.byte(F.neg[f]);
        if (!dp) b.byte(O.f64_promote_f32);
        getF(e, rm, f);
        if (!dp) b.emit(.{ O.f64_promote_f32, O.f64_mul });
        getF(e, @intCast(bits(w, 10, 5)), f);
        if (o1) b.byte(F.neg[f]);
        if (dp) b.call(jit.F_FMA64) else b.emit(.{ O.f64_promote_f32, O.f64_add, O.f32_demote_f64 });
        setF(e, rd, f);
        return;
    }
    e.fallback(pc, k);
}
fn fcmp(e: *Emit, rn: u8, rm: ?u8, f: u1) void {
    const b = e.b;
    e.eager(15);
    getF(e, rn, f);
    if (f == 0) b.byte(O.f64_promote_f32);
    b.set(jit.L_F0);
    if (rm) |m| {
        getF(e, m, f);
        if (f == 0) b.byte(O.f64_promote_f32);
    } else b.f64c(0);
    b.emit(.{ set(jit.L_F1), get(jit.L_F0), get(jit.L_F1), O.f64_lt, tee(jit.L_N), O.i32_eqz, set(jit.L_C), get(jit.L_F0), get(jit.L_F1), O.f64_eq, set(jit.L_Z), get(jit.L_F0), get(jit.L_F0), O.f64_ne, get(jit.L_F1), get(jit.L_F1), O.f64_ne, O.i32_or, set(jit.L_V) });
}

fn vget(e: *Emit, n: u8) void {
    e.b.emit(.{ get(L_CPU), vm(S.load, voff(n)) });
}
fn vput(e: *Emit, d: u8, q: bool) void {
    if (q) return e.b.emit(.{vm(S.store, voff(d))});
    e.b.emit(.{ vm(S.store64_lane, voff(d)), 0, get(L_CPU), c64(0), mo(O.i64_store, voff(d) + 8) });
}
fn shuffle(e: *Emit, rn: u8, rm: u8, lanes: *const [16]u8) void {
    e.b.get(L_CPU);
    vget(e, rn);
    vget(e, rm);
    e.b.emit(.{sv(S.shuffle)});
    e.b.bytes(lanes);
}
inline fn narrowByte(k: usize, es: usize) usize {
    return (k / es) * 2 * es + k % es;
}
fn lane(tab: [4]u8, esz: u32) ?u8 {
    return if (tab[esz] == 0) null else tab[esz];
}
fn emitVector(e: *Emit, w: u32) bool {
    const b = e.b;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const q = bits(w, 30, 1) != 0;
    const U = bits(w, 29, 1) != 0;
    const size = bits(w, 22, 2);
    if (w & 0x1000_0000 != 0) return false;
    if (is(w, 0x9ff8_0400, 0x0f00_0400)) {
        const cmode = bits(w, 12, 4);
        const ex = simd.expandImm(bits(w, 29, 1), cmode, bits(w, 11, 1), (bits(w, 16, 3) << 5) | bits(w, 5, 5)) orelse return false;
        if (ex.kind == .fmov and U and !q) return false;
        const v: i64 = @bitCast(ex.v);
        for ([_]u32{ 0, 8 }) |off| {
            b.get(L_CPU);
            if (off == 8 and !q) b.i64c(0) else switch (ex.kind) {
                .orr, .bic => b.emit(.{ get(L_CPU), mo(O.i64_load, voff(rd) + off), c64(if (ex.kind == .orr) v else ~v), if (ex.kind == .orr) O.i64_or else O.i64_and }),
                .mvni => b.i64c(~v),
                else => b.i64c(v),
            }
            b.memop(O.i64_store, voff(rd) + off);
        }
        return true;
    }
    if (is(w, 0x9fe0_8400, 0x0e00_0400)) {
        const imm5 = bits(w, 16, 5);
        const imm4 = bits(w, 11, 4);
        if (imm5 & 15 == 0) return false;
        const esz: u32 = @ctz(imm5);
        const idx: u8 = @intCast(imm5 >> @intCast(esz + 1));
        if (U) {
            b.get(L_CPU);
            vget(e, rd);
            vget(e, rn);
            b.emit(.{ sv(S.extract_u[esz]), @as(u8, @intCast(imm4 >> @intCast(esz))), sv(S.replace[esz]), idx, vm(S.store, voff(rd)) });
            return true;
        }
        switch (imm4) {
            0 => {
                b.get(L_CPU);
                vget(e, rn);
                b.emit(.{ sv(S.extract_u[esz]), idx, sv(S.splat[esz]) });
                vput(e, rd, q);
            },
            1 => {
                b.get(L_CPU);
                e.getX(rn);
                if (esz < 3) b.byte(O.i32_wrap_i64);
                b.emit(.{sv(S.splat[esz])});
                vput(e, rd, q);
            },
            3 => {
                b.get(L_CPU);
                vget(e, rd);
                e.getX(rn);
                if (esz < 3) b.byte(O.i32_wrap_i64);
                b.emit(.{ sv(S.replace[esz]), idx, vm(S.store, voff(rd)) });
            },
            5, 7 => {
                if (esz == 3 and !q) return false;
                vget(e, rn);
                b.emit(.{ sv(if (imm4 == 5) S.extract_s[esz] else S.extract_u[esz]), idx });
                if (esz == 3) {
                    e.setX(rd);
                } else if (q) {
                    b.byte(if (imm4 == 5) O.i64_extend_i32_s else O.i64_extend_i32_u);
                    e.setX(rd);
                } else e.setW(rd);
            },
            else => return false,
        }
        return true;
    }
    if (is(w, 0xbfe0_8400, 0x2e00_0000)) {
        const imm = bits(w, 11, 4);
        if (!q and imm > 7) return false;
        var lanes: [16]u8 = undefined;
        for (0..16) |i| {
            const j = imm + i;
            lanes[i] = @intCast(if (q or j < 8) j else 8 + j);
        }
        shuffle(e, rn, rm, &lanes);
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0xbf20_8c00, 0x0e00_0800)) {
        const opcode = bits(w, 12, 3);
        if (opcode == 0 or opcode == 4 or (size == 3 and !q)) return false;
        const es: usize = @as(usize, 1) << @intCast(size);
        const count: usize = (if (q) @as(usize, 16) else 8) / es;
        var lanes: [16]u8 = [_]u8{0} ** 16;
        for (0..count) |el| {
            const src = simd.permuteIndex(opcode, count, el);
            for (0..es) |k| lanes[el * es + k] = @intCast((if (src.m) @as(usize, 16) else 0) + src.i * es + k);
        }
        shuffle(e, rn, rm, &lanes);
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0x9f20_fc00, 0x0e20_1c00)) {
        b.get(L_CPU);
        if (!U) {
            vget(e, rn);
            vget(e, rm);
            switch (size) {
                0 => b.emit(.{sv(S.and_)}),
                1 => b.emit(.{sv(S.andnot)}),
                2 => b.emit(.{sv(S.or_)}),
                else => b.emit(.{ sv(S.not), sv(S.or_) }),
            }
        } else if (size == 0) {
            vget(e, rn);
            vget(e, rm);
            b.emit(.{sv(S.xor)});
        } else {
            const order: [3]u8 = switch (size) {
                1 => .{ rn, rm, rd },
                2 => .{ rn, rd, rm },
                else => .{ rd, rn, rm },
            };
            for (order) |r| vget(e, r);
            b.emit(.{sv(S.bitselect)});
        }
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0xbfff_fc00, 0x2e20_5800)) {
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{sv(S.not)});
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0x9f20_0c00, 0x0e20_0000) and size < 3) {
        const opcode = bits(w, 12, 4);
        if (opcode > 3 and opcode != 8 and opcode != 10 and opcode != 12) return false;
        const extend = S.extend_low_s[size] + @as(u8, if (q) 1 else 0) + @as(u8, if (U) 2 else 0);
        const accumulate = opcode == 8 or opcode == 10;
        b.get(L_CPU);
        if (accumulate) vget(e, rd);
        vget(e, rn);
        if (opcode != 1 and opcode != 3) b.emit(.{sv(extend)});
        vget(e, rm);
        b.emit(.{ sv(extend), sv(if (opcode >= 8) S.mul[size + 1] else if (opcode >= 2) S.sub[size + 1] else S.add[size + 1]) });
        if (accumulate) b.emit(.{sv(if (opcode == 10) S.sub[size + 1] else S.add[size + 1])});
        vput(e, rd, true);
        return true;
    }
    if (is(w, 0x9f20_0400, 0x0e20_0400)) {
        const opcode = bits(w, 11, 5);
        if (opcode == 8 and U and size == 1) {
            for (0..(if (q) @as(usize, 8) else 4)) |i| {
                vget(e, rm);
                b.emit(.{ sv(S.extract_s[0]), @as(u8, @intCast(i * 2)), set(L_A) });
                vget(e, rn);
                b.emit(.{ sv(S.extract_u[1]), @as(u8, @intCast(i)), set(L_B) });
                b.emit(.{ get(L_CPU), get(L_CPU), vm(S.load, voff(rd)), get(L_B), get(L_A), O.i32_shl,
                    get(L_B), c32(0), get(L_A), O.i32_sub, O.i32_shr_u,
                    get(L_A), c32(0), O.i32_ge_s, O.select,
                    c32(0), get(L_A), c32(-16), O.i32_gt_s, get(L_A), c32(16), O.i32_lt_s, O.i32_and, O.select,
                    sv(S.replace[1]), @as(u8, @intCast(i)), vm(S.store, voff(rd)) });
            }
            if (!q) zeroTop(e, rd, true);
            return true;
        }
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
            b.emit(.{sv(op)});
            if (opcode == 26 and U) b.emit(.{sv(S.fabs[f])});
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
            b.emit(.{ sv(S.and_), sv(S.const_) });
            b.bytes(&[_]u8{0} ** 16);
        }
        b.emit(.{sv(o)});
        if (opcode == 18) b.emit(.{sv(lane(if (U) S.sub else S.add, size).?)});
        vput(e, rd, q);
        return true;
    }
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
                29 => if (fv or dp) return false else if (U) S.f32x4_convert_i32x4_u else S.f32x4_convert_i32x4_s,
                27 => if (!fv or dp) return false else if (U) S.i32x4_trunc_sat_f32x4_u else S.i32x4_trunc_sat_f32x4_s,
                else => return false,
            };
            b.get(L_CPU);
            vget(e, rn);
            b.emit(.{sv(op)});
            vput(e, rd, q);
            return true;
        }
        if (opcode == 11) {
            b.get(L_CPU);
            vget(e, rn);
            b.emit(.{sv(if (U) S.neg[size] else S.neg[size] - 1)});
            vput(e, rd, q);
            return true;
        }
        const es: usize = @as(usize, 1) << @intCast(size);
        var lanes: [16]u8 = undefined;
        if (opcode <= 1) {
            const group: usize = if (opcode == 1) 2 else if (U) 4 else 8;
            if (es >= group) return false;
            const per = group / es;
            for (0..16) |i| {
                const el = i / es;
                const r = el % per;
                lanes[i] = @intCast((el - r + (per - 1 - r)) * es + i % es);
            }
            shuffle(e, rn, rn, &lanes);
            vput(e, rd, q);
            return true;
        }
        if (opcode == 18 and !U and size != 3) {
            for (0..16) |i| lanes[i] = @intCast(if (i < 8) (if (q) 16 + i else narrowByte(i, es)) else if (q) narrowByte(i - 8, es) else 0);
            shuffle(e, rn, rd, &lanes);
            vput(e, rd, q);
            return true;
        }
        if (opcode == 22 and !U and size == 1) {
            b.get(L_CPU);
            vget(e, rn);
            b.emit(.{sv(S.f32x4_demote_f64x2_zero)});
            if (q) {
                for (0..16) |i| lanes[i] = @intCast(if (i < 8) 16 + i else i - 8);
                vget(e, rd);
                b.emit(.{sv(S.shuffle)});
                b.bytes(&lanes);
            }
            vput(e, rd, q);
            return true;
        }
        return false;
    }
    if (is(w, 0x9f80_0400, 0x0f00_0400) and bits(w, 19, 4) != 0) {
        const immh = bits(w, 19, 4);
        const esz: u32 = if (immh & 8 != 0) 3 else if (immh & 4 != 0) 2 else if (immh & 2 != 0) 1 else 0;
        const bitsT: u32 = @as(u32, 8) << @intCast(esz);
        const opcode = bits(w, 11, 5);
        const amount = (immh << 3) | bits(w, 16, 3);
        const shr = 2 * bitsT - amount;
        if (opcode == 20) {
            if (esz == 3) return false;
            b.get(L_CPU);
            vget(e, rn);
            b.emit(.{sv(S.extend_low_s[esz] + @as(u8, if (q) 1 else 0) + @as(u8, if (U) 2 else 0))});
            if (amount != bitsT) b.emit(.{ c32(@intCast(amount - bitsT)), sv(S.shl[esz + 1]) });
            b.emit(.{vm(S.store, voff(rd))});
            return true;
        }
        const op: u8 = switch (opcode) {
            0 => if (U) (if (shr >= bitsT) return false else S.shr_u[esz]) else S.shr_s[esz],
            10 => if (U) return false else S.shl[esz],
            else => return false,
        };
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{ c32(@intCast(if (opcode == 10) amount - bitsT else @min(shr, bitsT - 1))), sv(op) });
        vput(e, rd, q);
        return true;
    }
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
            const idx: u8 = @intCast(if (dp) H else (H << 1) | Lb);
            const f: u32 = @intFromBool(dp);
            b.get(L_CPU);
            vget(e, rn);
            vget(e, @intCast((M << 4) | rmLow));
            b.emit(.{ sv(S.fextract[f]), idx, sv(S.fsplat[f]), sv(S.fmul[f]) });
            vput(e, rd, q);
            return true;
        }
        if (opcode == 8 and !U and (size == 1 or size == 2)) {
            const idx: u8 = @intCast(if (size == 1) (H << 2) | (Lb << 1) | M else (H << 1) | Lb);
            const m: u8 = @intCast(if (size == 1) rmLow else (M << 4) | rmLow);
            b.get(L_CPU);
            vget(e, rn);
            vget(e, m);
            b.emit(.{ sv(S.extract_u[size]), idx, sv(S.splat[size]), sv(S.mul[size]) });
            vput(e, rd, q);
            return true;
        }
        if ((opcode == 2 or opcode == 6 or opcode == 10) and (size == 1 or size == 2)) {
            const idx: u8 = @intCast(if (size == 1) (H << 2) | (Lb << 1) | M else (H << 1) | Lb);
            const m: u8 = @intCast(if (size == 1) rmLow else (M << 4) | rmLow);
            const extend = S.extend_low_s[size] + @as(u8, if (U) 2 else 0);
            b.get(L_CPU);
            if (opcode != 10) vget(e, rd);
            vget(e, rn);
            b.emit(.{sv(extend + @as(u8, if (q) 1 else 0))});
            vget(e, m);
            b.emit(.{ sv(S.extract_u[size]), idx, sv(S.splat[size]), sv(extend), sv(S.mul[size + 1]) });
            if (opcode != 10) b.emit(.{sv(if (opcode == 6) S.sub[size + 1] else S.add[size + 1])});
            vput(e, rd, true);
            return true;
        }
        return false;
    }
    return false;
}
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
    vget(e, rn);
    vget(e, rm);
    b.emit(.{ sv(S.xor), sv(S.const_) });
    b.bytes(&sign);
    b.emit(.{ sv(S.and_), sv(S.const_) });
    b.bytes(&two);
    b.emit(.{sv(S.or_)});
    vget(e, rn);
    vget(e, rm);
    b.emit(.{sv(S.fmul[f])});
    for ([_][2]*const [16]u8{ .{ &zero, &inf }, .{ &inf, &zero } }, 0..) |pair, i| {
        vget(e, rn);
        b.emit(.{ sv(S.fabs[f]), sv(S.const_) });
        b.bytes(pair[0]);
        b.emit(.{sv(S.feq[f])});
        vget(e, rm);
        b.emit(.{ sv(S.fabs[f]), sv(S.const_) });
        b.bytes(pair[1]);
        b.emit(.{ sv(S.feq[f]), sv(S.and_) });
        if (i == 1) b.emit(.{sv(S.or_)});
    }
    b.emit(.{sv(S.bitselect)});
}
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
    const regs = 1 + bits(w, 21, 1) + (opcode & 1) * 2;
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
    for (0..regs) |i| {
        const t: u8 = @intCast((rt + i) & 31);
        const off: u32 = @as(u32, @intCast(i)) << @intCast(esz);
        if (opcode >= 6) {
            b.emit(.{ get(L_CPU), get(L_A), vm(S.load8_splat + @as(u8, @intCast(esz)), off) });
            vput(e, t, q != 0);
        } else if (Ld) {
            b.emit(.{ get(L_CPU), get(L_A) });
            vget(e, t);
            b.emit(.{ vm(S.load8_lane + @as(u8, @intCast(esz)), off), @as(u8, @intCast(idx)), vm(S.store, voff(t)) });
        } else {
            e.storeCheck(off, @as(u32, 1) << @intCast(esz));
            b.get(L_A);
            vget(e, t);
            b.emit(.{ vm(S.store8_lane + @as(u8, @intCast(esz)), off), @as(u8, @intCast(idx)) });
        }
    }
    if (post) {
        e.getSP(rn);
        if (rm == 31) b.i64c(@as(i64, @intCast(regs)) << @intCast(esz)) else e.getX(rm);
        b.byte(O.i64_add);
        e.setSP(rn);
    }
    return true;
}

fn vload(e: *Emit, t: u8, off: u32, sz: u32) void {
    const b = e.b;
    b.emit(.{ get(L_CPU), get(L_A), mo(jit.LD[@min(sz, 3)][0], off), mo(O.i64_store, voff(t)), get(L_CPU) });
    if (sz == 4) b.emit(.{ get(L_A), mo(O.i64_load, off + 8) }) else b.i64c(0);
    b.memop(O.i64_store, voff(t) + 8);
}
fn vstore(e: *Emit, t: u8, off: u32, sz: u32) void {
    e.storeCheck(off, @as(u32, 1) << @intCast(sz));
    e.b.emit(.{ get(L_A), get(L_CPU), mo(O.i64_load, voff(t)), mo(jit.ST[@min(sz, 3)], off) });
    if (sz == 4) e.b.emit(.{ get(L_A), get(L_CPU), mo(O.i64_load, voff(t) + 8), mo(O.i64_store, off + 8) });
}
pub fn emitVldrlit(e: *Emit, o: *const a64.Op) void {
    const a: u32 = @truncate(o.imm);
    const sz: u32 = 2 + o.b;
    e.b.emit(.{ get(L_CPU), c32(0), mo(jit.LD[@min(sz, 3)][0], a), mo(O.i64_store, voff(o.rd)), get(L_CPU) });
    if (sz == 4) e.b.emit(.{ c32(0), mo(O.i64_load, a + 8) }) else e.b.i64c(0);
    e.b.memop(O.i64_store, voff(o.rd) + 8);
}
pub fn emitVmem(e: *Emit, w: u32, pc: u32, k: u32) void {
    const b = e.b;
    const rt: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    if (is(w, 0xbfbf0000, 0x0c000000) or is(w, 0xbfa00000, 0x0c800000)) {
        const regs: u32 = switch (bits(w, 12, 4)) {
            7 => 1,
            10 => 2,
            6 => 3,
            2 => 4,
            else => return e.fallback(pc, k),
        };
        const sz: u32 = 3 + bits(w, 30, 1);
        const width = @as(u32, 1) << @intCast(sz);
        e.getSP(rn);
        e.address();
        for (0..regs) |i| {
            const t: u8 = @intCast((rt + i) & 31);
            const off = @as(u32, @intCast(i)) * width;
            if (bits(w, 22, 1) != 0) vload(e, t, off, sz) else vstore(e, t, off, sz);
        }
        if (bits(w, 23, 1) != 0) {
            e.getSP(rn);
            if (rm == 31) b.i64c(regs * width) else e.getX(rm);
            b.byte(O.i64_add);
            e.setSP(rn);
        }
        return;
    }
    if (is(w, 0xbf9f0000, 0x0d000000) or is(w, 0xbf800000, 0x0d800000)) {
        if (!emitVlane(e, w)) e.fallback(pc, k);
        return;
    }
    if (is(w, 0x3a000000, 0x28000000)) {
        const opc = bits(w, 30, 2);
        if (opc == 3) return e.fallback(pc, k);
        const Ld = bits(w, 22, 1) != 0;
        const sz = 2 + opc;
        const width = @as(u32, 1) << @intCast(sz);
        const off: i64 = bt.sx(i64, bits(w, 15, 7), 7) * width;
        const kind = bits(w, 23, 2);
        const rt2: u8 = @intCast(bits(w, 10, 5));
        e.getSP(rn);
        if (kind != 1 and off != 0) b.emit(.{ c64(off), O.i64_add });
        e.address();
        if (kind == 1 or kind == 3) {
            e.getSP(rn);
            b.emit(.{ c64(off), O.i64_add });
            e.setSP(rn);
        }
        if (Ld) {
            vload(e, rt, 0, sz);
            vload(e, rt2, width, sz);
        } else {
            vstore(e, rt, 0, sz);
            vstore(e, rt2, width, sz);
        }
        return;
    }
    const size = bits(w, 30, 2);
    const opc = bits(w, 22, 2);
    if (opc & 2 != 0 and size != 0) return e.fallback(pc, k);
    const scale: u32 = if (opc & 2 != 0) 4 else size;
    const unsigned = is(w, 0x3b000000, 0x39000000);
    const reg = is(w, 0x3b200c00, 0x38200800);
    const kind = if (unsigned or reg) 0 else bits(w, 10, 2);
    if (kind == 2) return e.fallback(pc, k);
    e.getSP(rn);
    var post: i64 = 0;
    if (unsigned) {
        const imm = bits(w, 10, 12) << @intCast(scale);
        if (imm != 0) b.emit(.{ c64(imm), O.i64_add });
    } else if (reg) {
        e.getX(rm);
        switch (bits(w, 13, 3)) {
            2 => b.emit(.{ c64(0xffff_ffff), O.i64_and }),
            6 => b.byte(O.i64_extend32_s),
            else => {},
        }
        if (bits(w, 12, 1) != 0 and scale != 0) b.emit(.{ c64(scale), O.i64_shl });
        b.byte(O.i64_add);
    } else {
        const imm9 = bt.sx(i64, bits(w, 12, 9), 9);
        if (kind == 1) post = imm9 else if (imm9 != 0) b.emit(.{ c64(imm9), O.i64_add });
    }
    if (kind == 3) {
        b.tee(jit.L_T0);
        e.setSP(rn);
        b.get(jit.L_T0);
    }
    e.address();
    if (post != 0) {
        e.getSP(rn);
        b.emit(.{ c64(post), O.i64_add });
        e.setSP(rn);
    }
    if (opc & 1 != 0) vload(e, rt, 0, scale) else vstore(e, rt, 0, scale);
}
