// The ARM32 half of the JIT: A32 and Thumb-1 regions on jit.zig's machinery, with the registers
// in i32 locals. Every exit returns an interworking target (the T bit in bit 0), which is what
// the dispatcher's bx expects; a Thumb region therefore leaves with pc | 1. What is not inlined
// here spills and calls arm.step for that one instruction.

const abi = @import("abi.zig");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const wasm = @import("wasm.zig");
const Emit = jit.Emit;
const Region = jit.Region;
const O = wasm.Op;

inline fn bits(w: u32, lo: u5, n: u6) u32 {
    return (w >> lo) & (@as(u32, 0xffff_ffff) >> @intCast(32 - @as(u32, n)));
}
inline fn sx(v: u32, n: u5) i32 {
    const sh: u5 = @intCast(32 - @as(u32, n));
    return @as(i32, @bitCast(v << sh)) >> sh;
}

pub const Scan = struct { len: u32, ends: bool };

/// one A32 instruction's shape for region discovery
pub fn scanArm(r: *Region, i: u32, pc: u32) Scan {
    const w = mem.ld32(pc);
    const cc = w >> 28;
    const next = pc + 4;
    const b = &r.blocks[i];
    if (cc == 15) return .{ .len = 4, .ends = (w & 0x0e000000) == 0x0a000000 };
    const top = bits(w, 25, 3);
    const rd = bits(w, 12, 4);
    var ends = false;
    switch (top) {
        5 => {
            if (w & (1 << 24) == 0) b.taken = jit.blockFor(r, pc +% 8 +% @as(u32, @bitCast(@as(i32, @bitCast(w << 8)) >> 6)));
            ends = true;
        },
        0, 1 => {
            if (top == 0 and ((w & 0x0ff000f0) == 0x01200010 or (w & 0x0ff000f0) == 0x01200030 or (w & 0x0ff000f0) == 0x01200070)) ends = true;
            if (top == 0 and (w & 0x0e000090) == 0x00000090 and rd == 15 and w & (1 << 20) != 0) ends = true;
            const dp = !((w & 0x0f0000f0) == 0x00000090 and top == 0) and !((w & 0x0db0f000) == 0x0120f000) and !((w & 0x0fb00000) == 0x03000000 and top == 1);
            const o = bits(w, 21, 4);
            if (dp and rd == 15 and !(o >= 8 and o <= 11) and (w & 0x0ff000f0) != 0x01200010 and (w & 0x0fff0ff0) != 0x016f0f10 and (w & 0x0fbf0fff) != 0x010f0000) ends = true;
        },
        2, 3 => if (!(top == 3 and w & 0x10 != 0) and rd == 15 and w & (1 << 20) != 0) {
            ends = true;
        },
        4 => if (w & 0x8000 != 0 and w & (1 << 20) != 0) {
            ends = true;
        },
        7 => if (w & (1 << 24) != 0) {
            ends = true;
        },
        else => {},
    }
    if (ends and cc != 14) b.fall = if (next & (abi.PAGE_SIZE - 1) != 0) jit.blockFor(r, next) else -1;
    return .{ .len = 4, .ends = ends };
}
pub fn scanThumb(r: *Region, i: u32, pc: u32) Scan {
    const h: u32 = mem.ptr(u16, pc).*;
    const b = &r.blocks[i];
    const next = pc + 2;
    switch (h >> 12) {
        4 => if ((h & 0xfc00) == 0x4400) {
            const o = (h >> 8) & 3;
            const d = (h & 7) | ((h >> 4) & 8);
            if (o == 3 or ((o == 0 or o == 2) and d == 15)) return .{ .len = 2, .ends = true };
        },
        11 => {
            if ((h & 0xfe00) == 0xbc00 and h & 0x100 != 0) return .{ .len = 2, .ends = true };
            if ((h & 0xff00) == 0xbe00) return .{ .len = 2, .ends = true };
            if ((h & 0xf500) == 0xb100) {
                b.taken = jit.blockFor(r, pc + 4 + ((h >> 3) & 31) * 2 + ((h & 0x200) >> 3));
                b.fall = if (next & (abi.PAGE_SIZE - 1) != 0) jit.blockFor(r, next) else -1;
                return .{ .len = 2, .ends = true };
            }
        },
        13 => {
            const cc = (h >> 8) & 15;
            if (cc >= 14) return .{ .len = 2, .ends = true };
            b.taken = jit.blockFor(r, pc +% 4 +% @as(u32, @bitCast(sx(h & 255, 8) * 2)));
            b.fall = if (next & (abi.PAGE_SIZE - 1) != 0) jit.blockFor(r, next) else -1;
            return .{ .len = 2, .ends = true };
        },
        14 => {
            if (h & (1 << 11) != 0) return .{ .len = 2, .ends = true };
            b.taken = jit.blockFor(r, pc +% 4 +% @as(u32, @bitCast(sx(h & 0x7ff, 11) * 2)));
            return .{ .len = 2, .ends = true };
        },
        15 => return .{ .len = if ((h & 0xf800) == 0xf000) 4 else 2, .ends = true },
        else => {},
    }
    return .{ .len = 2, .ends = false };
}

// ── emission helpers over i32 register locals
inline fn getR(e: *Emit, n: u32, pc: u32, thumb: bool) void {
    if (n == 15) e.b.i32c(@bitCast(pc +% (if (thumb) @as(u32, 4) else 8))) else e.b.get(jit.L_X + n);
}
inline fn setR(e: *Emit, n: u32) void {
    e.b.set(jit.L_X + n);
}
/// pops the interworking target and leaves the region
fn bxExit(e: *Emit, k: u32) void {
    e.b.set(jit.L_RET);
    e.countIc(k);
    e.exit();
}
fn setNZ(e: *Emit) void {
    const b = e.b;
    b.get(jit.L_R);
    b.i32c(31);
    b.op(O.i32_shr_u);
    b.set(jit.L_N);
    b.get(jit.L_R);
    b.op(O.i32_eqz);
    b.set(jit.L_Z);
}
/// the flags of a logical op: N, Z from the result, C from the shifter (L_SC)
fn setNZC(e: *Emit) void {
    setNZ(e);
    e.b.get(jit.L_SC);
    e.b.set(jit.L_C);
}
/// a shift of L_B by the amount in L_A (0..255) with ARM's semantics: leaves the value; the
/// carry out goes to L_SC when asked for
fn shiftByReg(e: *Emit, kind: u32, carry: bool) void {
    const b = e.b;
    if (carry) {
        // amount 0 keeps C; otherwise the last bit shifted out, 0 past the width
        b.get(jit.L_A);
        b.op(O.i32_eqz);
        b.blockStart(O.if_, wasm.I32);
        b.get(jit.L_C);
        b.op(O.else_);
        switch (kind) {
            0 => {
                b.get(jit.L_B);
                b.i32c(32);
                b.get(jit.L_A);
                b.op(O.i32_sub);
                b.op(O.i32_shr_u);
                b.i32c(1);
                b.op(O.i32_and);
                b.i32c(0);
                b.get(jit.L_A);
                b.i32c(32);
                b.op(O.i32_le_u);
                b.op(O.select);
            },
            1 => {
                b.get(jit.L_B);
                b.get(jit.L_A);
                b.i32c(1);
                b.op(O.i32_sub);
                b.op(O.i32_shr_u);
                b.i32c(1);
                b.op(O.i32_and);
                b.i32c(0);
                b.get(jit.L_A);
                b.i32c(32);
                b.op(O.i32_le_u);
                b.op(O.select);
            },
            2 => {
                b.get(jit.L_B);
                b.get(jit.L_A);
                b.i32c(1);
                b.op(O.i32_sub);
                b.i32c(31);
                b.get(jit.L_A);
                b.i32c(32);
                b.op(O.i32_le_u);
                b.op(O.select);
                b.op(O.i32_shr_s);
                b.i32c(1);
                b.op(O.i32_and);
            },
            else => {
                b.get(jit.L_B);
                b.get(jit.L_A);
                b.op(O.i32_rotr);
                b.i32c(31);
                b.op(O.i32_shr_u);
            },
        }
        b.op(O.end);
        b.set(jit.L_SC);
    }
    // select takes (if-true, if-false, condition)
    switch (kind) {
        0, 1 => {
            b.i32c(0);
            b.get(jit.L_B);
            b.get(jit.L_A);
            b.op(if (kind == 0) O.i32_shl else O.i32_shr_u);
            b.get(jit.L_A);
            b.i32c(32);
            b.op(O.i32_ge_u);
            b.op(O.select);
        },
        2 => {
            b.get(jit.L_B);
            b.i32c(31);
            b.get(jit.L_A);
            b.get(jit.L_A);
            b.i32c(32);
            b.op(O.i32_ge_u);
            b.op(O.select);
            b.op(O.i32_shr_s);
        },
        else => {
            b.get(jit.L_B);
            b.get(jit.L_A);
            b.op(O.i32_rotr);
        },
    }
}
/// operand2: leaves the value; the shifter carry goes to L_SC when asked for
fn op2(e: *Emit, w: u32, pc: u32, carry: bool) void {
    const b = e.b;
    if (w & (1 << 25) != 0) {
        const rot = bits(w, 8, 4) * 2;
        const imm8 = w & 255;
        const v = if (rot == 0) imm8 else (imm8 >> @intCast(rot)) | (imm8 << @intCast(32 - rot));
        if (carry) {
            if (rot == 0) b.get(jit.L_C) else b.i32c(@intCast(v >> 31));
            b.set(jit.L_SC);
        }
        b.i32c(@bitCast(v));
        return;
    }
    const m = w & 15;
    const kind = bits(w, 5, 2);
    if (w & (1 << 4) != 0) {
        getR(e, m, pc, false);
        b.set(jit.L_B);
        b.get(jit.L_X + bits(w, 8, 4));
        b.i32c(255);
        b.op(O.i32_and);
        b.set(jit.L_A);
        shiftByReg(e, kind, carry);
        return;
    }
    const n = bits(w, 7, 5);
    getR(e, m, pc, false);
    if (carry) {
        b.set(jit.L_B);
        switch (kind) {
            0 => if (n == 0) b.get(jit.L_C) else {
                b.get(jit.L_B);
                b.i32c(@intCast(32 - n));
                b.op(O.i32_shr_u);
                b.i32c(1);
                b.op(O.i32_and);
            },
            1, 2 => {
                b.get(jit.L_B);
                b.i32c(@intCast(if (n == 0) 31 else n - 1));
                b.op(O.i32_shr_u);
                b.i32c(1);
                b.op(O.i32_and);
            },
            else => if (n == 0) {
                b.get(jit.L_B);
                b.i32c(1);
                b.op(O.i32_and);
            } else {
                b.get(jit.L_B);
                b.i32c(@intCast(n - 1));
                b.op(O.i32_shr_u);
                b.i32c(1);
                b.op(O.i32_and);
            },
        }
        b.set(jit.L_SC);
        b.get(jit.L_B);
    }
    switch (kind) {
        0 => if (n != 0) {
            b.i32c(@intCast(n));
            b.op(O.i32_shl);
        },
        1 => if (n == 0) {
            b.op(O.drop);
            b.i32c(0);
        } else {
            b.i32c(@intCast(n));
            b.op(O.i32_shr_u);
        },
        2 => {
            b.i32c(@intCast(if (n == 0) 31 else n));
            b.op(O.i32_shr_s);
        },
        else => if (n == 0) {
            b.i32c(1);
            b.op(O.i32_shr_u);
            b.get(jit.L_C);
            b.i32c(31);
            b.op(O.i32_shl);
            b.op(O.i32_or);
        } else {
            b.i32c(@intCast(n));
            b.op(O.i32_rotr);
        },
    }
}
/// a load of `op` at L_A + off into the stack
fn load(e: *Emit, o: u8, off: u32) void {
    e.b.get(jit.L_A);
    e.b.memop(o, off);
}
/// stores the value on the stack at L_A + off, page check first (the value goes through L_R)
fn store(e: *Emit, o: u8, off: u32) void {
    e.b.set(jit.L_R);
    e.storeCheck(off);
    e.b.get(jit.L_A);
    e.b.get(jit.L_R);
    e.b.memop(o, off);
}

// ── A32
pub fn emitArm(e: *Emit, pc: u32, k: u32) bool {
    const b = e.b;
    const w = mem.ld32(pc);
    const cc = w >> 28;
    if (cc == 15) {
        if ((w & 0x0e000000) == 0x0a000000) { // BLX (immediate): to Thumb
            const off: u32 = @bitCast((@as(i32, @bitCast(w << 8)) >> 6) | @as(i32, @intCast((w >> 23) & 2)));
            b.i32c(@bitCast(pc + 4));
            setR(e, 14);
            b.i32c(@bitCast(((pc +% 8 +% off) & ~@as(u32, 1)) | 1));
            bxExit(e, k);
            return true;
        }
        if ((w & 0x0d70f000) == 0x0550f000 or (w & 0x0ff000f0) == 0x05700040 or (w & 0x0ff000f0) == 0x05700050 or (w & 0x0ff000f0) == 0x05700060) return false;
        e.fallback(pc, k);
        return false;
    }
    if (cc != 14) {
        e.cond(@intCast(cc));
        e.ifv();
    }
    const ends = armBody(e, w, pc, k);
    if (cc != 14) {
        e.endif();
        // a conditional block-ender falls through when the condition fails
        if (ends) e.transfer(e.r.blocks[e.blk].fall, pc + 4, k);
    }
    return ends;
}
/// the LDM/STM base after the transfer: L_B holds its value before
fn blockWriteback(e: *Emit, rn: u32, U: bool, n: u32) void {
    e.b.get(jit.L_B);
    e.b.i32c(@intCast(4 * n));
    e.b.op(if (U) O.i32_add else O.i32_sub);
    setR(e, rn);
}
fn armBody(e: *Emit, w: u32, pc: u32, k: u32) bool {
    const b = e.b;
    const rn = bits(w, 16, 4);
    const rd = bits(w, 12, 4);
    const rs = bits(w, 8, 4);
    const rm = w & 15;
    const top = bits(w, 25, 3);
    switch (top) {
        5 => {
            const off: u32 = @bitCast(@as(i32, @bitCast(w << 8)) >> 6);
            const target = pc +% 8 +% off;
            if (w & (1 << 24) != 0) {
                b.i32c(@bitCast(pc + 4));
                setR(e, 14);
                e.transfer(-1, target, k);
            } else e.transfer(e.r.blocks[e.blk].taken, target, k);
            return true;
        },
        0, 1 => return dataProcessing(e, w, pc, k, top, rn, rd, rs, rm),
        2, 3 => {
            if (top == 3 and w & 0x10 != 0) return media(e, w, pc, k, rd, rn, rm);
            const P = w & (1 << 24) != 0;
            const U = w & (1 << 23) != 0;
            const B = w & (1 << 22) != 0;
            const W = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            // the effective address into L_A (pre-indexed) or the base (post-indexed), the writeback into L_B
            getR(e, rn, pc, false);
            if (top == 2) b.i32c(@bitCast(w & 0xfff)) else op2(e, w & ~@as(u32, 1 << 25), pc, false);
            b.op(if (U) O.i32_add else O.i32_sub);
            b.set(jit.L_B);
            if (P) b.get(jit.L_B) else getR(e, rn, pc, false);
            b.set(jit.L_A);
            if ((P and W) or !P) {
                b.get(jit.L_B);
                setR(e, rn);
            }
            if (Ld) {
                if (rd == 15) {
                    load(e, O.i32_load, 0);
                    bxExit(e, k);
                    return true;
                }
                load(e, if (B) O.i32_load8_u else O.i32_load, 0);
                setR(e, rd);
            } else {
                getR(e, rd, pc, false);
                store(e, if (B) O.i32_store8 else O.i32_store, 0);
            }
            return false;
        },
        4 => {
            const P = w & (1 << 24) != 0;
            const U = w & (1 << 23) != 0;
            const W = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            const list = w & 0xffff;
            const n: u32 = @popCount(list);
            getR(e, rn, pc, false);
            b.set(jit.L_B);
            b.get(jit.L_B);
            if (U) {
                if (P) {
                    b.i32c(4);
                    b.op(O.i32_add);
                }
            } else {
                b.i32c(@intCast(if (P) 4 * n else 4 * n - 4));
                b.op(O.i32_sub);
            }
            b.set(jit.L_A);
            // a loaded base wins over the writeback; a stored base is the value before it
            if (W and Ld) blockWriteback(e, rn, U, n);
            var off: u32 = 0;
            var i: u5 = 0;
            while (true) : (i += 1) {
                if (list & (@as(u32, 1) << i) != 0) {
                    if (Ld) {
                        if (i == 15) {
                            load(e, O.i32_load, off);
                            bxExit(e, k);
                            return true;
                        }
                        load(e, O.i32_load, off);
                        setR(e, i);
                    } else {
                        getR(e, i, pc, false);
                        store(e, O.i32_store, off);
                    }
                    off += 4;
                }
                if (i == 15) break;
            }
            if (W and !Ld) blockWriteback(e, rn, U, n);
            return false;
        },
        7 => {
            if (w & (1 << 24) != 0) { // SWI: the interpreter, which leaves with the syscall or the next pc
                e.fallback(pc, k);
                return false;
            }
            e.fallback(pc, k);
            return false;
        },
        else => {
            e.fallback(pc, k);
            return false;
        },
    }
}
fn dataProcessing(e: *Emit, w: u32, pc: u32, k: u32, top: u32, rn: u32, rd: u32, rs: u32, rm: u32) bool {
    const b = e.b;
    if (top == 0) {
        if ((w & 0x0ff000f0) == 0x01200010 or (w & 0x0ff000f0) == 0x01200030) { // BX / BLX (register)
            getR(e, rm, pc, false);
            if ((w & 0x0ff000f0) == 0x01200030) {
                b.i32c(@bitCast(pc + 4));
                setR(e, 14);
            }
            bxExit(e, k);
            return true;
        }
        if ((w & 0x0fff0ff0) == 0x016f0f10) { // CLZ
            getR(e, rm, pc, false);
            b.op(O.i32_clz);
            setR(e, rd);
            return false;
        }
        if ((w & 0x0fc000f0) == 0x00000090) { // MUL / MLA
            getR(e, rm, pc, false);
            getR(e, rs, pc, false);
            b.op(O.i32_mul);
            if (w & (1 << 21) != 0) {
                b.get(jit.L_X + rd);
                b.op(O.i32_add);
            }
            b.tee(jit.L_R);
            setR(e, rn);
            if (w & (1 << 20) != 0) setNZ(e);
            return false;
        }
        if ((w & 0x0f8000f0) == 0x00800090) { // UMULL / UMLAL / SMULL / SMLAL
            const signed = w & (1 << 22) != 0;
            getR(e, rm, pc, false);
            b.op(if (signed) O.i64_extend_i32_s else O.i64_extend_i32_u);
            getR(e, rs, pc, false);
            b.op(if (signed) O.i64_extend_i32_s else O.i64_extend_i32_u);
            b.op(O.i64_mul);
            if (w & (1 << 21) != 0) {
                b.get(jit.L_X + rn);
                b.op(O.i64_extend_i32_u);
                b.i64c(32);
                b.op(O.i64_shl);
                b.get(jit.L_X + rd);
                b.op(O.i64_extend_i32_u);
                b.op(O.i64_or);
                b.op(O.i64_add);
            }
            b.tee(jit.L_T0);
            b.op(O.i32_wrap_i64);
            setR(e, rd);
            b.get(jit.L_T0);
            b.i64c(32);
            b.op(O.i64_shr_u);
            b.op(O.i32_wrap_i64);
            setR(e, rn);
            if (w & (1 << 20) != 0) {
                b.get(jit.L_X + rn);
                b.i32c(31);
                b.op(O.i32_shr_u);
                b.set(jit.L_N);
                b.get(jit.L_T0);
                b.op(O.i64_eqz);
                b.set(jit.L_Z);
            }
            return false;
        }
        if ((w & 0x0e000090) == 0x00000090) { // the misc loads and stores
            if ((w & 0x0f0000f0) == 0x00000090 or (w & 0x0f900090) == 0x01000080 or (w & 0x0f9000f0) == 0x01000050) {
                e.fallback(pc, k);
                return false;
            }
            const P = w & (1 << 24) != 0;
            const U = w & (1 << 23) != 0;
            const I = w & (1 << 22) != 0;
            const W = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            const sh = bits(w, 5, 2);
            getR(e, rn, pc, false);
            if (I) b.i32c(@bitCast(((w >> 4) & 0xf0) | (w & 15))) else getR(e, rm, pc, false);
            b.op(if (U) O.i32_add else O.i32_sub);
            b.set(jit.L_B);
            if (P) b.get(jit.L_B) else getR(e, rn, pc, false);
            b.set(jit.L_A);
            if ((P and W) or !P) {
                b.get(jit.L_B);
                setR(e, rn);
            }
            if (Ld) {
                switch (sh) {
                    1 => load(e, O.i32_load16_u, 0),
                    2 => load(e, O.i32_load8_s, 0),
                    3 => load(e, O.i32_load16_s, 0),
                    else => {
                        e.fallback(pc, k);
                        return false;
                    },
                }
                if (rd == 15) {
                    bxExit(e, k);
                    return true;
                }
                setR(e, rd);
            } else switch (sh) {
                1 => {
                    getR(e, rd, pc, false);
                    store(e, O.i32_store16, 0);
                },
                2 => {
                    load(e, O.i32_load, 0);
                    setR(e, rd);
                    load(e, O.i32_load, 4);
                    setR(e, rd + 1);
                },
                3 => {
                    getR(e, rd, pc, false);
                    store(e, O.i32_store, 0);
                    getR(e, rd + 1, pc, false);
                    store(e, O.i32_store, 4);
                },
                else => {
                    e.fallback(pc, k);
                    return false;
                },
            }
            return false;
        }
    }
    if ((w & 0x0db0f000) == 0x0120f000 and (top == 1 or (w & 0xf0) == 0)) { // MSR
        e.fallback(pc, k);
        return false;
    }
    if (top == 1 and (w & 0x0fb00000) == 0x03000000) { // MOVW / MOVT
        const imm16 = ((w >> 4) & 0xf000) | (w & 0xfff);
        if (w & (1 << 22) != 0) {
            b.get(jit.L_X + rd);
            b.i32c(0xffff);
            b.op(O.i32_and);
            b.i32c(@bitCast(imm16 << 16));
            b.op(O.i32_or);
        } else b.i32c(@bitCast(imm16));
        setR(e, rd);
        return false;
    }
    if (top == 0 and (w & 0x0fbf0fff) == 0x010f0000) { // MRS
        e.fallback(pc, k);
        return false;
    }
    const o = bits(w, 21, 4);
    const S = w & (1 << 20) != 0;
    const logical = o == 0 or o == 1 or o == 8 or o == 9 or o >= 12;
    const compare = o >= 8 and o <= 11;
    // B = operand2 (with its carry when a logical S op wants it), then A = Rn: a register
    // shift computes through A and B itself
    op2(e, w, pc, S and logical);
    b.set(jit.L_B);
    getR(e, rn, pc, false);
    b.set(jit.L_A);
    switch (o) {
        0, 8 => {
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.op(O.i32_and);
        },
        1, 9 => {
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.op(O.i32_xor);
        },
        12 => {
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.op(O.i32_or);
        },
        14 => {
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.i32c(-1);
            b.op(O.i32_xor);
            b.op(O.i32_and);
        },
        13 => b.get(jit.L_B),
        15 => {
            b.get(jit.L_B);
            b.i32c(-1);
            b.op(O.i32_xor);
        },
        2, 10 => {
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.op(O.i32_sub);
        },
        3 => { // RSB: t - a, so the flag operands swap
            b.get(jit.L_B);
            b.get(jit.L_A);
            b.op(O.i32_sub);
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.set(jit.L_A);
            b.set(jit.L_B);
        },
        4, 11 => {
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.op(O.i32_add);
        },
        5 => {
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.op(O.i32_add);
            b.get(jit.L_C);
            b.op(O.i32_add);
        },
        6 => { // SBC: a + ~t + C
            b.get(jit.L_B);
            b.i32c(-1);
            b.op(O.i32_xor);
            b.set(jit.L_B);
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.op(O.i32_add);
            b.get(jit.L_C);
            b.op(O.i32_add);
        },
        else => { // RSC: t + ~a + C
            b.get(jit.L_A);
            b.i32c(-1);
            b.op(O.i32_xor);
            b.get(jit.L_B);
            b.set(jit.L_A);
            b.set(jit.L_B);
            b.get(jit.L_A);
            b.get(jit.L_B);
            b.op(O.i32_add);
            b.get(jit.L_C);
            b.op(O.i32_add);
        },
    }
    b.set(jit.L_R);
    if (S) {
        if (logical) setNZC(e) else switch (o) {
            2, 10, 3 => e.flagsAdd32(false, true),
            4, 11 => e.flagsAdd32(false, false),
            else => e.flagsAdd32(true, false),
        }
    }
    if (!compare) {
        b.get(jit.L_R);
        if (rd == 15) {
            bxExit(e, k);
            return true;
        }
        setR(e, rd);
    }
    return false;
}
fn media(e: *Emit, w: u32, pc: u32, k: u32, rd: u32, rn: u32, rm: u32) bool {
    const b = e.b;
    const op1 = bits(w, 20, 5);
    const op2b = bits(w, 5, 3);
    if ((w & 0x0fa00070) == 0x07a00050) { // SBFX / UBFX
        const lsb = bits(w, 7, 5);
        const width = bits(w, 16, 5) + 1;
        getR(e, rm, pc, false);
        if (w & (1 << 22) != 0) {
            b.i32c(@intCast(lsb));
            b.op(O.i32_shr_u);
            if (width < 32) {
                b.i32c(@bitCast((@as(u32, 1) << @intCast(width)) - 1));
                b.op(O.i32_and);
            }
        } else {
            b.i32c(@intCast(32 - lsb - width));
            b.op(O.i32_shl);
            b.i32c(@intCast(32 - width));
            b.op(O.i32_shr_s);
        }
        setR(e, rd);
        return false;
    }
    if ((w & 0x0fe00070) == 0x07c00010) { // BFI / BFC
        const lsb = bits(w, 7, 5);
        const width = bits(w, 16, 5) -% lsb +% 1;
        const mask: u32 = if (width >= 32) 0xffff_ffff else ((@as(u32, 1) << @intCast(width)) - 1) << @intCast(lsb);
        b.get(jit.L_X + rd);
        b.i32c(@bitCast(~mask));
        b.op(O.i32_and);
        if (rn != 15) {
            getR(e, rn, pc, false);
            b.i32c(@intCast(lsb));
            b.op(O.i32_shl);
            b.i32c(@bitCast(mask));
            b.op(O.i32_and);
            b.op(O.i32_or);
        }
        setR(e, rd);
        return false;
    }
    if (op1 >= 8 and op1 <= 15 and (op2b & 3) == 3 and bits(w, 10, 2) == 0 and (op1 == 10 or op1 == 11 or op1 == 14 or op1 == 15)) { // SXTB/SXTH/UXTB/UXTH (+A)
        getR(e, rm, pc, false);
        switch (op1) {
            10 => b.op(O.i32_extend8_s),
            11 => b.op(O.i32_extend16_s),
            14 => {
                b.i32c(255);
                b.op(O.i32_and);
            },
            else => {
                b.i32c(65535);
                b.op(O.i32_and);
            },
        }
        if (rn != 15) {
            getR(e, rn, pc, false);
            b.op(O.i32_add);
        }
        setR(e, rd);
        return false;
    }
    e.fallback(pc, k);
    return false;
}

// ── Thumb-1
pub fn emitThumb(e: *Emit, pc: u32, k: u32) bool {
    const b = e.b;
    const h: u32 = mem.ptr(u16, pc).*;
    const top = h >> 12;
    const rd = h & 7;
    const rn = (h >> 3) & 7;
    const rm = (h >> 6) & 7;
    switch (top) {
        0, 1 => {
            const o = (h >> 11) & 3;
            if (o == 3) {
                b.get(jit.L_X + rn);
                b.set(jit.L_A);
                if (h & (1 << 10) != 0) b.i32c(@intCast(rm)) else b.get(jit.L_X + rm);
                b.set(jit.L_B);
                b.get(jit.L_A);
                b.get(jit.L_B);
                const sub = h & (1 << 9) != 0;
                b.op(if (sub) O.i32_sub else O.i32_add);
                b.tee(jit.L_R);
                setR(e, rd);
                e.flagsAdd32(false, sub);
            } else {
                const n = (h >> 6) & 31;
                b.get(jit.L_X + rn);
                b.set(jit.L_B);
                if (o == 0 and n == 0) {
                    b.get(jit.L_B);
                    b.tee(jit.L_R);
                    setR(e, rd);
                    setNZ(e);
                } else {
                    b.i32c(@intCast(if (n == 0) 32 else n));
                    b.set(jit.L_A);
                    shiftByReg(e, o, true);
                    b.tee(jit.L_R);
                    setR(e, rd);
                    setNZC(e);
                }
            }
        },
        2, 3 => {
            const o = (h >> 11) & 3;
            const r8 = (h >> 8) & 7;
            const imm = h & 255;
            if (o == 0) {
                b.i32c(@intCast(imm));
                b.tee(jit.L_R);
                setR(e, r8);
                setNZ(e);
            } else {
                b.get(jit.L_X + r8);
                b.set(jit.L_A);
                b.i32c(@intCast(imm));
                b.set(jit.L_B);
                b.get(jit.L_A);
                b.get(jit.L_B);
                b.op(if (o == 2) O.i32_add else O.i32_sub);
                b.set(jit.L_R);
                e.flagsAdd32(false, o != 2);
                if (o != 1) {
                    b.get(jit.L_R);
                    setR(e, r8);
                }
            }
        },
        4 => {
            if ((h & 0xfc00) == 0x4000) {
                const o = (h >> 6) & 15;
                b.get(jit.L_X + rd);
                b.set(jit.L_A);
                b.get(jit.L_X + rn);
                b.set(jit.L_B);
                switch (o) {
                    0, 1, 8, 12, 14, 15 => {
                        if (o != 15) b.get(jit.L_A);
                        b.get(jit.L_B);
                        if (o == 14 or o == 15) {
                            b.i32c(-1);
                            b.op(O.i32_xor);
                        }
                        if (o != 15) b.op(switch (o) {
                            0, 8, 14 => O.i32_and,
                            1 => O.i32_xor,
                            else => O.i32_or,
                        });
                        b.tee(jit.L_R);
                        if (o == 8) b.op(O.drop) else setR(e, rd);
                        setNZ(e);
                    },
                    2, 3, 4, 7 => {
                        // the shift's value is in L_B, its amount in L_A, as shiftByReg wants them
                        b.get(jit.L_A);
                        b.get(jit.L_B);
                        b.i32c(255);
                        b.op(O.i32_and);
                        b.set(jit.L_A);
                        b.set(jit.L_B);
                        shiftByReg(e, if (o == 7) 3 else o - 2, true);
                        b.tee(jit.L_R);
                        setR(e, rd);
                        setNZC(e);
                    },
                    5 => {
                        b.get(jit.L_A);
                        b.get(jit.L_B);
                        b.op(O.i32_add);
                        b.get(jit.L_C);
                        b.op(O.i32_add);
                        b.tee(jit.L_R);
                        setR(e, rd);
                        e.flagsAdd32(true, false);
                    },
                    6 => {
                        b.get(jit.L_B);
                        b.i32c(-1);
                        b.op(O.i32_xor);
                        b.set(jit.L_B);
                        b.get(jit.L_A);
                        b.get(jit.L_B);
                        b.op(O.i32_add);
                        b.get(jit.L_C);
                        b.op(O.i32_add);
                        b.tee(jit.L_R);
                        setR(e, rd);
                        e.flagsAdd32(true, false);
                    },
                    9 => { // NEG: 0 - Rn
                        b.i32c(0);
                        b.set(jit.L_A);
                        b.i32c(0);
                        b.get(jit.L_B);
                        b.op(O.i32_sub);
                        b.tee(jit.L_R);
                        setR(e, rd);
                        e.flagsAdd32(false, true);
                    },
                    10, 11 => {
                        b.get(jit.L_A);
                        b.get(jit.L_B);
                        b.op(if (o == 10) O.i32_sub else O.i32_add);
                        b.set(jit.L_R);
                        e.flagsAdd32(false, o == 10);
                    },
                    else => {
                        b.get(jit.L_A);
                        b.get(jit.L_B);
                        b.op(O.i32_mul);
                        b.tee(jit.L_R);
                        setR(e, rd);
                        setNZ(e);
                    },
                }
                return false;
            }
            if ((h & 0xfc00) == 0x4400) {
                const o = (h >> 8) & 3;
                const d = rd | ((h >> 4) & 8);
                const m = (h >> 3) & 15;
                switch (o) {
                    3 => {
                        if (h & 0x80 != 0) {
                            b.i32c(@bitCast(pc +% 3));
                            setR(e, 14);
                        }
                        getR(e, m, pc, true);
                        bxExit(e, k);
                        return true;
                    },
                    0 => {
                        if (d == 15) {
                            getR(e, m, pc, true);
                            b.i32c(@bitCast(pc +% 4));
                            b.op(O.i32_add);
                            b.i32c(1);
                            b.op(O.i32_or);
                            bxExit(e, k);
                            return true;
                        }
                        getR(e, d, pc, true);
                        getR(e, m, pc, true);
                        b.op(O.i32_add);
                        setR(e, d);
                    },
                    1 => {
                        getR(e, d, pc, true);
                        b.set(jit.L_A);
                        getR(e, m, pc, true);
                        b.set(jit.L_B);
                        b.get(jit.L_A);
                        b.get(jit.L_B);
                        b.op(O.i32_sub);
                        b.set(jit.L_R);
                        e.flagsAdd32(false, true);
                    },
                    else => {
                        if (d == 15) {
                            getR(e, m, pc, true);
                            b.i32c(1);
                            b.op(O.i32_or);
                            bxExit(e, k);
                            return true;
                        }
                        getR(e, m, pc, true);
                        setR(e, d);
                    },
                }
                return false;
            }
            b.i32c(0);
            b.memop(O.i32_load, ((pc +% 4) & ~@as(u32, 3)) +% (h & 255) * 4);
            setR(e, (h >> 8) & 7);
        },
        5 => {
            const o = (h >> 9) & 7;
            b.get(jit.L_X + rn);
            b.get(jit.L_X + rm);
            b.op(O.i32_add);
            b.set(jit.L_A);
            switch (o) {
                0, 1, 2 => {
                    b.get(jit.L_X + rd);
                    store(e, switch (o) {
                        0 => O.i32_store,
                        1 => O.i32_store16,
                        else => O.i32_store8,
                    }, 0);
                },
                else => {
                    load(e, switch (o) {
                        3 => O.i32_load8_s,
                        4 => O.i32_load,
                        5 => O.i32_load16_u,
                        6 => O.i32_load8_u,
                        else => O.i32_load16_s,
                    }, 0);
                    setR(e, rd);
                },
            }
        },
        6, 7 => {
            const B = h & (1 << 12) != 0;
            const Ld = h & (1 << 11) != 0;
            const imm = (h >> 6) & 31;
            b.get(jit.L_X + rn);
            b.set(jit.L_A);
            const off = if (B) imm else imm * 4;
            if (Ld) {
                load(e, if (B) O.i32_load8_u else O.i32_load, off);
                setR(e, rd);
            } else {
                b.get(jit.L_X + rd);
                store(e, if (B) O.i32_store8 else O.i32_store, off);
            }
        },
        8 => {
            b.get(jit.L_X + rn);
            b.set(jit.L_A);
            const off = ((h >> 6) & 31) * 2;
            if (h & (1 << 11) != 0) {
                load(e, O.i32_load16_u, off);
                setR(e, rd);
            } else {
                b.get(jit.L_X + rd);
                store(e, O.i32_store16, off);
            }
        },
        9 => {
            const rt = (h >> 8) & 7;
            b.get(jit.L_X + 13);
            b.set(jit.L_A);
            if (h & (1 << 11) != 0) {
                load(e, O.i32_load, (h & 255) * 4);
                setR(e, rt);
            } else {
                b.get(jit.L_X + rt);
                store(e, O.i32_store, (h & 255) * 4);
            }
        },
        10 => {
            const rt = (h >> 8) & 7;
            const imm = (h & 255) * 4;
            if (h & (1 << 11) != 0) {
                b.get(jit.L_X + 13);
                b.i32c(@intCast(imm));
                b.op(O.i32_add);
            } else b.i32c(@bitCast(((pc +% 4) & ~@as(u32, 3)) +% imm));
            setR(e, rt);
        },
        11 => return thumbMisc(e, h, pc, k, rd, rn),
        12 => {
            const Ld = h & (1 << 11) != 0;
            const n8 = (h >> 8) & 7;
            const list = h & 255;
            b.get(jit.L_X + n8);
            b.set(jit.L_A);
            var off: u32 = 0;
            var i: u5 = 0;
            while (i < 8) : (i += 1) if (list & (@as(u32, 1) << i) != 0) {
                if (Ld) {
                    load(e, O.i32_load, off);
                    setR(e, i);
                } else {
                    b.get(jit.L_X + i);
                    store(e, O.i32_store, off);
                }
                off += 4;
            };
            if (!Ld or list & (@as(u32, 1) << @intCast(n8)) == 0) {
                b.get(jit.L_A);
                b.i32c(@intCast(off));
                b.op(O.i32_add);
                setR(e, n8);
            }
        },
        13 => {
            const cc = (h >> 8) & 15;
            if (cc >= 14) {
                e.fallback(pc, k);
                return true;
            }
            const target = pc +% 4 +% @as(u32, @bitCast(sx(h & 255, 8) * 2));
            e.cond(@intCast(cc));
            e.ifv();
            e.transfer(e.r.blocks[e.blk].taken, target | 1, k);
            e.endif();
            e.transfer(e.r.blocks[e.blk].fall, (pc + 2) | 1, k);
            return true;
        },
        14 => {
            if (h & (1 << 11) != 0) {
                e.fallback(pc, k);
                return true;
            }
            const target = pc +% 4 +% @as(u32, @bitCast(sx(h & 0x7ff, 11) * 2));
            e.transfer(e.r.blocks[e.blk].taken, target | 1, k);
            return true;
        },
        else => {
            if ((h & 0xf800) != 0xf000) {
                e.fallback(pc, k);
                return true;
            }
            const h2: u32 = mem.ptr(u16, pc + 2).*;
            if ((h2 & 0xc000) != 0xc000) {
                e.fallback(pc, k);
                return true;
            }
            const Sb = (h >> 10) & 1;
            const I1 = 1 - (((h2 >> 13) & 1) ^ Sb);
            const I2 = 1 - (((h2 >> 11) & 1) ^ Sb);
            const raw = (Sb << 24) | (I1 << 23) | (I2 << 22) | ((h & 0x3ff) << 12) | ((h2 & 0x7ff) << 1);
            const off: u32 = @bitCast(@as(i32, @bitCast(raw << 7)) >> 7);
            b.i32c(@bitCast(pc +% 5));
            setR(e, 14);
            if (h2 & 0x1000 != 0) e.transfer(-1, (pc +% 4 +% off) | 1, k) else e.transfer(-1, ((pc +% 4) & ~@as(u32, 3)) +% (off & ~@as(u32, 3)), k);
            return true;
        },
    }
    return false;
}
fn thumbMisc(e: *Emit, h: u32, pc: u32, k: u32, rd: u32, rn: u32) bool {
    const b = e.b;
    if ((h & 0xff00) == 0xb000) {
        b.get(jit.L_X + 13);
        b.i32c(@intCast((h & 127) * 4));
        b.op(if (h & 0x80 != 0) O.i32_sub else O.i32_add);
        setR(e, 13);
        return false;
    }
    if ((h & 0xfe00) == 0xb400) { // PUSH
        const list = (h & 255) | ((h & 0x100) << 6);
        b.get(jit.L_X + 13);
        b.i32c(@intCast(@as(u32, @popCount(list)) * 4));
        b.op(O.i32_sub);
        b.tee(jit.L_A);
        setR(e, 13);
        var off: u32 = 0;
        var i: u5 = 0;
        while (true) : (i += 1) {
            if (list & (@as(u32, 1) << i) != 0) {
                b.get(jit.L_X + i);
                store(e, O.i32_store, off);
                off += 4;
            }
            if (i == 15) break;
        }
        return false;
    }
    if ((h & 0xfe00) == 0xbc00) { // POP
        const list = (h & 255) | ((h & 0x100) << 7);
        b.get(jit.L_X + 13);
        b.tee(jit.L_A);
        b.i32c(@intCast(@as(u32, @popCount(list)) * 4));
        b.op(O.i32_add);
        setR(e, 13);
        var off: u32 = 0;
        var i: u5 = 0;
        while (i < 15) : (i += 1) if (list & (@as(u32, 1) << i) != 0) {
            load(e, O.i32_load, off);
            setR(e, i);
            off += 4;
        };
        if (list & 0x8000 != 0) {
            load(e, O.i32_load, off);
            bxExit(e, k);
            return true;
        }
        return false;
    }
    if ((h & 0xff00) == 0xbf00 or (h & 0xffe8) == 0xb660) return false;
    switch (h & 0xffc0) {
        0xb200, 0xb240, 0xb280, 0xb2c0 => {
            b.get(jit.L_X + rn);
            switch (h & 0xffc0) {
                0xb200 => b.op(O.i32_extend16_s),
                0xb240 => b.op(O.i32_extend8_s),
                0xb280 => {
                    b.i32c(0xffff);
                    b.op(O.i32_and);
                },
                else => {
                    b.i32c(255);
                    b.op(O.i32_and);
                },
            }
            setR(e, rd);
            return false;
        },
        else => {},
    }
    if ((h & 0xf500) == 0xb100) { // CBZ / CBNZ
        const target = pc + 4 + ((h >> 3) & 31) * 2 + ((h & 0x200) >> 3);
        b.get(jit.L_X + rd);
        b.op(O.i32_eqz);
        if (h & 0x800 != 0) b.op(O.i32_eqz);
        e.ifv();
        e.transfer(e.r.blocks[e.blk].taken, target | 1, k);
        e.endif();
        e.transfer(e.r.blocks[e.blk].fall, (pc + 2) | 1, k);
        return true;
    }
    e.fallback(pc, k);
    return (h & 0xff00) == 0xbe00;
}
