const std = @import("std");
const abi = @import("abi.zig");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const a64 = @import("a64.zig");
const fp = @import("fp.zig");
const simd = @import("simd.zig");
const Cpu = cpu.Cpu;
const Status = cpu.Status;
const Fault = cpu.Fault;

const bits = @import("bits.zig").bits;
const ld = mem.ld;
const st = cpu.st;
inline fn r(c: *Cpu, n: u32) u32 {
    return @truncate(c.x[n]);
}
inline fn set(c: *Cpu, n: u32, v: u32) void {
    c.x[n] = v;
}
inline fn reg(c: *Cpu, n: u32, pc: u32) u32 {
    return if (n == 15) pc +% 8 else r(c, n);
}
inline fn cf(c: *Cpu) u32 {
    return (c.cpsr >> 29) & 1;
}
inline fn setNZ(c: *Cpu, v: u32) void {
    c.cpsr = (c.cpsr & 0x3fff_ffff) | a64.nz(u32, v);
}
inline fn setNZC(c: *Cpu, v: u32, carry: u32) void {
    c.cpsr = (c.cpsr & 0x1fff_ffff) | a64.nz(u32, v) | (carry << 29);
}
fn addFlags(c: *Cpu, a: u32, b: u32, cin: u1) u32 {
    const f = a64.addc(u32, a, b, cin);
    c.setNZCV(f.f);
    return f.r;
}
inline fn subFlags(c: *Cpu, a: u32, b: u32, cin: u1) u32 {
    return addFlags(c, a, ~b, cin);
}
inline fn fault(c: *Cpu, code: Fault, w: u32, pc: u32) Status {
    c.pc = pc;
    return cpu.raise(c, code, w);
}
inline fn badAddr(c: *Cpu, w: u32, pc: u32) Status {
    return fault(c, .bad_address, w, pc);
}
inline fn addr(c: *Cpu, a: u32) ?u32 {
    if (a < abi.LOW) {
        c.fault_addr = a;
        return null;
    }
    return a;
}
inline fn bx(c: *Cpu, target: u32) Status {
    cpu.setPc32(c, target);
    return .jump;
}
inline fn jump(c: *Cpu, target: u32) Status {
    c.pc = target;
    return .jump;
}
pub fn cond(c: *Cpu, cc: u32) bool {
    return a64.cond(c, @intCast(cc));
}
inline fn itState(c: *Cpu) u32 {
    return ((c.cpsr >> 8) & 0xfc) | ((c.cpsr >> 25) & 3);
}
inline fn setItState(c: *Cpu, state: u32) void {
    c.cpsr = (c.cpsr & ~@as(u32, (0x3f << 10) | (3 << 25))) | ((state & 0xfc) << 8) | ((state & 3) << 25);
}
inline fn advanceIt(c: *Cpu, state: u32) void {
    setItState(c, if (state & 7 == 0) 0 else (state & 0xe0) | ((state << 1) & 0x1f));
}

const Shifted = struct { v: u32, carry: u32 };
fn shiftReg(c: *Cpu, kind: u32, v: u32, n: u32) Shifted {
    if (n == 0) return .{ .v = v, .carry = cf(c) };
    switch (kind) {
        0 => return if (n < 32) .{ .v = v << @intCast(n), .carry = (v >> @intCast(32 - n)) & 1 } else .{ .v = 0, .carry = if (n == 32) v & 1 else 0 },
        1 => return if (n < 32) .{ .v = v >> @intCast(n), .carry = (v >> @intCast(n - 1)) & 1 } else .{ .v = 0, .carry = if (n == 32) v >> 31 else 0 },
        2 => return if (n < 32) .{ .v = @bitCast(@as(i32, @bitCast(v)) >> @intCast(n)), .carry = (v >> @intCast(n - 1)) & 1 } else .{ .v = @bitCast(@as(i32, @bitCast(v)) >> 31), .carry = v >> 31 },
        else => {
            const k = n & 31;
            if (k == 0) return .{ .v = v, .carry = v >> 31 };
            return .{ .v = std.math.rotr(u32, v, k), .carry = (v >> @intCast(k - 1)) & 1 };
        },
    }
}
fn shiftImm(c: *Cpu, kind: u32, v: u32, n: u32) Shifted {
    if (n != 0 or kind == 0) return shiftReg(c, kind, v, n);
    return switch (kind) {
        1 => .{ .v = 0, .carry = v >> 31 },
        2 => .{ .v = @bitCast(@as(i32, @bitCast(v)) >> 31), .carry = v >> 31 },
        else => .{ .v = (v >> 1) | (cf(c) << 31), .carry = v & 1 },
    };
}
fn thumbExpandImm(c: *Cpu, imm12: u32) Shifted {
    if (imm12 >> 10 == 0) {
        const imm8 = imm12 & 255;
        const v: u32 = switch ((imm12 >> 8) & 3) {
            0 => imm8,
            1 => imm8 | (imm8 << 16),
            2 => (imm8 << 8) | (imm8 << 24),
            else => imm8 * 0x01010101,
        };
        return .{ .v = v, .carry = cf(c) };
    }
    const rot = (imm12 >> 7) & 31;
    const v = std.math.rotr(u32, 0x80 | (imm12 & 0x7f), rot);
    return .{ .v = v, .carry = v >> 31 };
}

fn neonStruct(c: *Cpu, w: u32, pc: u32) Status {
    const count: u32 = switch (bits(w, 8, 4)) {
        7 => 1,
        10 => 2,
        6 => 3,
        2 => 4,
        else => return fault(c, .unimplemented, w, pc),
    };
    const load = w & (1 << 21) != 0;
    const n = bits(w, 16, 4);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const a = addr(c, r(c, n)) orelse return badAddr(c, w, pc);
    var i: u32 = 0;
    while (i < count) : (i += 1) {
        if (load) vreg(u64, c, d + i).* = ld(u64, a + i * 8) else if (!st(u64, c, a + i * 8, vreg(u64, c, d + i).*)) return badAddr(c, w, pc);
    }
    const m = w & 15;
    if (m != 15) set(c, n, r(c, n) +% (if (m == 13) count * 8 else r(c, m)));
    return .next;
}

fn neonImmediate(c: *Cpu, w: u32, pc: u32, imm8: u32) Status {
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const q = w & 0x40 != 0;
    if (q and d & 1 != 0) return fault(c, .undefined, w, pc);
    const ex = simd.expandImm(bits(w, 5, 1), bits(w, 8, 4), 0, imm8) orelse return fault(c, .undefined, w, pc);
    const count: u32 = if (q) 2 else 1;
    var i: u32 = 0;
    while (i < count) : (i += 1) {
        const dst = vreg(u64, c, d + i);
        dst.* = switch (ex.kind) {
            .movi, .fmov => ex.v,
            .mvni => ~ex.v,
            .orr => dst.* | ex.v,
            .bic => dst.* & ~ex.v,
        };
    }
    return .next;
}

fn op2(c: *Cpu, w: u32, pc: u32) Shifted {
    if (w & (1 << 25) != 0) {
        const rot = bits(w, 8, 4) * 2;
        const imm8 = w & 255;
        if (rot == 0) return .{ .v = imm8, .carry = cf(c) };
        const v = std.math.rotr(u32, imm8, rot);
        return .{ .v = v, .carry = v >> 31 };
    }
    const m = w & 15;
    const kind = bits(w, 5, 2);
    const rm = reg(c, m, pc);
    if (w & (1 << 4) != 0) return shiftReg(c, kind, rm, r(c, bits(w, 8, 4)) & 255);
    const n = bits(w, 7, 5);
    switch (kind) {
        0 => return if (n == 0) .{ .v = rm, .carry = cf(c) } else .{ .v = rm << @intCast(n), .carry = (rm >> @intCast(32 - n)) & 1 },
        1 => return if (n == 0) .{ .v = 0, .carry = rm >> 31 } else .{ .v = rm >> @intCast(n), .carry = (rm >> @intCast(n - 1)) & 1 },
        2 => return if (n == 0) .{ .v = @bitCast(@as(i32, @bitCast(rm)) >> 31), .carry = rm >> 31 } else .{ .v = @bitCast(@as(i32, @bitCast(rm)) >> @intCast(n)), .carry = (rm >> @intCast(n - 1)) & 1 },
        else => return if (n == 0) .{ .v = (rm >> 1) | (cf(c) << 31), .carry = rm & 1 } else .{ .v = std.math.rotr(u32, rm, n), .carry = (rm >> @intCast(n - 1)) & 1 },
    }
}

pub fn step(c: *Cpu, pc: u32) Status {
    return if (c.cpsr & (1 << 5) != 0) execThumb(c, pc) else execArm(c, pc);
}
fn execArm(c: *Cpu, pc: u32) Status {
    const w = ld(u32, pc);
    const cc = w >> 28;
    c.pc = pc + 4;
    if (cc == 15) {
        if (w & 0xff100000 == 0xf4000000) return neonStruct(c, w, pc);
        if (w & 0xfeb00010 == 0xf2800010) return neonImmediate(c, w, pc, (bits(w, 24, 1) << 7) | (bits(w, 16, 3) << 4) | bits(w, 0, 4));
        if ((w & 0x0e000000) == 0x0a000000) {
            const off: u32 = @bitCast((@as(i32, @bitCast(w << 8)) >> 6) | @as(i32, @intCast((w >> 23) & 2)));
            set(c, 14, pc + 4);
            return bx(c, ((pc +% 8 +% off) & ~@as(u32, 1)) | 1);
        }
        if ((w & 0x0d70f000) == 0x0550f000) return .next;
        if ((w & 0x0ff000f0) == 0x05700040 or (w & 0x0ff000f0) == 0x05700050 or (w & 0x0ff000f0) == 0x05700060) return .next;
        if ((w & 0x0fff00ff) == 0x057ff01f) {
            c.excl = 0;
            return .next;
        }
        return fault(c, .undefined, w, pc);
    }
    if (cc != 14 and !cond(c, cc)) return .next;
    const rn = bits(w, 16, 4);
    const rd = bits(w, 12, 4);
    const rs = bits(w, 8, 4);
    const rm = w & 15;
    const top = bits(w, 25, 3);
    switch (top) {
        5 => {
            const off: u32 = @bitCast(@as(i32, @bitCast(w << 8)) >> 6);
            if (w & (1 << 24) != 0) set(c, 14, pc + 4);
            return jump(c, pc +% 8 +% off);
        },
        0, 1 => return dataProcessing(c, w, pc, top, rn, rd, rs, rm),
        2, 3 => {
            if (top == 3 and w & 0x10 != 0) return media(c, w, pc, rd, rn, rm, rs);
            const P = w & (1 << 24) != 0;
            const U = w & (1 << 23) != 0;
            const B = w & (1 << 22) != 0;
            const W = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            const off = if (top == 2) w & 0xfff else op2(c, w & ~@as(u32, 1 << 25), pc).v;
            const base = reg(c, rn, pc);
            const ea = if (U) base +% off else base -% off;
            const a = addr(c, if (P) ea else base) orelse return badAddr(c, w, pc);
            if (P and W) set(c, rn, ea);
            if (Ld) {
                const t: u32 = if (B) ld(u8, a) else ld(u32, a);
                if (!P) set(c, rn, ea);
                if (rd == 15) return bx(c, t);
                set(c, rd, t);
            } else {
                const v = reg(c, rd, pc);
                if (!(if (B) st(u8, c, a, @truncate(v)) else st(u32, c, a, v))) return badAddr(c, w, pc);
                if (!P) set(c, rn, ea);
            }
            return .next;
        },
        4 => {
            const P = w & (1 << 24) != 0;
            const U = w & (1 << 23) != 0;
            const W = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            const list = w & 0xffff;
            const n: u32 = @popCount(list);
            const base = reg(c, rn, pc);
            var a = if (U) (if (P) base +% 4 else base) else (if (P) base -% 4 * n else base -% (4 * n - 4));
            const wb = if (U) base +% 4 * n else base -% 4 * n;
            if (addr(c, a) == null) return badAddr(c, w, pc);
            if (Ld) {
                if (W) set(c, rn, wb);
                var i: u5 = 0;
                var t: u32 = 0;
                while (true) : (i += 1) {
                    if (list & (@as(u32, 1) << i) != 0) {
                        if (i == 15) t = ld(u32, a) else set(c, i, ld(u32, a));
                        a += 4;
                    }
                    if (i == 15) break;
                }
                if (list & 0x8000 != 0) return bx(c, t);
            } else {
                var i: u5 = 0;
                while (true) : (i += 1) {
                    if (list & (@as(u32, 1) << i) != 0) {
                        if (!st(u32, c, a, reg(c, i, pc))) return badAddr(c, w, pc);
                        a += 4;
                    }
                    if (i == 15) break;
                }
                if (W) set(c, rn, wb);
            }
            return .next;
        },
        6 => return vfp(c, w, pc) orelse fault(c, .unimplemented, w, pc),
        7 => {
            if (w & (1 << 24) != 0) return swi(c);
            if ((w & 0x0ff00fff) == 0x0e1d0f70 and bits(w, 8, 4) == 15) {
                set(c, rd, @truncate(c.tls));
                return .next;
            }
            return vfp(c, w, pc) orelse fault(c, .unimplemented, w, pc);
        },
        else => return fault(c, .undefined, w, pc),
    }
}

fn dataProcessing(c: *Cpu, w: u32, pc: u32, top: u32, rn: u32, rd: u32, rs: u32, rm: u32) Status {
    if (top == 0) {
        if ((w & 0x0ff000f0) == 0x01200010) return bx(c, reg(c, rm, pc));
        if ((w & 0x0ff000f0) == 0x01200030) {
            set(c, 14, pc + 4);
            return bx(c, reg(c, rm, pc));
        }
        if ((w & 0x0ff000f0) == 0x01200070) return fault(c, .brk, w, pc);
        if ((w & 0x0fff0ff0) == 0x016f0f10) {
            set(c, rd, @clz(reg(c, rm, pc)));
            return .next;
        }
        if ((w & 0x0fbf0fff) == 0x010f0000) {
            set(c, rd, c.cpsr | 0x10);
            return .next;
        }
        if ((w & 0x0fc000f0) == 0x00000090) {
            var v = reg(c, rm, pc) *% reg(c, rs, pc);
            if (w & (1 << 21) != 0) v +%= r(c, rd);
            set(c, rn, v);
            if (w & (1 << 20) != 0) setNZ(c, v);
            return .next;
        }
        if ((w & 0x0f8000f0) == 0x00800090) {
            const signed = w & (1 << 22) != 0;
            var p: u64 = if (signed) @bitCast(@as(i64, @as(i32, @bitCast(reg(c, rm, pc)))) *% @as(i64, @as(i32, @bitCast(reg(c, rs, pc))))) else @as(u64, reg(c, rm, pc)) *% @as(u64, reg(c, rs, pc));
            if (w & (1 << 21) != 0) p +%= (@as(u64, r(c, rn)) << 32) | r(c, rd);
            set(c, rd, @truncate(p));
            set(c, rn, @intCast(p >> 32));
            if (w & (1 << 20) != 0) c.cpsr = (c.cpsr & 0x3fff_ffff) | (@as(u32, @intCast(p >> 63)) << 31) | (@as(u32, @intFromBool(p == 0)) << 30);
            return .next;
        }
        if ((w & 0x0fb000f0) == 0x01000090) {
            const byte = w & (1 << 22) != 0;
            const a = addr(c, reg(c, rn, pc)) orelse return badAddr(c, w, pc);
            const t: u32 = if (byte) ld(u8, a) else ld(u32, a);
            if (!(if (byte) st(u8, c, a, @truncate(reg(c, rm, pc))) else st(u32, c, a, reg(c, rm, pc)))) return badAddr(c, w, pc);
            set(c, rd, t);
            return .next;
        }
        if ((w & 0x0f9000f0) == 0x01800090) {
            const Ld = w & (1 << 20) != 0;
            const sz = bits(w, 21, 2);
            const a = addr(c, reg(c, rn, pc)) orelse return badAddr(c, w, pc);
            if (Ld) {
                c.excl = 1;
                switch (sz) {
                    0 => set(c, rd, ld(u32, a)),
                    2 => set(c, rd, ld(u8, a)),
                    3 => set(c, rd, ld(u16, a)),
                    else => {
                        set(c, rd, ld(u32, a));
                        set(c, rd + 1, ld(u32, a + 4));
                    },
                }
            } else {
                const ok = switch (sz) {
                    0 => st(u32, c, a, r(c, rm)),
                    2 => st(u8, c, a, @truncate(r(c, rm))),
                    3 => st(u16, c, a, @truncate(r(c, rm))),
                    else => st(u32, c, a, r(c, rm)) and st(u32, c, a + 4, r(c, rm + 1)),
                };
                if (!ok) return badAddr(c, w, pc);
                set(c, rd, c.excl ^ 1);
                c.excl = 0;
            }
            return .next;
        }
        if ((w & 0x0f900090) == 0x01000080) {
            const o = bits(w, 21, 2);
            const x = bits(w, 5, 1);
            const y = bits(w, 6, 1);
            const half = struct {
                fn f(v: u32, h: u32) i32 {
                    return if (h != 0) @as(i32, @bitCast(v)) >> 16 else @as(i16, @bitCast(@as(u16, @truncate(v))));
                }
            }.f;
            const m = reg(c, rm, pc);
            const s = reg(c, rs, pc);
            switch (o) {
                0 => set(c, rn, @bitCast(half(m, x) *% half(s, y) +% @as(i32, @bitCast(r(c, rd))))),
                3 => set(c, rn, @bitCast(half(m, x) *% half(s, y))),
                1 => {
                    const p: i64 = @as(i64, @as(i32, @bitCast(m))) * @as(i64, half(s, y));
                    var v: u32 = @truncate(@as(u64, @bitCast(p)) >> 16);
                    if (x == 0) v +%= r(c, rd);
                    set(c, rn, v);
                },
                else => {
                    const p: u64 = @bitCast(@as(i64, half(m, x)) * @as(i64, half(s, y)));
                    const acc = ((@as(u64, r(c, rn)) << 32) | r(c, rd)) +% p;
                    set(c, rd, @truncate(acc));
                    set(c, rn, @intCast(acc >> 32));
                },
            }
            return .next;
        }
        if ((w & 0x0f9000f0) == 0x01000050) {
            const o = bits(w, 21, 2);
            const n: i64 = @as(i32, @bitCast(reg(c, rn, pc)));
            const dbl: i64 = if (o & 2 != 0) sat32(c, n * 2) else n;
            const m: i64 = @as(i32, @bitCast(reg(c, rm, pc)));
            set(c, rd, @bitCast(@as(i32, @intCast(sat32(c, if (o & 1 != 0) m - dbl else m + dbl)))));
            return .next;
        }
        if ((w & 0x0e000090) == 0x00000090) {
            const P = w & (1 << 24) != 0;
            const U = w & (1 << 23) != 0;
            const I = w & (1 << 22) != 0;
            const W = w & (1 << 21) != 0;
            const Ld = w & (1 << 20) != 0;
            const sh = bits(w, 5, 2);
            const off = if (I) ((w >> 4) & 0xf0) | (w & 15) else reg(c, rm, pc);
            const base = reg(c, rn, pc);
            const ea = if (U) base +% off else base -% off;
            const a = addr(c, if (P) ea else base) orelse return badAddr(c, w, pc);
            if (P and W) set(c, rn, ea);
            if (Ld) {
                switch (sh) {
                    1 => set(c, rd, ld(u16, a)),
                    2 => set(c, rd, sxb(ld(u8, a))),
                    3 => set(c, rd, sxh(ld(u16, a))),
                    else => return fault(c, .unimplemented, w, pc),
                }
            } else switch (sh) {
                1 => if (!st(u16, c, a, @truncate(r(c, rd)))) return badAddr(c, w, pc),
                2 => {
                    set(c, rd, ld(u32, a));
                    set(c, rd + 1, ld(u32, a + 4));
                },
                3 => if (!st(u32, c, a, r(c, rd)) or !st(u32, c, a + 4, r(c, rd + 1))) return badAddr(c, w, pc),
                else => return fault(c, .unimplemented, w, pc),
            }
            if (!P) set(c, rn, ea);
            if (Ld and rd == 15) return bx(c, r(c, 15));
            return .next;
        }
    }
    if ((w & 0x0db0f000) == 0x0120f000 and (top == 1 or (w & 0xf0) == 0)) {
        const src = if (top == 1) op2(c, w, pc).v else reg(c, rm, pc);
        if (w & (1 << 19) != 0) c.cpsr = (c.cpsr & 0x07ff_ffff) | (src & 0xf800_0000);
        return .next;
    }
    if (top == 1 and (w & 0x0fb00000) == 0x03000000) {
        const imm16 = ((w >> 4) & 0xf000) | (w & 0xfff);
        set(c, rd, if (w & (1 << 22) != 0) (r(c, rd) & 0xffff) | (imm16 << 16) else imm16);
        return .next;
    }
    const o = bits(w, 21, 4);
    const setf = w & (1 << 20) != 0;
    const t = op2(c, w, pc);
    const a = reg(c, rn, pc);
    const logical = o < 2 or o == 8 or o == 9 or o >= 12;
    const v: u32 = if (logical) logic(o, a, t.v) else switch (o) {
        2, 10 => if (setf) subFlags(c, a, t.v, 1) else a -% t.v,
        3 => if (setf) subFlags(c, t.v, a, 1) else t.v -% a,
        4, 11 => if (setf) addFlags(c, a, t.v, 0) else a +% t.v,
        5 => if (setf) addFlags(c, a, t.v, @intCast(cf(c))) else a +% t.v +% cf(c),
        6 => if (setf) subFlags(c, a, t.v, @intCast(cf(c))) else a -% t.v -% 1 +% cf(c),
        else => if (setf) subFlags(c, t.v, a, @intCast(cf(c))) else t.v -% a -% 1 +% cf(c),
    };
    if (setf and logical) setNZC(c, v, t.carry);
    if (o < 8 or o > 11) {
        if (rd == 15) return bx(c, v);
        set(c, rd, v);
    }
    return .next;
}
fn logic(o: u32, a: u32, t: u32) u32 {
    return switch (o & 7) {
        0 => a & t,
        1 => a ^ t,
        4 => a | t,
        5 => t,
        6 => a & ~t,
        else => ~t,
    };
}
inline fn sxb(v: u32) u32 {
    return @bitCast(@as(i32, @as(i8, @bitCast(@as(u8, @truncate(v))))));
}
inline fn sxh(v: u32) u32 {
    return @bitCast(@as(i32, @as(i16, @bitCast(@as(u16, @truncate(v))))));
}
inline fn rev16(v: u32) u32 {
    return ((v & 0xff00ff) << 8) | ((v >> 8) & 0xff00ff);
}
fn sat32(c: *Cpu, v: i64) i64 {
    if (v > std.math.maxInt(i32)) {
        c.cpsr |= 1 << 27;
        return std.math.maxInt(i32);
    }
    if (v < std.math.minInt(i32)) {
        c.cpsr |= 1 << 27;
        return std.math.minInt(i32);
    }
    return v;
}

fn media(c: *Cpu, w: u32, pc: u32, rd: u32, rn: u32, rm: u32, rs: u32) Status {
    const op1 = bits(w, 20, 5);
    const op2b = bits(w, 5, 3);
    const RM = reg(c, rm, pc);
    const RN = reg(c, rn, pc);
    if ((w & 0x0fe00070) == 0x07c00010) {
        const lsb = bits(w, 7, 5);
        const msb = bits(w, 16, 5);
        const width = msb -% lsb +% 1;
        const mask: u32 = if (width >= 32) 0xffff_ffff else ((@as(u32, 1) << @intCast(width)) - 1) << @intCast(lsb);
        set(c, rd, if (rn == 15) r(c, rd) & ~mask else (r(c, rd) & ~mask) | ((RN << @intCast(lsb)) & mask));
        return .next;
    }
    if ((w & 0x0fa00070) == 0x07a00050) {
        const lsb = bits(w, 7, 5);
        const width = bits(w, 16, 5) + 1;
        if (w & (1 << 22) != 0) {
            set(c, rd, if (width == 32) RM >> @intCast(lsb) else (RM >> @intCast(lsb)) & ((@as(u32, 1) << @intCast(width)) - 1));
        } else {
            const sh: u5 = @intCast(32 - width);
            set(c, rd, @bitCast(@as(i32, @bitCast(RM << @intCast(32 - lsb - width))) >> sh));
        }
        return .next;
    }
    if (op1 >= 8 and op1 <= 15 and (op2b & 3) == 3) {
        const rot = bits(w, 10, 2) * 8;
        const rotated = std.math.rotr(u32, RM, rot);
        const add: u32 = if (rn == 15) 0 else RN;
        const v: u32 = switch (op1) {
            10 => add +% sxb(rotated),
            11 => add +% sxh(rotated),
            14 => add +% (rotated & 255),
            15 => add +% (rotated & 65535),
            8 => (sxb(rotated) & 0xffff) | (sxb(rotated >> 16) << 16),
            12 => rotated & 0xff00ff,
            else => return fault(c, .unimplemented, w, pc),
        };
        set(c, rd, v);
        return .next;
    }
    if ((w & 0x0fff0ff0) == 0x06bf0f30) {
        set(c, rd, @byteSwap(RM));
        return .next;
    }
    if ((w & 0x0fff0ff0) == 0x06bf0fb0) {
        set(c, rd, rev16(RM));
        return .next;
    }
    if ((w & 0x0fff0ff0) == 0x06ff0fb0) {
        set(c, rd, sxh(@byteSwap(@as(u16, @truncate(RM)))));
        return .next;
    }
    if ((w & 0x0ff00ff0) == 0x06800fb0) {
        const ge = bits(c.cpsr, 16, 4);
        var v: u32 = 0;
        var i: u5 = 0;
        while (i < 4) : (i += 1) {
            const m: u32 = @as(u32, 0xff) << (8 * i);
            v |= (if ((ge >> i) & 1 != 0) RN else RM) & m;
        }
        set(c, rd, v);
        return .next;
    }
    if ((w & 0x0fe00030) == 0x06a00010 or (w & 0x0fe00030) == 0x06e00010) {
        const sh = bits(w, 7, 5);
        const satb = bits(w, 16, 5);
        const shifted: i64 = if (w & (1 << 6) != 0) @as(i32, @bitCast(RN)) >> @intCast(if (sh == 0) 31 else sh) else @as(i64, @as(i32, @bitCast(RN))) << @intCast(sh);
        if (w & (1 << 22) != 0) {
            const max: i64 = (@as(i64, 1) << @intCast(satb)) - 1;
            set(c, rd, @intCast(@min(@max(shifted, 0), max)));
        } else {
            const hi: i64 = (@as(i64, 1) << @intCast(satb)) - 1;
            const lo: i64 = -(@as(i64, 1) << @intCast(satb));
            set(c, rd, @bitCast(@as(i32, @intCast(@min(@max(shifted, lo), hi)))));
        }
        return .next;
    }
    if ((w & 0x0ff00030) == 0x06800010) {
        const sh = bits(w, 7, 5);
        if (w & (1 << 6) != 0) set(c, rd, (RN & 0xffff0000) | (@as(u32, @bitCast(@as(i32, @bitCast(RM)) >> @intCast(if (sh == 0) 31 else sh))) & 0xffff)) else set(c, rd, (RN & 0xffff) | ((RM << @intCast(sh)) & 0xffff0000));
        return .next;
    }
    if ((w & 0x0ff000f0) == 0x07800010) {
        const s = reg(c, rs, pc);
        var sum: u32 = if (rd == 15) 0 else r(c, rd);
        var i: u5 = 0;
        while (i < 4) : (i += 1) sum +%= @abs(@as(i32, @intCast((RM >> (8 * i)) & 255)) - @as(i32, @intCast((s >> (8 * i)) & 255)));
        set(c, rn, sum);
        return .next;
    }
    if ((w & 0x0ff000f0) == 0x0700f010) {
        set(c, rn, RM *% reg(c, rs, pc));
        return .next;
    }
    if ((w & 0x0ff0f0f0) == 0x0750f010 or (w & 0x0ff000f0) == 0x07500010) {
        const p: i64 = @as(i64, @as(i32, @bitCast(RM))) * @as(i64, @as(i32, @bitCast(reg(c, rs, pc))));
        var v: u32 = @truncate(@as(u64, @bitCast(p)) >> 32);
        if ((w & 0x0ff0f0f0) != 0x0750f010) v +%= r(c, rd);
        set(c, rn, v);
        return .next;
    }
    return fault(c, .unimplemented, w, pc);
}

fn swi(c: *Cpu) Status {
    switch (r(c, 7)) {
        0xf0002 => {
            cpu.invalidate_range(r(c, 0), r(c, 1) -% r(c, 0));
            set(c, 0, 0);
        },
        0xf0005 => {
            c.tls = r(c, 0);
            set(c, 0, 0);
        },
        175 => {
            c.exit = 175;
            return .syscall;
        },
        20 => set(c, 0, 4242),
        224 => set(c, 0, 4242 + c.tid),
        // every other number is the host's: it serves the same table as libc's syscall(2)
        else => {
            c.exit = r(c, 7);
            return .syscall;
        },
    }
    return .jump;
}

inline fn vreg(comptime T: type, c: *Cpu, n: u32) *align(@sizeOf(T)) T {
    const per = 16 / @sizeOf(T);
    return @ptrCast(@alignCast(&c.v[n / per][(n % per) * @sizeOf(T)]));
}
fn vfp(c: *Cpu, w: u32, pc: u32) ?Status {
    const cp = bits(w, 8, 4);
    if (cp != 10 and cp != 11) return null;
    const dp = cp == 11;
    const top = bits(w, 24, 4);
    const Dd = bits(w, 22, 1);
    const N = bits(w, 7, 1);
    const M = bits(w, 5, 1);
    const vd = bits(w, 12, 4);
    const vn = bits(w, 16, 4);
    const vm = bits(w, 0, 4);
    const d = if (dp) (Dd << 4) | vd else (vd << 1) | Dd;
    const n = if (dp) (N << 4) | vn else (vn << 1) | N;
    const m = if (dp) (M << 4) | vm else (vm << 1) | M;
    if (top == 12 or top == 13) {
        const P = bits(w, 24, 1) != 0;
        const U = bits(w, 23, 1) != 0;
        const W = bits(w, 21, 1) != 0;
        const Ld = bits(w, 20, 1) != 0;
        const rn = bits(w, 16, 4);
        const imm8 = w & 255;
        if (top == 12 and !P and !W and bits(w, 21, 2) == 2) {
            const rt = bits(w, 12, 4);
            const rt2 = bits(w, 16, 4);
            const lo = if (dp) m * 2 else m;
            if (Ld) {
                set(c, rt, vreg(u32, c, lo).*);
                set(c, rt2, vreg(u32, c, lo + 1).*);
            } else {
                vreg(u32, c, lo).* = r(c, rt);
                vreg(u32, c, lo + 1).* = r(c, rt2);
            }
            return .next;
        }
        if (P and !W) {
            const base = if (rn == 15) (pc +% 8) & ~@as(u32, 3) else r(c, rn);
            const a = addr(c, if (U) base +% imm8 * 4 else base -% imm8 * 4) orelse return badAddr(c, w, pc);
            if (Ld) {
                if (dp) vreg(u32, c, d * 2).* = ld(u32, a) else vreg(u32, c, d).* = ld(u32, a);
                if (dp) vreg(u32, c, d * 2 + 1).* = ld(u32, a + 4);
            } else {
                if (!st(u32, c, a, vreg(u32, c, if (dp) d * 2 else d).*)) return badAddr(c, w, pc);
                if (dp and !st(u32, c, a + 4, vreg(u32, c, d * 2 + 1).*)) return badAddr(c, w, pc);
            }
            return .next;
        }
        const count = if (dp) imm8 >> 1 else imm8;
        const nbytes = imm8 * 4;
        var a = addr(c, if (U) r(c, rn) else r(c, rn) -% nbytes) orelse return badAddr(c, w, pc);
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            const words: u32 = if (dp) 2 else 1;
            var k: u32 = 0;
            while (k < words) : (k += 1) {
                const slot = if (dp) (d + i) * 2 + k else d + i;
                if (Ld) vreg(u32, c, slot).* = ld(u32, a) else if (!st(u32, c, a, vreg(u32, c, slot).*)) return badAddr(c, w, pc);
                a += 4;
            }
        }
        if (W) set(c, rn, if (U) r(c, rn) +% nbytes else r(c, rn) -% nbytes);
        return .next;
    }
    if (top != 14) return null;
    if (w & 0x10 != 0) {
        const rt = bits(w, 12, 4);
        const o = bits(w, 21, 3);
        const Ld = bits(w, 20, 1) != 0;
        if (o == 0 and !dp) {
            if (Ld) set(c, rt, vreg(u32, c, n).*) else vreg(u32, c, n).* = reg(c, rt, pc);
            return .next;
        }
        if (o == 7 and !dp) {
            if (Ld) {
                if (vn == 1) {
                    if (rt == 15) c.cpsr = (c.cpsr & 0x0fff_ffff) | (c.fpcr & 0xf000_0000) else set(c, rt, c.fpcr);
                } else set(c, rt, if (vn == 0) 0x410330c0 else if (vn == 6) 0x11111111 else if (vn == 7) 0x00011100 else 0);
            } else if (vn == 1) c.fpcr = r(c, rt);
            return .next;
        }
        if (dp and (o == 0 or o == 1) and (w & 0x60) == 0) {
            const lane = n * 2 + (o & 1);
            if (Ld) set(c, rt, vreg(u32, c, lane).*) else vreg(u32, c, lane).* = reg(c, rt, pc);
            return .next;
        }
        return null;
    }
    return if (dp) vfpArith(f64, c, w, d, n, m) else vfpArith(f32, c, w, d, n, m);
}
fn vfpArith(comptime F: type, c: *Cpu, w: u32, d: u32, n: u32, m: u32) ?Status {
    const dp = F == f64;
    const opc1 = bits(w, 20, 4) & 0xb;
    const o6 = bits(w, 6, 1) != 0;
    const vd = vreg(F, c, d).*;
    const vn = vreg(F, c, n).*;
    const vm = vreg(F, c, m).*;
    switch (opc1) {
        0x0 => vreg(F, c, d).* = if (o6) vd - vn * vm else vd + vn * vm,
        0x1 => vreg(F, c, d).* = if (o6) -vd - vn * vm else -vd + vn * vm,
        0x2 => vreg(F, c, d).* = if (o6) -(vn * vm) else vn * vm,
        0x3 => vreg(F, c, d).* = if (o6) vn - vm else vn + vm,
        0x8 => {
            if (o6) return null;
            vreg(F, c, d).* = vn / vm;
        },
        0x9 => vreg(F, c, d).* = if (o6) fp.fma(F, -vn, vm, -vd) else fp.fma(F, vn, vm, -vd),
        0xa => vreg(F, c, d).* = if (o6) fp.fma(F, -vn, vm, vd) else fp.fma(F, vn, vm, vd),
        0xb => {
            if (!o6) {
                const imm = @import("simd.zig").vfpImm(bits(w, 16, 4) << 4 | (w & 15), dp);
                if (dp) vreg(u32, c, d * 2).* = @truncate(imm) else vreg(u32, c, d).* = @truncate(imm);
                if (dp) vreg(u32, c, d * 2 + 1).* = @intCast(imm >> 32);
                return .next;
            }
            const opc2 = bits(w, 16, 4);
            const o7 = bits(w, 7, 1) != 0;
            switch (opc2) {
                0 => vreg(F, c, d).* = if (o7) @abs(vm) else vm,
                1 => vreg(F, c, d).* = if (o7) @sqrt(vm) else -vm,
                4, 5 => c.fpcr = (c.fpcr & 0x0fff_ffff) | fp.fcmp(vd, if (opc2 == 5) @as(F, 0) else vm),
                7 => {
                    if (!o7) return null;
                    if (dp) vreg(f32, c, (bits(w, 12, 4) << 1) | bits(w, 22, 1)).* = @floatCast(vm) else vreg(f64, c, (bits(w, 22, 1) << 4) | bits(w, 12, 4)).* = vreg(f32, c, m).*;
                },
                8 => {
                    const src = vreg(u32, c, (bits(w, 0, 4) << 1) | bits(w, 5, 1)).*;
                    vreg(F, c, d).* = if (o7) @floatFromInt(@as(i32, @bitCast(src))) else @floatFromInt(src);
                },
                12, 13 => {
                    const t = if (o7) @trunc(vm) else fp.rne(F, vm);
                    const dst = vreg(u32, c, (bits(w, 12, 4) << 1) | bits(w, 22, 1));
                    dst.* = if (opc2 == 13) @bitCast(fp.toInt(i32, t)) else fp.toInt(u32, t);
                },
                else => return null,
            }
        },
        else => return null,
    }
    return .next;
}

fn execThumb(c: *Cpu, pc: u32) Status {
    const h: u32 = ld(u16, pc);
    c.pc = pc + 2;
    const currentIt = itState(c);
    if (currentIt != 0) {
        advanceIt(c, currentIt);
        if (!cond(c, currentIt >> 4)) {
            if ((h & 0xf800) >= 0xe800) c.pc = pc + 4;
            return .next;
        }
    }
    if ((h & 0xf800) >= 0xe800) {
        const h2: u32 = ld(u16, pc + 2);
        if (execThumb32(c, h, h2, pc)) |status| return status;
    }
    return execThumb16(c, h, pc, currentIt);
}

inline fn execThumb32(c: *Cpu, h: u32, second: u32, pc: u32) ?Status {
        const cp = (second >> 8) & 15;
        if (cp == 10 or cp == 11) {
            if (vfp(c, h << 16 | second, pc -% 4)) |status| {
                if (status != .fault) c.pc = pc + 4;
                return status;
            }
        }
    if (execThumb32Data(c, h, pc)) |status| return status;
    if (execThumb32Transfers(c, h, pc)) |status| return status;
    if (execThumb32Branches(c, h, pc)) |status| return status;
    return execThumb32Late(c, h, pc);
}

inline fn execThumb32Data(c: *Cpu, h: u32, pc: u32) ?Status {
    if ((h & 0xefb0) == 0xef80) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0x10 == 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const imm8 = ((h >> 5) & 0x80) | ((h & 7) << 4) | (h2 & 15);
        return neonImmediate(c, h << 16 | h2, pc, imm8);
    }
    const wideMoveImm = h & 0xfbef;
    if (wideMoveImm == 0xf04f or wideMoveImm == 0xf06f) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0x8000 == 0) {
            c.pc = pc + 4;
            const imm12 = (((h >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 255);
            const expanded = thumbExpandImm(c, imm12);
            const out = if (wideMoveImm == 0xf06f) ~expanded.v else expanded.v;
            set(c, (h2 >> 8) & 15, out);
            if (h & 0x10 != 0) setNZC(c, out, expanded.carry);
            return .next;
        }
    }
    if ((h & 0xfa00) == 0xf000) {
        const h2: u32 = ld(u16, pc + 2);
        const op = (h >> 5) & 15;
        if (h2 & 0x8000 == 0 and (op <= 4 or op == 8 or op == 10 or op == 11 or op == 13 or op == 14)) {
            c.pc = pc + 4;
            const imm12 = (((h >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 255);
            const expanded = thumbExpandImm(c, imm12);
            const imm = expanded.v;
            const n = h & 15;
            const d = (h2 >> 8) & 15;
            const S = h & 0x10 != 0;
            const out = switch (op) {
                0 => r(c, n) & imm,
                1 => r(c, n) & ~imm,
                2 => r(c, n) | imm,
                3 => r(c, n) | ~imm,
                4 => r(c, n) ^ imm,
                8 => if (S) addFlags(c, r(c, n), imm, 0) else r(c, n) +% imm,
                10 => if (S) addFlags(c, r(c, n), imm, @intCast(cf(c))) else r(c, n) +% imm +% cf(c),
                11 => if (S) subFlags(c, r(c, n), imm, @intCast(cf(c))) else r(c, n) -% imm -% (1 - cf(c)),
                13 => if (S) subFlags(c, r(c, n), imm, 1) else r(c, n) -% imm,
                else => if (S) subFlags(c, imm, r(c, n), 1) else imm -% r(c, n),
            };
            if (S and op <= 4) setNZC(c, out, expanded.carry);
            if (d != 15) set(c, d, out);
            return .next;
        }
    }
    if ((h & 0xfff0) == 0xf3c0) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0x8000 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const lsb = (((h2 >> 12) & 7) << 2) | ((h2 >> 6) & 3);
        const width = (h2 & 31) + 1;
        const mask = if (width == 32) ~@as(u32, 0) else (@as(u32, 1) << @intCast(width)) - 1;
        set(c, (h2 >> 8) & 15, (r(c, h & 15) >> @intCast(lsb)) & mask);
        return .next;
    }
    if ((h & 0xfff0) == 0xfab0) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0xf0f0 == 0xf080 and (h & 15) == (h2 & 15)) {
            c.pc = pc + 4;
            set(c, (h2 >> 8) & 15, @clz(r(c, h & 15)));
            return .next;
        }
    }
    if ((h & 0xff80) == 0xfa00) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0xf0f0 == 0xf000) {
            c.pc = pc + 4;
            const shifted = shiftReg(c, (h >> 5) & 3, r(c, h & 15), r(c, h2 & 15) & 255);
            set(c, (h2 >> 8) & 15, shifted.v);
            if (h & 0x10 != 0) setNZC(c, shifted.v, shifted.carry);
            return .next;
        }
    }
    if ((h & 0xfe00) == 0xea00) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0x8000 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        const op = (h >> 5) & 15;
        if (op <= 4 or op == 8 or op == 13) {
            c.pc = pc + 4;
            const shifted = shiftImm(c, (h2 >> 4) & 3, r(c, h2 & 15), (((h2 >> 12) & 7) << 2) | ((h2 >> 6) & 3));
            const n = h & 15;
            const d = (h2 >> 8) & 15;
            const S = h & 0x10 != 0;
            const lhs = if (n == 15 and op <= 4) 0 else r(c, n);
            const out = switch (op) {
                0 => lhs & shifted.v,
                1 => lhs & ~shifted.v,
                2 => lhs | shifted.v,
                3 => lhs | ~shifted.v,
                4 => lhs ^ shifted.v,
                8 => if (S) addFlags(c, lhs, shifted.v, 0) else lhs +% shifted.v,
                else => if (S) subFlags(c, lhs, shifted.v, 1) else lhs -% shifted.v,
            };
            if (S and op <= 4) setNZC(c, out, shifted.carry);
            if (d != 15) set(c, d, out);
            return .next;
        }
    }
    if ((h & 0xfff0) == 0xfb00) {
        const h2: u32 = ld(u16, pc + 2);
        const op = (h2 >> 4) & 15;
        const a = h2 >> 12;
        if ((op == 0 or op == 1) and (op == 0 or a != 15)) {
            c.pc = pc + 4;
            const product = r(c, h & 15) *% r(c, h2 & 15);
            set(c, (h2 >> 8) & 15, if (a == 15) product else if (op == 0) product +% r(c, a) else r(c, a) -% product);
            return .next;
        }
    }
    return null;
}

inline fn execThumb32Transfers(c: *Cpu, h: u32, pc: u32) ?Status {
    if ((h & 0xfff0) == 0xe8d0) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0xffe0 == 0xf000) {
            c.pc = pc + 4;
            const half = h2 & 0x10 != 0;
            const base = if ((h & 15) == 15) pc + 4 else r(c, h & 15);
            const index = r(c, h2 & 15);
            const a = addr(c, base +% if (half) index * 2 else index) orelse return badAddr(c, h << 16 | h2, pc);
            const off: u32 = if (half) ld(u16, a) else ld(u8, a);
            return jump(c, pc +% 4 +% off * 2);
        }
    }
    if ((h & 0xffe0) == 0xe840) {
        const h2: u32 = ld(u16, pc + 2);
        const load = h & 0x10 != 0;
        const n = h & 15;
        const a = addr(c, r(c, n) +% (h2 & 255) * 4) orelse return badAddr(c, h << 16 | h2, pc);
        if ((load and h2 & 0x0f00 != 0x0f00) or (!load and h2 & 0x0f00 == 0x0f00)) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        if (load) {
            set(c, h2 >> 12, ld(u32, a));
            c.excl = 1;
        } else {
            const d = (h2 >> 8) & 15;
            if (c.excl != 0 and !st(u32, c, a, r(c, h2 >> 12))) return badAddr(c, h << 16 | h2, pc);
            set(c, d, c.excl ^ 1);
            c.excl = 0;
        }
        return .next;
    }
    if ((h & 0xfe40) == 0xe840) {
        const h2: u32 = ld(u16, pc + 2);
        c.pc = pc + 4;
        const P = h & 0x100 != 0;
        const U = h & 0x80 != 0;
        const W = h & 0x20 != 0;
        const Ld = h & 0x10 != 0;
        if (!P and !W) return fault(c, .undefined, h << 16 | h2, pc);
        const n = h & 15;
        const base = r(c, n);
        const off = (h2 & 255) * 4;
        const indexed = if (U) base +% off else base -% off;
        const a = addr(c, if (P) indexed else base) orelse return badAddr(c, h << 16 | h2, pc);
        const t = h2 >> 12;
        const t2 = (h2 >> 8) & 15;
        if (Ld) {
            set(c, t, ld(u32, a));
            set(c, t2, ld(u32, a + 4));
        } else {
            if (!st(u32, c, a, r(c, t)) or !st(u32, c, a + 4, r(c, t2))) return badAddr(c, h << 16 | h2, pc);
        }
        if (W) set(c, n, indexed);
        return .next;
    }
    if ((h & 0xfe40) == 0xe800) {
        const list: u32 = ld(u16, pc + 2);
        c.pc = pc + 4;
        const before = h & 0x100 != 0;
        const W = h & 0x20 != 0;
        const Ld = h & 0x10 != 0;
        const n = h & 15;
        const count: u32 = @popCount(list);
        const base = r(c, n);
        var a = if (before) base -% count * 4 else base;
        if (addr(c, a) == null) return badAddr(c, h << 16 | list, pc);
        var t: u5 = 0;
        var loadedPc: u32 = 0;
        while (true) : (t += 1) {
            if (list & (@as(u32, 1) << t) != 0) {
                if (Ld) {
                    if (t == 15) loadedPc = ld(u32, a) else set(c, t, ld(u32, a));
                } else if (!st(u32, c, a, r(c, t))) return badAddr(c, h << 16 | list, pc);
                a += 4;
            }
            if (t == 15) break;
        }
        if (W) set(c, n, if (before) base -% count * 4 else base +% count * 4);
        if (Ld and list & 0x8000 != 0) return bx(c, loadedPc);
        return .next;
    }
    if (h == 0xf3bf) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0xfff0 == 0x8f20 or h2 & 0xfff0 == 0x8f40 or h2 & 0xfff0 == 0x8f50 or h2 & 0xfff0 == 0x8f60) {
            c.pc = pc + 4;
            if (h2 & 0xfff0 == 0x8f20) c.excl = 0;
            return .next;
        }
    }
    return null;
}

inline fn execThumb32Branches(c: *Cpu, h: u32, pc: u32) ?Status {
    if ((h & 0xf800) == 0xf000) {
        const h2: u32 = ld(u16, pc + 2);
        const cc = (h >> 6) & 15;
        if ((h2 & 0xd000) == 0x8000 and cc < 14) {
            c.pc = pc + 4;
            const raw = (((h >> 10) & 1) << 20) | (((h2 >> 11) & 1) << 19) | (((h2 >> 13) & 1) << 18) | ((h & 0x3f) << 12) | ((h2 & 0x7ff) << 1);
            const off: u32 = @bitCast(@as(i32, @bitCast(raw << 11)) >> 11);
            if (cond(c, cc)) return jump(c, pc +% 4 +% off);
            return .next;
        }
        if ((h2 & 0xd000) == 0x9000) {
            c.pc = pc + 4;
            const Sb = (h >> 10) & 1;
            const I1 = 1 - (((h2 >> 13) & 1) ^ Sb);
            const I2 = 1 - (((h2 >> 11) & 1) ^ Sb);
            const raw = (Sb << 24) | (I1 << 23) | (I2 << 22) | ((h & 0x3ff) << 12) | ((h2 & 0x7ff) << 1);
            const off: u32 = @bitCast(@as(i32, @bitCast(raw << 7)) >> 7);
            return jump(c, pc +% 4 +% off);
        }
    }
    return null;
}

inline fn execThumb32Late(c: *Cpu, h: u32, pc: u32) ?Status {
    if ((h & 0xff90) == 0xf900) {
        const h2: u32 = ld(u16, pc + 2);
        c.pc = pc + 4;
        return neonStruct(c, h << 16 | h2, pc);
    }
    const wideMove = h & 0xfbf0;
    if (wideMove == 0xf240 or wideMove == 0xf2c0) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0x8000 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const d = (h2 >> 8) & 15;
        const imm = ((h & 15) << 12) | (((h >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 255);
        set(c, d, if (wideMove == 0xf2c0) (r(c, d) & 0xffff) | (imm << 16) else imm);
        return .next;
    }
    const wideAddress = h & 0xfbe0;
    if (wideAddress == 0xf200 or wideAddress == 0xf2a0) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0x8000 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const imm = (((h >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 255);
        const n = h & 15;
        const base = if (n == 15) (pc + 4) & ~@as(u32, 3) else r(c, n);
        set(c, (h2 >> 8) & 15, if (wideAddress == 0xf2a0) base -% imm else base +% imm);
        return .next;
    }
    if ((h & 0xff80) == 0xf880 and ((h >> 5) & 3) < 3) {
        const h2: u32 = ld(u16, pc + 2);
        c.pc = pc + 4;
        const Ld = h & 0x10 != 0;
        const size = (h >> 5) & 3;
        const t = h2 >> 12;
        const n = h & 15;
        const base = if (n == 15 and Ld) (pc +% 4) & ~@as(u32, 3) else r(c, n);
        const a = addr(c, base +% (h2 & 0xfff)) orelse return badAddr(c, h << 16 | h2, pc);
        if (Ld) {
            const value: u32 = switch (size) {
                0 => ld(u8, a),
                1 => ld(u16, a),
                else => ld(u32, a),
            };
            if (t == 15) return bx(c, value);
            set(c, t, value);
        } else if (!(switch (size) {
            0 => st(u8, c, a, @truncate(r(c, t))),
            1 => st(u16, c, a, @truncate(r(c, t))),
            else => st(u32, c, a, r(c, t)),
        })) return badAddr(c, h << 16 | h2, pc);
        return .next;
    }
    if ((h & 0xff80) == 0xf800 and ((h >> 5) & 3) < 3) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0x0fc0 == 0) {
            c.pc = pc + 4;
            const Ld = h & 0x10 != 0;
            const size = (h >> 5) & 3;
            const t = h2 >> 12;
            const a = addr(c, r(c, h & 15) +% (r(c, h2 & 15) << @intCast((h2 >> 4) & 3))) orelse return badAddr(c, h << 16 | h2, pc);
            if (Ld) {
                const value: u32 = switch (size) {
                    0 => ld(u8, a),
                    1 => ld(u16, a),
                    else => ld(u32, a),
                };
                if (t == 15) return bx(c, value);
                set(c, t, value);
            } else if (!(switch (size) {
                0 => st(u8, c, a, @truncate(r(c, t))),
                1 => st(u16, c, a, @truncate(r(c, t))),
                else => st(u32, c, a, r(c, t)),
            })) return badAddr(c, h << 16 | h2, pc);
            return .next;
        }
    }
    // Thumb-2's indexed load/store forms carry P/U/W and an 8-bit offset in the second
    // halfword. Compilers use them for high-register fields and spills.
    if ((h & 0xff80) == 0xf800 and ((h >> 5) & 3) < 3) {
        const h2: u32 = ld(u16, pc + 2);
        if (h2 & 0x0800 == 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const Ld = h & 0x10 != 0;
        const size = (h >> 5) & 3;
        const n = h & 15;
        const t = h2 >> 12;
        const P = h2 & 0x0400 != 0;
        const U = h2 & 0x0200 != 0;
        const W = h2 & 0x0100 != 0;
        const base = r(c, n);
        const off = h2 & 255;
        const indexed = if (U) base +% off else base -% off;
        const a = addr(c, if (P) indexed else base) orelse return badAddr(c, h << 16 | h2, pc);
        if (Ld) {
            const value: u32 = switch (size) {
                0 => ld(u8, a),
                1 => ld(u16, a),
                else => ld(u32, a),
            };
            if (W) set(c, n, indexed);
            if (t == 15) return bx(c, value);
            set(c, t, value);
        } else {
            if (!(switch (size) {
                0 => st(u8, c, a, @truncate(r(c, t))),
                1 => st(u16, c, a, @truncate(r(c, t))),
                else => st(u32, c, a, r(c, t)),
            })) return badAddr(c, h << 16 | h2, pc);
            if (W) set(c, n, indexed);
        }
        return .next;
    }
    return null;
}

inline fn execThumb16(c: *Cpu, h: u32, pc: u32, currentIt: u32) Status {
    const top = h >> 12;
    const rd = h & 7;
    const rn = (h >> 3) & 7;
    const rm = (h >> 6) & 7;
    const implicitFlags = currentIt == 0;
    switch (top) {
        0, 1 => {
            const o = (h >> 11) & 3;
            if (o == 3) {
                const t: u32 = if (h & (1 << 10) != 0) rm else r(c, rm);
                set(c, rd, if (h & (1 << 9) != 0)
                    (if (implicitFlags) subFlags(c, r(c, rn), t, 1) else r(c, rn) -% t)
                else
                    (if (implicitFlags) addFlags(c, r(c, rn), t, 0) else r(c, rn) +% t));
            } else {
                const nsh = (h >> 6) & 31;
                const t = r(c, rn);
                const s = if (o == 0 and nsh == 0) Shifted{ .v = t, .carry = cf(c) } else shiftReg(c, o, t, if (nsh == 0) 32 else nsh);
                set(c, rd, s.v);
                if (implicitFlags) setNZC(c, s.v, s.carry);
            }
        },
        2, 3 => {
            const o = (h >> 11) & 3;
            const r8 = (h >> 8) & 7;
            const imm = h & 255;
            switch (o) {
                0 => {
                    set(c, r8, imm);
                    if (currentIt == 0) setNZ(c, imm);
                },
                1 => _ = subFlags(c, r(c, r8), imm, 1),
                2 => set(c, r8, if (currentIt == 0) addFlags(c, r(c, r8), imm, 0) else r(c, r8) +% imm),
                else => set(c, r8, if (currentIt == 0) subFlags(c, r(c, r8), imm, 1) else r(c, r8) -% imm),
            }
        },
        4 => {
            if ((h & 0xfc00) == 0x4000) {
                const o = (h >> 6) & 15;
                const R = r(c, rd);
                const Mv = r(c, rn);
                switch (o) {
                    0, 1, 8, 12, 14, 15 => {
                        const v = logic(o, R, Mv);
                        if (o != 8) set(c, rd, v);
                        if (o == 8 or implicitFlags) setNZ(c, v);
                    },
                    2, 3, 4, 7 => {
                        const s = shiftReg(c, if (o == 7) 3 else o - 2, R, Mv & 255);
                        set(c, rd, s.v);
                        if (implicitFlags) setNZC(c, s.v, s.carry);
                    },
                    5 => set(c, rd, if (implicitFlags) addFlags(c, R, Mv, @intCast(cf(c))) else R +% Mv +% cf(c)),
                    6 => set(c, rd, if (implicitFlags) subFlags(c, R, Mv, @intCast(cf(c))) else R -% Mv -% (1 - cf(c))),
                    9 => set(c, rd, if (implicitFlags) subFlags(c, 0, Mv, 1) else 0 -% Mv),
                    10 => _ = subFlags(c, R, Mv, 1),
                    11 => _ = addFlags(c, R, Mv, 0),
                    else => {
                        set(c, rd, R *% Mv);
                        if (implicitFlags) setNZ(c, R *% Mv);
                    },
                }
                return .next;
            }
            if ((h & 0xfc00) == 0x4400) {
                const o = (h >> 8) & 3;
                const dd = rd | ((h >> 4) & 8);
                const mm = (h >> 3) & 15;
                const RM = if (mm == 15) pc +% 4 else r(c, mm);
                switch (o) {
                    3 => {
                        if (h & 0x80 != 0) set(c, 14, pc +% 3);
                        return bx(c, RM);
                    },
                    0 => {
                        if (dd == 15) return jump(c, (pc +% 4 +% RM) & ~@as(u32, 1));
                        set(c, dd, r(c, dd) +% RM);
                    },
                    1 => _ = subFlags(c, r(c, dd), RM, 1),
                    else => {
                        if (dd == 15) return jump(c, RM & ~@as(u32, 1));
                        set(c, dd, RM);
                    },
                }
                return .next;
            }
            set(c, (h >> 8) & 7, ld(u32, ((pc +% 4) & ~@as(u32, 3)) +% (h & 255) * 4));
        },
        5 => {
            const o = (h >> 9) & 7;
            const a = addr(c, r(c, rn) +% r(c, rm)) orelse return badAddr(c, h, pc);
            switch (o) {
                0 => if (!st(u32, c, a, r(c, rd))) return badAddr(c, h, pc),
                1 => if (!st(u16, c, a, @truncate(r(c, rd)))) return badAddr(c, h, pc),
                2 => if (!st(u8, c, a, @truncate(r(c, rd)))) return badAddr(c, h, pc),
                3 => set(c, rd, sxb(ld(u8, a))),
                4 => set(c, rd, ld(u32, a)),
                5 => set(c, rd, ld(u16, a)),
                6 => set(c, rd, ld(u8, a)),
                else => set(c, rd, sxh(ld(u16, a))),
            }
        },
        6, 7 => {
            const B = h & (1 << 12) != 0;
            const Ld = h & (1 << 11) != 0;
            const imm = (h >> 6) & 31;
            const a = addr(c, r(c, rn) +% (if (B) imm else imm * 4)) orelse return badAddr(c, h, pc);
            if (Ld) set(c, rd, if (B) ld(u8, a) else ld(u32, a)) else if (!(if (B) st(u8, c, a, @truncate(r(c, rd))) else st(u32, c, a, r(c, rd)))) return badAddr(c, h, pc);
        },
        8 => {
            const a = addr(c, r(c, rn) +% ((h >> 6) & 31) * 2) orelse return badAddr(c, h, pc);
            if (h & (1 << 11) != 0) set(c, rd, ld(u16, a)) else if (!st(u16, c, a, @truncate(r(c, rd)))) return badAddr(c, h, pc);
        },
        9 => {
            const rt = (h >> 8) & 7;
            const a = addr(c, r(c, 13) +% (h & 255) * 4) orelse return badAddr(c, h, pc);
            if (h & (1 << 11) != 0) set(c, rt, ld(u32, a)) else if (!st(u32, c, a, r(c, rt))) return badAddr(c, h, pc);
        },
        10 => {
            const rt = (h >> 8) & 7;
            const imm = (h & 255) * 4;
            set(c, rt, if (h & (1 << 11) != 0) r(c, 13) +% imm else ((pc +% 4) & ~@as(u32, 3)) +% imm);
        },
        11 => return thumbMisc(c, h, pc, rd, rn),
        12 => {
            const Ld = h & (1 << 11) != 0;
            const n8 = (h >> 8) & 7;
            const list = h & 255;
            var a = addr(c, r(c, n8)) orelse return badAddr(c, h, pc);
            const end = a +% @as(u32, @popCount(list)) * 4;
            var i: u5 = 0;
            while (i < 8) : (i += 1) if (list & (@as(u32, 1) << i) != 0) {
                if (Ld) set(c, i, ld(u32, a)) else if (!st(u32, c, a, r(c, i))) return badAddr(c, h, pc);
                a += 4;
            };
            if (!Ld or list & (@as(u32, 1) << @intCast(n8)) == 0) set(c, n8, end);
        },
        13 => {
            const cc = (h >> 8) & 15;
            if (cc == 15) return swi(c);
            if (cc == 14) return fault(c, .undefined, h, pc);
            const off: u32 = @bitCast(@as(i32, @bitCast(h << 24)) >> 23);
            if (cond(c, cc)) return jump(c, pc +% 4 +% off);
        },
        14 => {
            if (h & (1 << 11) != 0) return fault(c, .unimplemented, h, pc);
            const off: u32 = @bitCast(@as(i32, @bitCast(h << 21)) >> 20);
            return jump(c, pc +% 4 +% off);
        },
        else => {
            if ((h & 0xf800) != 0xf000) return fault(c, .unimplemented, h, pc);
            const h2: u32 = ld(u16, pc + 2);
            if ((h2 & 0xc000) != 0xc000) return fault(c, .unimplemented, h2, pc);
            const Sb = (h >> 10) & 1;
            const imm10 = h & 0x3ff;
            const J1 = (h2 >> 13) & 1;
            const J2 = (h2 >> 11) & 1;
            const imm11 = h2 & 0x7ff;
            const I1 = 1 - (J1 ^ Sb);
            const I2 = 1 - (J2 ^ Sb);
            const raw = (Sb << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);
            const off: u32 = @bitCast(@as(i32, @bitCast(raw << 7)) >> 7);
            set(c, 14, pc +% 5);
            if (h2 & 0x1000 != 0) return jump(c, pc +% 4 +% off);
            return bx(c, ((pc +% 4) & ~@as(u32, 3)) +% (off & ~@as(u32, 3)));
        },
    }
    return .next;
}
fn thumbMisc(c: *Cpu, h: u32, pc: u32, rd: u32, rn: u32) Status {
    if ((h & 0xff00) == 0xb000) {
        const imm = (h & 127) * 4;
        set(c, 13, if (h & 0x80 != 0) r(c, 13) -% imm else r(c, 13) +% imm);
        return .next;
    }
    if ((h & 0xfe00) == 0xb400) {
        const list = (h & 255) | ((h & 0x100) << 6);
        const base = r(c, 13) -% @as(u32, @popCount(list)) * 4;
        var a = addr(c, base) orelse return badAddr(c, h, pc);
        set(c, 13, base);
        var i: u5 = 0;
        while (true) : (i += 1) {
            if (list & (@as(u32, 1) << i) != 0) {
                if (!st(u32, c, a, r(c, i))) return badAddr(c, h, pc);
                a += 4;
            }
            if (i == 15) break;
        }
        return .next;
    }
    if ((h & 0xfe00) == 0xbc00) {
        const list = (h & 255) | ((h & 0x100) << 7);
        var a = addr(c, r(c, 13)) orelse return badAddr(c, h, pc);
        set(c, 13, a +% @as(u32, @popCount(list)) * 4);
        var i: u5 = 0;
        while (i < 15) : (i += 1) if (list & (@as(u32, 1) << i) != 0) {
            set(c, i, ld(u32, a));
            a += 4;
        };
        if (list & 0x8000 != 0) return bx(c, ld(u32, a));
        return .next;
    }
    if ((h & 0xff00) == 0xbe00) return fault(c, .brk, h, pc);
    if ((h & 0xff00) == 0xbf00) {
        if (h & 15 != 0) setItState(c, h & 255);
        return .next;
    }
    if ((h & 0xffe8) == 0xb660) return .next;
    const t = r(c, rn);
    switch (h & 0xffc0) {
        0xb200 => set(c, rd, sxh(t)),
        0xb240 => set(c, rd, sxb(t)),
        0xb280 => set(c, rd, t & 0xffff),
        0xb2c0 => set(c, rd, t & 255),
        0xba00 => set(c, rd, @byteSwap(t)),
        0xba40 => set(c, rd, rev16(t)),
        0xbac0 => set(c, rd, sxh(@byteSwap(@as(u16, @truncate(t))))),
        else => {
            if ((h & 0xf500) == 0xb100) {
                const imm = ((h >> 3) & 31) * 2 + ((h & 0x200) >> 3);
                const zero = r(c, rd) == 0;
                if (zero != (h & 0x800 != 0)) return jump(c, pc +% 4 +% imm);
                return .next;
            }
            return fault(c, .unimplemented, h, pc);
        },
    }
    return .next;
}

pub fn block(c: *Cpu, start: u32, page: *cpu.Page) Status {
    const thumb = c.cpsr & (1 << 5) != 0;
    if (start & (if (thumb) @as(u32, 1) else 3) != 0) return fault(c, .misaligned_pc, start, start);
    c.bpc = start | @intFromBool(thumb);
    var pc = start;
    var last = start;
    var n: u32 = 0;
    var s: Status = .next;
    while (n < cpu.max_block) {
        if (pc < abi.LOW) {
            s = fault(c, .bad_address, pc, pc);
            break;
        }
        n += 1;
        last = pc;
        s = if (thumb) execThumb(c, pc) else execArm(c, pc);
        if (s != .next) break;
        pc = @truncate(c.pc);
        // Stay on the page the caller looked up. a64.block already stops here; this one ran on and
        // then handed cover() a range that left the page, which marked nothing -- so a store into a
        // word this block had executed did not drop the page.
        if (pc >> abi.PAGE_SHIFT != start >> abi.PAGE_SHIFT) break;
    }
    cpu.cover(page, start, last);
    c.ic += n;
    return if (s == .next) .jump else s;
}
