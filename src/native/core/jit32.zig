const abi = @import("abi.zig");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const wasm = @import("wasm.zig");
const bt = @import("bits.zig");
const bits = bt.bits;
const Emit = jit.Emit(false);
const Region = jit.Region;
const O = wasm.Op;
const get = wasm.get;
const set = wasm.set;
const tee = wasm.tee;
const c32 = wasm.c32;
const mo = wasm.mo;
const L_X = jit.L_X;
const L_A = jit.L_A;
const L_B = jit.L_B;
const L_R = jit.L_R;
const L_C = jit.L_C;
const L_SC = jit.L_SC;
const FA = jit.L_FA32;
const FB = jit.L_FB32;
const FR = jit.L_FR32;
const FC = jit.FC;

pub const Scan = struct { len: u32, ends: bool };
const FN = jit.FN;
const FZ = jit.FZ;

pub fn rwArm(w: u32) jit.RW {
    var rw = jit.ALL32;
    rw.fr = 0;
    rw.fw = 0;
    const cc = w >> 28;
    if (cc == 15) return rw;
    if (cc != 14) {
        rw.fr = jit.condReads(@intCast(cc));
        rw.cond = true;
    }
    const top = bits(w, 25, 3);
    const S = w & (1 << 20) != 0;
    switch (top) {
        0, 1 => {
            if (top == 0 and ((w & 0x0fc000f0) == 0x00000090 or (w & 0x0f8000f0) == 0x00800090)) {
                if (S) rw.fw = FN | FZ;
                return rw;
            }
            if (top == 0 and (w & 0x0e000090) == 0x00000090) return rw;
            if ((w & 0x0d900000) == 0x01000000) {
                if ((w & 0x0fbf0fff) == 0x010f0000) rw.fr = 15;
                if ((w & 0x0db0f000) == 0x0120f000 and w & (1 << 19) != 0) rw.fw = 15;
                return rw;
            }
            const o = bits(w, 21, 4);
            const logical = o < 2 or o == 8 or o == 9 or o >= 12;
            if (o >= 5 and o <= 7) rw.fr |= FC;
            if (w & (1 << 25) == 0) {
                const kind = bits(w, 5, 2);
                const n = bits(w, 7, 5);
                const regsh = w & 0x10 != 0;
                if ((!regsh and kind == 3 and n == 0) or (S and logical and (regsh or (kind == 0 and n == 0)))) rw.fr |= FC;
            } else if (S and logical and bits(w, 8, 4) == 0) rw.fr |= FC;
            if (S) rw.fw = if (logical) FN | FZ | FC else 15;
        },
        6, 7 => {
            if (top == 7 and w & (1 << 24) != 0) {
                rw.fr = 15;
                rw.fw = 15;
            } else if ((w & 0x0fff0fff) == 0x0ef1fa10) rw.fw = 15;
        },
        else => {},
    }
    return rw;
}
pub fn rwThumb(h: u32) jit.RW {
    var rw = jit.ALL32;
    rw.fr = 0;
    rw.fw = 0;
    switch (h >> 12) {
        0, 1 => {
            const o = (h >> 11) & 3;
            rw.fw = if (o == 3) 15 else if (o == 0 and (h >> 6) & 31 == 0) FN | FZ else FN | FZ | FC;
        },
        2, 3 => rw.fw = if ((h >> 11) & 3 == 0) FN | FZ else 15,
        4 => if ((h & 0xfc00) == 0x4000) {
            switch ((h >> 6) & 15) {
                0, 1, 8, 12, 13, 14, 15 => rw.fw = FN | FZ,
                2, 3, 4, 7 => {
                    rw.fr = FC;
                    rw.fw = FN | FZ | FC;
                },
                5, 6 => {
                    rw.fr = FC;
                    rw.fw = 15;
                },
                else => rw.fw = 15,
            }
        } else if ((h & 0xff00) == 0x4500) {
            rw.fw = 15;
        },
        13 => {
            const cc = (h >> 8) & 15;
            if (cc < 14) rw.fr = jit.condReads(@intCast(cc)) else if (cc == 15) {
                rw.fr = 15;
                rw.fw = 15;
            }
        },
        else => {},
    }
    return rw;
}

pub fn scanArm(r: *Region, i: u32, page: *cpu.Page, pc: u32) Scan {
    cpu.cover(page, pc, pc);
    const w = mem.ld(u32, pc);
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
pub fn scanThumb(r: *Region, i: u32, page: *cpu.Page, pc: u32) Scan {
    cpu.cover(page, pc, pc);
    const h: u32 = mem.ld(u16, pc);
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
            b.taken = jit.blockFor(r, pc +% 4 +% @as(u32, @bitCast(bt.sx(i32, h & 255, 8) * 2)));
            b.fall = if (next & (abi.PAGE_SIZE - 1) != 0) jit.blockFor(r, next) else -1;
            return .{ .len = 2, .ends = true };
        },
        14 => {
            if (h & (1 << 11) != 0) return .{ .len = 2, .ends = true };
            b.taken = jit.blockFor(r, pc +% 4 +% @as(u32, @bitCast(bt.sx(i32, h & 0x7ff, 11) * 2)));
            return .{ .len = 2, .ends = true };
        },
        15 => return .{ .len = if ((h & 0xf800) == 0xf000) 4 else 2, .ends = true },
        else => {},
    }
    return .{ .len = 2, .ends = false };
}

inline fn getR(e: *Emit, n: u32, pc: u32, thumb: bool) void {
    if (n == 15) e.b.i32c(@bitCast(pc +% (if (thumb) @as(u32, 4) else 8))) else e.b.get(L_X + n);
}
inline fn setR(e: *Emit, n: u32) void {
    e.b.set(L_X + n);
}
fn bxExit(e: *Emit, k: u32) void {
    e.b.set(jit.L_RET);
    e.countIc(k);
    e.exitRet();
}
fn shiftByReg(e: *Emit, kind: u32, carry: bool) void {
    const b = e.b;
    if (carry) {
        e.settle(FC);
        b.emit(.{ get(L_A), O.i32_eqz, O.if_, wasm.I32, get(L_C), O.else_, get(L_B) });
        switch (kind) {
            0 => b.emit(.{ c32(32), get(L_A), O.i32_sub, O.i32_shr_u, c32(1), O.i32_and, c32(0), get(L_A), c32(32), O.i32_le_u, O.select }),
            1 => b.emit(.{ get(L_A), c32(1), O.i32_sub, O.i32_shr_u, c32(1), O.i32_and, c32(0), get(L_A), c32(32), O.i32_le_u, O.select }),
            2 => b.emit(.{ get(L_A), c32(1), O.i32_sub, c32(31), get(L_A), c32(32), O.i32_le_u, O.select, O.i32_shr_s, c32(1), O.i32_and }),
            else => b.emit(.{ get(L_A), O.i32_rotr, c32(31), O.i32_shr_u }),
        }
        b.emit(.{ O.end, set(L_SC) });
    }
    switch (kind) {
        0, 1 => b.emit(.{ c32(0), get(L_B), get(L_A), if (kind == 0) O.i32_shl else O.i32_shr_u, get(L_A), c32(32), O.i32_ge_u, O.select }),
        2 => b.emit(.{ get(L_B), c32(31), get(L_A), get(L_A), c32(32), O.i32_ge_u, O.select, O.i32_shr_s }),
        else => b.emit(.{ get(L_B), get(L_A), O.i32_rotr }),
    }
}
fn op2(e: *Emit, w: u32, pc: u32, carry: bool) void {
    const b = e.b;
    if (w & (1 << 25) != 0) {
        const rot = bits(w, 8, 4) * 2;
        const imm8 = w & 255;
        const v = if (rot == 0) imm8 else (imm8 >> @intCast(rot)) | (imm8 << @intCast(32 - rot));
        if (carry) {
            if (rot == 0) e.settle(FC);
            if (rot == 0) b.get(L_C) else b.i32c(@intCast(v >> 31));
            b.set(L_SC);
        }
        b.i32c(@bitCast(v));
        return;
    }
    const m = w & 15;
    const kind = bits(w, 5, 2);
    getR(e, m, pc, false);
    if (w & (1 << 4) != 0) {
        b.emit(.{ set(L_B), get(L_X + bits(w, 8, 4)), c32(255), O.i32_and, set(L_A) });
        shiftByReg(e, kind, carry);
        return;
    }
    const n = bits(w, 7, 5);
    if (carry or (kind == 3 and n == 0)) e.settle(FC);
    if (carry) {
        b.set(L_B);
        if (n == 0 and kind == 0) b.get(L_C) else b.emit(.{ get(L_B), c32(@intCast(switch (kind) {
            0 => 32 - n,
            3 => if (n == 0) 0 else n - 1,
            else => if (n == 0) 31 else n - 1,
        })), O.i32_shr_u, c32(1), O.i32_and });
        b.emit(.{ set(L_SC), get(L_B) });
    }
    switch (kind) {
        0 => if (n != 0) b.emit(.{ c32(@intCast(n)), O.i32_shl }),
        1 => if (n == 0) b.emit(.{ O.drop, c32(0) }) else b.emit(.{ c32(@intCast(n)), O.i32_shr_u }),
        2 => b.emit(.{ c32(@intCast(if (n == 0) 31 else n)), O.i32_shr_s }),
        else => if (n == 0) b.emit(.{ c32(1), O.i32_shr_u, get(L_C), c32(31), O.i32_shl, O.i32_or }) else b.emit(.{ c32(@intCast(n)), O.i32_rotr }),
    }
}
fn load(e: *Emit, o: u8, off: u32) void {
    e.b.emit(.{ get(L_A), mo(o, off) });
}
fn store(e: *Emit, o: u8, off: u32) void {
    e.b.set(L_R);
    e.storeCheck(off, false);
    e.b.emit(.{ get(L_A), get(L_R), mo(o, off) });
}

pub fn emitArm(e: *Emit, pc: u32, k: u32) bool {
    const b = e.b;
    const w = mem.ld(u32, pc);
    const cc = w >> 28;
    if (cc == 15) {
        if ((w & 0x0e000000) == 0x0a000000) {
            const off: u32 = @bitCast((@as(i32, @bitCast(w << 8)) >> 6) | @as(i32, @intCast((w >> 23) & 2)));
            b.emit(.{ c32(@bitCast(pc + 4)), set(L_X + 14), c32(@bitCast(((pc +% 8 +% off) & ~@as(u32, 1)) | 1)) });
            bxExit(e, k);
            return true;
        }
        if ((w & 0x0d70f000) == 0x0550f000 or (w & 0x0ff000f0) == 0x05700040 or (w & 0x0ff000f0) == 0x05700050 or (w & 0x0ff000f0) == 0x05700060) return false;
        e.fallback(pc, k);
        return false;
    }
    const top = bits(w, 25, 3);
    if (cc != 14) {
        e.cond(@intCast(cc));
        if (top == 5 and w & (1 << 24) == 0) {
            e.branch(pc +% 8 +% @as(u32, @bitCast(@as(i32, @bitCast(w << 8)) >> 6)), pc + 4, k);
            return true;
        }
        const q = rwArm(w);
        const inl = top == 4 or top == 2 or (top == 3 and w & 0x10 == 0) or (top < 2 and (w & 0x0d900000) != 0x01000000 and !(top == 0 and (w & 0x0e000090) == 0x00000090));
        e.ifc(if (!inl or q.fw != 0) 15 else q.fr & ~jit.condReads(@intCast(cc)));
    }
    const ends = armBody(e, w, pc, k);
    if (cc != 14) {
        e.endif();
        if (ends) e.transfer(e.r.blocks[e.blk].fall, pc + 4, k);
    }
    return ends;
}
fn blockWriteback(e: *Emit, rn: u32, U: bool, n: u32) void {
    e.b.emit(.{ get(L_B), c32(@intCast(4 * n)), if (U) O.i32_add else O.i32_sub, set(L_X + rn) });
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
            const target = pc +% 8 +% @as(u32, @bitCast(@as(i32, @bitCast(w << 8)) >> 6));
            if (w & (1 << 24) != 0) {
                b.emit(.{ c32(@bitCast(pc + 4)), set(L_X + 14) });
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
            const Wb = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            getR(e, rn, pc, false);
            if (top == 2) b.i32c(@bitCast(w & 0xfff)) else op2(e, w & ~@as(u32, 1 << 25), pc, false);
            b.emit(.{ if (U) O.i32_add else O.i32_sub, set(L_B) });
            if (P) b.get(L_B) else getR(e, rn, pc, false);
            b.set(L_A);
            if (Wb or !P) b.emit(.{ get(L_B), set(L_X + rn) });
            if (Ld) {
                load(e, if (B) O.i32_load8_u else O.i32_load, 0);
                if (rd == 15) {
                    bxExit(e, k);
                    return true;
                }
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
            const Wb = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            const list = w & 0xffff;
            const n: u32 = @popCount(list);
            getR(e, rn, pc, false);
            b.emit(.{ set(L_B), get(L_B) });
            if (U) {
                if (P) b.emit(.{ c32(4), O.i32_add });
            } else b.emit(.{ c32(@intCast(if (P) 4 * n else 4 * n - 4)), O.i32_sub });
            b.set(L_A);
            if (Wb and Ld) blockWriteback(e, rn, U, n);
            var off: u32 = 0;
            for (0..16) |i| if (list & (@as(u32, 1) << @intCast(i)) != 0) {
                if (Ld) {
                    load(e, O.i32_load, off);
                    if (i == 15) {
                        bxExit(e, k);
                        return true;
                    }
                    setR(e, @intCast(i));
                } else {
                    getR(e, @intCast(i), pc, false);
                    store(e, O.i32_store, off);
                }
                off += 4;
            };
            if (Wb and !Ld) blockWriteback(e, rn, U, n);
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
        if ((w & 0x0ff000f0) == 0x01200010 or (w & 0x0ff000f0) == 0x01200030) {
            getR(e, rm, pc, false);
            if ((w & 0x0ff000f0) == 0x01200030) b.emit(.{ c32(@bitCast(pc + 4)), set(L_X + 14) });
            bxExit(e, k);
            return true;
        }
        if ((w & 0x0fff0ff0) == 0x016f0f10) {
            getR(e, rm, pc, false);
            b.emit(.{ O.i32_clz, set(L_X + rd) });
            return false;
        }
        if ((w & 0x0fc000f0) == 0x00000090) {
            getR(e, rm, pc, false);
            getR(e, rs, pc, false);
            b.byte(O.i32_mul);
            if (w & (1 << 21) != 0) b.emit(.{ get(L_X + rd), O.i32_add });
            const S = w & (1 << 20) != 0;
            if (S) e.pre(.nz);
            b.emit(.{ tee(if (S) FR else L_R), set(L_X + rn) });
            if (S) e.pend(false, .nz);
            return false;
        }
        if ((w & 0x0f8000f0) == 0x00800090) {
            const ext: u8 = if (w & (1 << 22) != 0) O.i64_extend_i32_s else O.i64_extend_i32_u;
            getR(e, rm, pc, false);
            b.byte(ext);
            getR(e, rs, pc, false);
            b.emit(.{ ext, O.i64_mul });
            if (w & (1 << 21) != 0) b.emit(.{ get(L_X + rn), O.i64_extend_i32_u, wasm.c64(32), O.i64_shl, get(L_X + rd), O.i64_extend_i32_u, O.i64_or, O.i64_add });
            b.emit(.{ tee(jit.L_T0), O.i32_wrap_i64, set(L_X + rd), get(jit.L_T0), wasm.c64(32), O.i64_shr_u, O.i32_wrap_i64, set(L_X + rn) });
            if (w & (1 << 20) != 0) {
                e.eager(jit.FN | jit.FZ);
                b.emit(.{ get(L_X + rn), c32(31), O.i32_shr_u, set(jit.L_N), get(jit.L_T0), O.i64_eqz, set(jit.L_Z) });
            }
            return false;
        }
        if ((w & 0x0e000090) == 0x00000090) {
            if ((w & 0x0f0000f0) == 0x00000090 or (w & 0x0f900090) == 0x01000080 or (w & 0x0f9000f0) == 0x01000050) {
                e.fallback(pc, k);
                return false;
            }
            const P = w & (1 << 24) != 0;
            const U = w & (1 << 23) != 0;
            const I = w & (1 << 22) != 0;
            const Wb = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            const sh = bits(w, 5, 2);
            getR(e, rn, pc, false);
            if (I) b.i32c(@bitCast(((w >> 4) & 0xf0) | (w & 15))) else getR(e, rm, pc, false);
            b.emit(.{ if (U) O.i32_add else O.i32_sub, set(L_B) });
            if (P) b.get(L_B) else getR(e, rn, pc, false);
            b.set(L_A);
            if (Wb or !P) b.emit(.{ get(L_B), set(L_X + rn) });
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
    if ((w & 0x0db0f000) == 0x0120f000 and (top == 1 or (w & 0xf0) == 0)) {
        e.fallback(pc, k);
        return false;
    }
    if (top == 1 and (w & 0x0fb00000) == 0x03000000) {
        const imm16 = ((w >> 4) & 0xf000) | (w & 0xfff);
        if (w & (1 << 22) != 0) b.emit(.{ get(L_X + rd), c32(0xffff), O.i32_and, c32(@bitCast(imm16 << 16)), O.i32_or }) else b.i32c(@bitCast(imm16));
        setR(e, rd);
        return false;
    }
    if (top == 0 and (w & 0x0fbf0fff) == 0x010f0000) {
        e.fallback(pc, k);
        return false;
    }
    const o = bits(w, 21, 4);
    const S = w & (1 << 20) != 0;
    const logical = o < 2 or o == 8 or o == 9 or o >= 12;
    const A: u32 = if (S) FA else L_A;
    const B: u32 = if (S) FB else L_B;
    const R: u32 = if (S) FR else L_R;
    const kind: jit.Pend = if (logical) .logic else switch (o) {
        2, 10, 3 => .sub,
        4, 11 => .add,
        else => .adc,
    };
    if (S) e.pre(kind);
    if (o >= 5 and o <= 7) e.settle(FC);
    op2(e, w, pc, S and logical);
    b.set(B);
    getR(e, rn, pc, false);
    b.set(A);
    switch (o) {
        0, 8 => b.emit(.{ get(A), get(B), O.i32_and }),
        1, 9 => b.emit(.{ get(A), get(B), O.i32_xor }),
        12 => b.emit(.{ get(A), get(B), O.i32_or }),
        14 => b.emit(.{ get(A), get(B), c32(-1), O.i32_xor, O.i32_and }),
        13 => b.get(B),
        15 => b.emit(.{ get(B), c32(-1), O.i32_xor }),
        2, 10 => b.emit(.{ get(A), get(B), O.i32_sub }),
        3 => b.emit(.{ get(B), get(A), O.i32_sub, get(A), get(B), set(A), set(B) }),
        4, 11 => b.emit(.{ get(A), get(B), O.i32_add }),
        5 => b.emit(.{ get(A), get(B), O.i32_add, get(L_C), O.i32_add }),
        6 => b.emit(.{ get(B), c32(-1), O.i32_xor, set(B), get(A), get(B), O.i32_add, get(L_C), O.i32_add }),
        else => b.emit(.{ get(A), c32(-1), O.i32_xor, get(B), set(A), set(B), get(A), get(B), O.i32_add, get(L_C), O.i32_add }),
    }
    b.set(R);
    if (S) e.pend(false, kind);
    if (o < 8 or o > 11) {
        b.get(R);
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
    if ((w & 0x0fa00070) == 0x07a00050) {
        const lsb = bits(w, 7, 5);
        const width = bits(w, 16, 5) + 1;
        getR(e, rm, pc, false);
        if (w & (1 << 22) != 0) {
            b.emit(.{ c32(@intCast(lsb)), O.i32_shr_u });
            if (width < 32) b.emit(.{ c32(@bitCast((@as(u32, 1) << @intCast(width)) - 1)), O.i32_and });
        } else b.emit(.{ c32(@intCast(32 - lsb - width)), O.i32_shl, c32(@intCast(32 - width)), O.i32_shr_s });
        setR(e, rd);
        return false;
    }
    if ((w & 0x0fe00070) == 0x07c00010) {
        const lsb = bits(w, 7, 5);
        const width = bits(w, 16, 5) -% lsb +% 1;
        const mask: u32 = if (width >= 32) 0xffff_ffff else ((@as(u32, 1) << @intCast(width)) - 1) << @intCast(lsb);
        b.emit(.{ get(L_X + rd), c32(@bitCast(~mask)), O.i32_and });
        if (rn != 15) {
            getR(e, rn, pc, false);
            b.emit(.{ c32(@intCast(lsb)), O.i32_shl, c32(@bitCast(mask)), O.i32_and, O.i32_or });
        }
        setR(e, rd);
        return false;
    }
    if (op1 >= 8 and op1 <= 15 and (op2b & 3) == 3 and bits(w, 10, 2) == 0 and (op1 == 10 or op1 == 11 or op1 == 14 or op1 == 15)) {
        getR(e, rm, pc, false);
        switch (op1) {
            10 => b.byte(O.i32_extend8_s),
            11 => b.byte(O.i32_extend16_s),
            14 => b.emit(.{ c32(255), O.i32_and }),
            else => b.emit(.{ c32(65535), O.i32_and }),
        }
        if (rn != 15) {
            getR(e, rn, pc, false);
            b.byte(O.i32_add);
        }
        setR(e, rd);
        return false;
    }
    e.fallback(pc, k);
    return false;
}

const T_STORES = [_]u8{ O.i32_store, O.i32_store16, O.i32_store8 };
const T_LOADS = [_]u8{ O.i32_load8_s, O.i32_load, O.i32_load16_u, O.i32_load8_u, O.i32_load16_s };
pub fn emitThumb(e: *Emit, pc: u32, k: u32) bool {
    const b = e.b;
    const h: u32 = mem.ld(u16, pc);
    const top = h >> 12;
    const rd = h & 7;
    const rn = (h >> 3) & 7;
    const rm = (h >> 6) & 7;
    switch (top) {
        0, 1 => {
            const o = (h >> 11) & 3;
            if (o == 3) {
                b.emit(.{ get(L_X + rn), set(FA) });
                if (h & (1 << 10) != 0) b.i32c(@intCast(rm)) else b.get(L_X + rm);
                b.set(FB);
                const sub = h & (1 << 9) != 0;
                b.emit(.{ get(FA), get(FB), if (sub) O.i32_sub else O.i32_add, tee(FR), set(L_X + rd) });
                e.pend(false, if (sub) .sub else .add);
            } else {
                const n = (h >> 6) & 31;
                e.pre(if (o == 0 and n == 0) .nz else .logic);
                b.emit(.{ get(L_X + rn), set(L_B) });
                if (o == 0 and n == 0) {
                    b.emit(.{ get(L_B), tee(FR), set(L_X + rd) });
                    e.pend(false, .nz);
                } else {
                    b.emit(.{ c32(@intCast(if (n == 0) 32 else n)), set(L_A) });
                    shiftByReg(e, o, true);
                    b.emit(.{ tee(FR), set(L_X + rd) });
                    e.pend(false, .logic);
                }
            }
        },
        2, 3 => {
            const o = (h >> 11) & 3;
            const r8 = (h >> 8) & 7;
            const imm: i32 = @intCast(h & 255);
            if (o == 0) {
                e.pre(.nz);
                b.emit(.{ c32(imm), tee(FR), set(L_X + r8) });
                e.pend(false, .nz);
            } else {
                b.emit(.{ get(L_X + r8), set(FA), c32(imm), set(FB), get(FA), get(FB), if (o == 2) O.i32_add else O.i32_sub, set(FR) });
                if (o != 1) b.emit(.{ get(FR), set(L_X + r8) });
                e.pend(false, if (o == 2) .add else .sub);
            }
        },
        4 => {
            if ((h & 0xfc00) == 0x4000) {
                const o = (h >> 6) & 15;
                e.pre(switch (o) {
                    0, 1, 8, 12, 13, 14, 15 => .nz,
                    2, 3, 4, 7 => .logic,
                    else => .add,
                });
                if (o >= 2 and o <= 7) e.settle(FC);
                b.emit(.{ get(L_X + rd), set(FA), get(L_X + rn), set(FB) });
                switch (o) {
                    0, 1, 8, 12, 14, 15 => {
                        if (o != 15) b.get(FA);
                        b.get(FB);
                        if (o == 14 or o == 15) b.emit(.{ c32(-1), O.i32_xor });
                        if (o != 15) b.byte(switch (o) {
                            0, 8, 14 => O.i32_and,
                            1 => O.i32_xor,
                            else => O.i32_or,
                        });
                        b.tee(FR);
                        if (o == 8) b.byte(O.drop) else setR(e, rd);
                        e.pend(false, .nz);
                    },
                    2, 3, 4, 7 => {
                        b.emit(.{ get(FA), get(FB), c32(255), O.i32_and, set(L_A), set(L_B) });
                        shiftByReg(e, if (o == 7) 3 else o - 2, true);
                        b.emit(.{ tee(FR), set(L_X + rd) });
                        e.pend(false, .logic);
                    },
                    5, 6 => {
                        if (o == 6) b.emit(.{ get(FB), c32(-1), O.i32_xor, set(FB) });
                        b.emit(.{ get(FA), get(FB), O.i32_add, get(L_C), O.i32_add, tee(FR), set(L_X + rd) });
                        e.pend(false, .adc);
                    },
                    9 => {
                        b.emit(.{ c32(0), set(FA), c32(0), get(FB), O.i32_sub, tee(FR), set(L_X + rd) });
                        e.pend(false, .sub);
                    },
                    10, 11 => {
                        b.emit(.{ get(FA), get(FB), if (o == 10) O.i32_sub else O.i32_add, set(FR) });
                        e.pend(false, if (o == 10) .sub else .add);
                    },
                    else => {
                        b.emit(.{ get(FA), get(FB), O.i32_mul, tee(FR), set(L_X + rd) });
                        e.pend(false, .nz);
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
                        if (h & 0x80 != 0) b.emit(.{ c32(@bitCast(pc +% 3)), set(L_X + 14) });
                        getR(e, m, pc, true);
                        bxExit(e, k);
                        return true;
                    },
                    0 => {
                        if (d == 15) {
                            getR(e, m, pc, true);
                            b.emit(.{ c32(@bitCast(pc +% 4)), O.i32_add, c32(1), O.i32_or });
                            bxExit(e, k);
                            return true;
                        }
                        getR(e, d, pc, true);
                        getR(e, m, pc, true);
                        b.emit(.{ O.i32_add, set(L_X + d) });
                    },
                    1 => {
                        getR(e, d, pc, true);
                        b.set(FA);
                        getR(e, m, pc, true);
                        b.emit(.{ set(FB), get(FA), get(FB), O.i32_sub, set(FR) });
                        e.pend(false, .sub);
                    },
                    else => {
                        getR(e, m, pc, true);
                        if (d == 15) {
                            b.emit(.{ c32(1), O.i32_or });
                            bxExit(e, k);
                            return true;
                        }
                        setR(e, d);
                    },
                }
                return false;
            }
            b.emit(.{ c32(0), mo(O.i32_load, ((pc +% 4) & ~@as(u32, 3)) +% (h & 255) * 4), set(L_X + ((h >> 8) & 7)) });
        },
        5 => {
            const o = (h >> 9) & 7;
            b.emit(.{ get(L_X + rn), get(L_X + rm), O.i32_add, set(L_A) });
            if (o < 3) {
                b.get(L_X + rd);
                store(e, T_STORES[o], 0);
            } else {
                load(e, T_LOADS[o - 3], 0);
                setR(e, rd);
            }
        },
        6, 7, 8 => {
            const B = top == 7;
            const imm = (h >> 6) & 31;
            const off = if (B) imm else if (top == 8) imm * 2 else imm * 4;
            b.emit(.{ get(L_X + rn), set(L_A) });
            if (h & (1 << 11) != 0) {
                load(e, if (B) O.i32_load8_u else if (top == 8) O.i32_load16_u else O.i32_load, off);
                setR(e, rd);
            } else {
                b.get(L_X + rd);
                store(e, if (B) O.i32_store8 else if (top == 8) O.i32_store16 else O.i32_store, off);
            }
        },
        9 => {
            const rt = (h >> 8) & 7;
            b.emit(.{ get(L_X + 13), set(L_A) });
            if (h & (1 << 11) != 0) {
                load(e, O.i32_load, (h & 255) * 4);
                setR(e, rt);
            } else {
                b.get(L_X + rt);
                store(e, O.i32_store, (h & 255) * 4);
            }
        },
        10 => {
            const rt = (h >> 8) & 7;
            const imm = (h & 255) * 4;
            if (h & (1 << 11) != 0) b.emit(.{ get(L_X + 13), c32(@intCast(imm)), O.i32_add }) else b.i32c(@bitCast(((pc +% 4) & ~@as(u32, 3)) +% imm));
            setR(e, rt);
        },
        11 => return thumbMisc(e, h, pc, k, rd, rn),
        12 => {
            const Ld = h & (1 << 11) != 0;
            const n8 = (h >> 8) & 7;
            const list = h & 255;
            b.emit(.{ get(L_X + n8), set(L_A) });
            var off: u32 = 0;
            for (0..8) |i| if (list & (@as(u32, 1) << @intCast(i)) != 0) {
                if (Ld) {
                    load(e, O.i32_load, off);
                    setR(e, @intCast(i));
                } else {
                    b.get(L_X + @as(u32, @intCast(i)));
                    store(e, O.i32_store, off);
                }
                off += 4;
            };
            if (!Ld or list & (@as(u32, 1) << @intCast(n8)) == 0) b.emit(.{ get(L_A), c32(@intCast(off)), O.i32_add, set(L_X + n8) });
        },
        13 => {
            const cc = (h >> 8) & 15;
            if (cc >= 14) {
                e.fallback(pc, k);
                return true;
            }
            const target = pc +% 4 +% @as(u32, @bitCast(bt.sx(i32, h & 255, 8) * 2));
            e.cond(@intCast(cc));
            e.branch(target | 1, (pc + 2) | 1, k);
            return true;
        },
        14 => {
            if (h & (1 << 11) != 0) {
                e.fallback(pc, k);
                return true;
            }
            e.transfer(e.r.blocks[e.blk].taken, (pc +% 4 +% @as(u32, @bitCast(bt.sx(i32, h & 0x7ff, 11) * 2))) | 1, k);
            return true;
        },
        else => {
            const h2: u32 = mem.ld(u16, pc + 2);
            if ((h & 0xf800) != 0xf000 or (h2 & 0xc000) != 0xc000) {
                e.fallback(pc, k);
                return true;
            }
            const Sb = (h >> 10) & 1;
            const I1 = 1 - (((h2 >> 13) & 1) ^ Sb);
            const I2 = 1 - (((h2 >> 11) & 1) ^ Sb);
            const raw = (Sb << 24) | (I1 << 23) | (I2 << 22) | ((h & 0x3ff) << 12) | ((h2 & 0x7ff) << 1);
            const off: u32 = @bitCast(@as(i32, @bitCast(raw << 7)) >> 7);
            b.emit(.{ c32(@bitCast(pc +% 5)), set(L_X + 14) });
            if (h2 & 0x1000 != 0) e.transfer(-1, (pc +% 4 +% off) | 1, k) else e.transfer(-1, ((pc +% 4) & ~@as(u32, 3)) +% (off & ~@as(u32, 3)), k);
            return true;
        },
    }
    return false;
}
fn thumbMisc(e: *Emit, h: u32, pc: u32, k: u32, rd: u32, rn: u32) bool {
    const b = e.b;
    if ((h & 0xff00) == 0xb000) {
        b.emit(.{ get(L_X + 13), c32(@intCast((h & 127) * 4)), if (h & 0x80 != 0) O.i32_sub else O.i32_add, set(L_X + 13) });
        return false;
    }
    if ((h & 0xfe00) == 0xb400) {
        const list = (h & 255) | ((h & 0x100) << 6);
        b.emit(.{ get(L_X + 13), c32(@intCast(@as(u32, @popCount(list)) * 4)), O.i32_sub, tee(L_A), set(L_X + 13) });
        var off: u32 = 0;
        for (0..16) |i| if (list & (@as(u32, 1) << @intCast(i)) != 0) {
            b.get(L_X + @as(u32, @intCast(i)));
            store(e, O.i32_store, off);
            off += 4;
        };
        return false;
    }
    if ((h & 0xfe00) == 0xbc00) {
        const list = (h & 255) | ((h & 0x100) << 7);
        b.emit(.{ get(L_X + 13), tee(L_A), c32(@intCast(@as(u32, @popCount(list)) * 4)), O.i32_add, set(L_X + 13) });
        var off: u32 = 0;
        for (0..15) |i| if (list & (@as(u32, 1) << @intCast(i)) != 0) {
            load(e, O.i32_load, off);
            setR(e, @intCast(i));
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
            b.get(L_X + rn);
            switch (h & 0xffc0) {
                0xb200 => b.byte(O.i32_extend16_s),
                0xb240 => b.byte(O.i32_extend8_s),
                0xb280 => b.emit(.{ c32(0xffff), O.i32_and }),
                else => b.emit(.{ c32(255), O.i32_and }),
            }
            setR(e, rd);
            return false;
        },
        else => {},
    }
    if ((h & 0xf500) == 0xb100) {
        const target = pc + 4 + ((h >> 3) & 31) * 2 + ((h & 0x200) >> 3);
        b.emit(.{ get(L_X + rd), O.i32_eqz });
        if (h & 0x800 != 0) b.byte(O.i32_eqz);
        e.branch(target | 1, (pc + 2) | 1, k);
        return true;
    }
    e.fallback(pc, k);
    return (h & 0xff00) == 0xbe00;
}
