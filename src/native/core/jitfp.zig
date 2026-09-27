const vreg = @import("jitreg.zig");
const jitvec = @import("jitvec.zig");
const jit = @import("jit.zig");
const simd = @import("simd.zig");
const wasm = @import("wasm.zig");
const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
const Emit = jit.Emit(true);
const O = wasm.Op;
const F = wasm.F;
const get = wasm.get;
const set = wasm.set;
const tee = wasm.tee;
const c32 = wasm.c32;
const c64 = wasm.c64;
const mo = wasm.mo;
const L_CPU = jit.L_CPU;
const L_A = jit.L_A;
const OFF_V = vreg.OFF_V;

const voff = vreg.voff;
const zeroTop = vreg.zeroTop;
fn getF(e: *Emit, n: u8, f: u1) void {
    e.b.emit(.{ get(L_CPU), mo(F.load[f], voff(n)) });
}
fn setF(e: *Emit, d: u8, f: u1) void {
    e.b.memop(F.store[f], voff(d));
    zeroTop(e, d, f == 1);
}
const ROUND = [_]u8{ 3, 0, 1, 2 };
const UNARY = [_][2]u8{ F.abs, F.neg, F.sqrt };
const BINARY = [_][2]u8{ F.mul, F.div, F.add, F.sub };
fn roundOp(f: u1, mode: u32) u8 {
    return F.ceil[f] + ROUND[mode & 3];
}

pub fn emitVfp(e: *jit.Emit(false), w: u32) bool {
    if (!is(w, 0x0f000e10, 0x0e000a00)) return false;
    const op = bits(w, 20, 4) & 0xb;
    const sub = w & 0x40 != 0;
    const unary = bits(w, 16, 4);
    const supported = switch (op) {
        0, 2, 3 => true,
        8 => !sub,
        11 => !sub or unary <= 1,
        else => false,
    };
    if (!supported) return false;
    const f: u1 = @intCast(bits(w, 8, 1));
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
    if (op == 0) b.emit(.{ get(L_CPU), mo(F.load[f], OFF_V + d * stride) });
    if (op != 11) b.emit(.{ get(L_CPU), mo(F.load[f], OFF_V + n * stride) });
    b.emit(.{ get(L_CPU), mo(F.load[f], OFF_V + m * stride) });
    switch (op) {
        0 => b.emit(.{ F.mul[f], if (sub) F.sub[f] else F.add[f] }),
        2 => { b.byte(F.mul[f]); if (sub) b.byte(F.neg[f]); },
        3 => b.byte(if (sub) F.sub[f] else F.add[f]),
        8 => b.byte(F.div[f]),
        else => if (unary == 1) b.byte(if (w & 0x80 != 0) F.sqrt[f] else F.neg[f]) else if (w & 0x80 != 0) b.byte(F.abs[f]),
    }
    b.memop(F.store[f], OFF_V + d * stride);
    return true;
}

pub fn emitVfpMemory(e: *jit.Emit(false), w: u32) bool {
    if (w & 0x0f200000 != 0x0d000000) return false;
    const cp = bits(w, 8, 4);
    if (cp != 10 and cp != 11) return false;
    const rn = bits(w, 16, 4);
    if (rn == 15) return false;
    const dp = cp == 11;
    const d = if (dp) (bits(w, 22, 1) << 4) | bits(w, 12, 4) else (bits(w, 12, 4) << 1) | bits(w, 22, 1);
    const slot = if (dp) d * 2 else d;
    const offset = (w & 255) * 4;
    const load_mem = bits(w, 20, 1) != 0;
    const b = e.b;
    b.emit(.{ get(jit.L_X + rn), c32(@intCast(offset)), if (bits(w, 23, 1) != 0) O.i32_add else O.i32_sub, set(L_A) });
    e.checkLowAddress();
    for (0..(if (dp) @as(usize, 2) else 1)) |i| {
        const off: u32 = @intCast(i * 4);
        const reg_off = OFF_V + slot * 4 + off;
        if (load_mem) {
            b.emit(.{ get(L_CPU), get(L_A), mo(O.i32_load, off), mo(O.i32_store, reg_off) });
        } else {
            e.storeCheck(off, 4);
            b.emit(.{ get(L_A), get(L_CPU), mo(O.i32_load, reg_off), mo(O.i32_store, off) });
        }
    }
    return true;
}

pub fn emitSimd(e: *Emit, w: u32, pc: u32, k: u32) void {
    if (!is(w, 0x5000_0000, 0x1000_0000)) {
        const rd: u8 = @intCast(w & 31);
        e.vcachedWrite = false;
        if (!jitvec.emitVector(e, w)) e.fallback(pc, k);
        if (!e.vcachedWrite) e.vloaded &= ~bt.bit(rd);
        return;
    }
    e.vloaded = 0;
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
