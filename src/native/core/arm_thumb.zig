//! Thumb and Thumb-2 in the interpreter: 16- and 32-bit encodings, the multiplies as the ARM words
//! thumbarm.zig translates them to, the rest on arm.zig's shared helpers.
const std = @import("std");
const cpu = @import("cpu.zig");
const arm = @import("arm.zig");
const neon = @import("arm_neon.zig");
const thumbarm = @import("thumbarm.zig");
const vfp = @import("arm_vfp.zig");
const Cpu = cpu.Cpu;
const Status = cpu.Status;
const bits = @import("bits.zig").bits;
const ld = @import("mem.zig").ld;
const st = cpu.st;
const Shifted = arm.Shifted;
const addFlags = arm.addFlags;
const addr = arm.addr;
const badAddr = arm.badAddr;
const bx = arm.bx;
const cond = arm.cond;
const extendBytePair = arm.extendBytePair;
const extractField = arm.extractField;
const fault = arm.fault;
const jump = arm.jump;
const loadExclusive = arm.loadExclusive;
const logic = arm.logic;
const multiply = arm.multiply;
const multiplyMedia = arm.multiplyMedia;
const packHalf = arm.packHalf;
const parallel = arm.parallel;
const r = arm.r;
const reverse = arm.reverse;
const saturatingAdd = arm.saturatingAdd;
const saturatingShift = arm.saturatingShift;
const select = arm.select;
const set = arm.set;
const setItState = arm.setItState;
const setNZ = arm.setNZ;
const setNZC = arm.setNZC;
const shiftImm = arm.shiftImm;
const shiftReg = arm.shiftReg;
const storeExclusive = arm.storeExclusive;
const subFlags = arm.subFlags;
const swi = arm.swi;
const sxb = arm.sxb;
const sxh = arm.sxh;
const thumbExpandImm = arm.thumbExpandImm;

fn thumbData(c: *Cpu, op: u32, n: u32, rhs: u32, flags: bool) u32 {
    const lhs = if (n == 15 and op <= 4) 0 else r(c, n);
    return switch (op) {
        0 => lhs & rhs,
        1 => lhs & ~rhs,
        2 => lhs | rhs,
        3 => lhs | ~rhs,
        4 => lhs ^ rhs,
        8 => if (flags) addFlags(c, lhs, rhs, 0) else lhs +% rhs,
        10 => if (flags) addFlags(c, lhs, rhs, @intCast(c.cf())) else lhs +% rhs +% c.cf(),
        11 => if (flags) subFlags(c, lhs, rhs, @intCast(c.cf())) else lhs -% rhs -% (1 - c.cf()),
        13 => if (flags) subFlags(c, lhs, rhs, 1) else lhs -% rhs,
        14 => if (flags) subFlags(c, rhs, lhs, 1) else rhs -% lhs,
        else => unreachable,
    };
}
inline fn itState(c: *Cpu) u32 {
    return ((c.cpsr >> 8) & 0xfc) | ((c.cpsr >> 25) & 3);
}
inline fn advanceIt(c: *Cpu, state: u32) void {
    setItState(c, if (state & 7 == 0) 0 else (state & 0xe0) | ((state << 1) & 0x1f));
}

pub fn execThumb(c: *Cpu, pc: u32) Status {
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
    if (execThumb32Branches(c, h, second, pc)) |status| return status;
    if (h & 0xef80 == 0xef80 and second & 0x10 != 0 and (h & 0x38 != 0 or second & 0x80 != 0)) {
        c.pc = pc + 4;
        return neon.neonShift(c, 0xf2000000 | ((h & 0x1000) << 12) | ((h & 0xff) << 16) | second, pc);
    }
    if (h & 0xffb0 == 0xffb0 and second & 0x10 == 0) {
        c.pc = pc + 4;
        return neon.neonMisc(c, 0xf3000000 | ((h & 0xff) << 16) | second, pc);
    }
    if (h & 0xef80 == 0xef00 or (h & 0xffb0 == 0xefb0 and second & 0x10 == 0) or (h & 0xef80 == 0xef80 and second & 0x50 == 0x40)) {
        c.pc = pc + 4;
        return neon.neonSame(c, 0xf2000000 | ((h & 0x1000) << 12) | ((h & 0xff) << 16) | second, pc);
    }
    if (h & 0xef80 == 0xef80 and second & 0x50 == 0) {
        c.pc = pc + 4;
        return neon.neonLong(c, 0xf2000000 | ((h & 0x1000) << 12) | ((h & 0xff) << 16) | second, pc);
    }
    const cp = (second >> 8) & 15;
    if (cp == 10 or cp == 11) {
        if (vfp.vfp(c, h << 16 | second, pc -% 4)) |status| {
            if (status != .fault) c.pc = pc + 4;
            return status;
        }
    }
    if (execThumb32Data(c, h, second, pc)) |status| return status;
    if (execThumb32Transfers(c, h, second, pc)) |status| return status;
    return execThumb32Late(c, h, second, pc);
}

inline fn execThumb32Data(c: *Cpu, h: u32, h2: u32, pc: u32) ?Status {
    if (h == 0xf3ef) {
        if (h2 & 0xf0ff == 0x8000) {
            set(c, (h2 >> 8) & 15, c.cpsr & 0xf80f_0000);
            c.pc = pc + 4;
            return .next;
        }
    }
    if (h & 0xfff0 == 0xf380) {
        if (h2 == 0x8800 or h2 == 0x8400 or h2 == 0x8c00) {
            const mask: u32 = (if (h2 & 0x800 != 0) @as(u32, 0xf800_0000) else 0) |
                (if (h2 & 0x400 != 0) @as(u32, 0x000f_0000) else 0);
            c.cpsr = (c.cpsr & ~mask) | (r(c, h & 15) & mask);
            c.pc = pc + 4;
            return .next;
        }
    }
    if (h & 0xff50 == 0xf300) {
        const amount: u5 = @intCast((bits(h2, 12, 3) << 2) | bits(h2, 6, 2));
        const asr = h & 0x20 != 0;
        if (h2 & 0x8020 != 0 or (asr and amount == 0)) return fault(c, .unimplemented, h << 16 | h2, pc);
        set(c, bits(h2, 8, 4), saturatingShift(c, r(c, h & 15), amount, asr, @intCast(h2 & 31), h & 0x80 != 0));
        c.pc = pc + 4;
        return .next;
    }
    if ((h & 0xefb0) == 0xef80) {
        if (h2 & 0x10 == 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const imm8 = ((h >> 5) & 0x80) | ((h & 7) << 4) | (h2 & 15);
        return neon.neonImmediate(c, h << 16 | h2, pc, imm8);
    }
    const wideMoveImm = h & 0xfbef;
    if (wideMoveImm == 0xf04f or wideMoveImm == 0xf06f) {
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
        const op = (h >> 5) & 15;
        if (h2 & 0x8000 == 0 and (op <= 4 or op == 8 or op == 10 or op == 11 or op == 13 or op == 14)) {
            c.pc = pc + 4;
            const imm12 = (((h >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 255);
            const expanded = thumbExpandImm(c, imm12);
            const imm = expanded.v;
            const n = h & 15;
            const d = (h2 >> 8) & 15;
            const S = h & 0x10 != 0;
            const out = thumbData(c, op, n, imm, S);
            if (S and op <= 4) setNZC(c, out, expanded.carry);
            if (d != 15) set(c, d, out);
            return .next;
        }
    }
    if ((h & 0xff70) == 0xf340) {
        if (h2 & 0x8000 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const lsb = (((h2 >> 12) & 7) << 2) | ((h2 >> 6) & 3);
        const width = (h2 & 31) + 1;
        if (h2 & 0x20 != 0 or lsb + width > 32) return fault(c, .undefined, h << 16 | h2, pc);
        set(c, (h2 >> 8) & 15, extractField(r(c, h & 15), lsb, width, h & 0x80 == 0));
        return .next;
    }
    if ((h & 0xfff0) == 0xf360) {
        const lsb = (bits(h2, 12, 3) << 2) | bits(h2, 6, 2);
        const msb = h2 & 31;
        if (h2 & 0x8020 != 0 or msb < lsb) return fault(c, .undefined, h << 16 | h2, pc);
        const mask = (~@as(u32, 0) >> @intCast(31 - msb)) & (~@as(u32, 0) << @intCast(lsb));
        const d = bits(h2, 8, 4);
        const src = if (h & 15 == 15) 0 else r(c, h & 15);
        set(c, d, (r(c, d) & ~mask) | ((src << @intCast(lsb)) & mask));
        c.pc = pc + 4;
        return .next;
    }
    if ((h & 0xffd0) == 0xfa90) {
        const clz = h & 0x20 != 0;
        if (h2 & 0xf0c0 == 0xf080 and (!clz or h2 & 0x30 == 0) and (h & 15) == (h2 & 15)) {
            c.pc = pc + 4;
            set(c, (h2 >> 8) & 15, if (clz) @clz(r(c, h & 15)) else reverse(r(c, h & 15), bits(h2, 4, 2)));
            return .next;
        }
    }
    if ((h & 0xff80) == 0xfa80 and h2 & 0xf000 == 0xf000) {
        const n = r(c, h & 15);
        const m = r(c, h2 & 15);
        const d = bits(h2, 8, 4);
        if (h2 & 0x80 == 0) {
            // Thumb's op1 order (ADD8, ADD16, ASX, -, SUB8, SUB16, SAX, -) mapped to ARM's op
            const op = ([8]u32{ 4, 0, 1, 5, 7, 3, 2, 5 })[bits(h, 4, 3)];
            const kind = (if (h2 & 0x40 != 0) @as(u32, 4) else 0) + bits(h2, 4, 2) + 1;
            set(c, d, parallel(c, n, m, kind, op) orelse return fault(c, .undefined, h << 16 | h2, pc));
            c.pc = pc + 4;
            return .next;
        }
        if (h2 & 0xc0 == 0x80 and (h & 0x30 == 0 or (h & 0x30 == 0x20 and h2 & 0x30 == 0))) {
            set(c, d, if (h & 0x30 == 0) saturatingAdd(c, m, n, h2 & 0x20 != 0, h2 & 0x10 != 0) else select(c, n, m));
            c.pc = pc + 4;
            return .next;
        }
    }
    if ((h & 0xff80) == 0xfa00) {
        const extend = (h >> 4) & 7;
        if (h2 & 0xf0c0 == 0xf080 and extend <= 5) {
            const value = std.math.rotr(u32, r(c, h2 & 15), bits(h2, 4, 2) * 8);
            const base = if (h & 15 == 15) 0 else r(c, h & 15);
            const result = switch (extend) {
                0 => base +% sxh(value),
                1 => base +% (value & 65535),
                2, 3 => extendBytePair(value, base, extend == 2),
                4 => base +% sxb(value),
                else => base +% (value & 255),
            };
            set(c, (h2 >> 8) & 15, result);
            c.pc = pc + 4;
            return .next;
        }
        if (h2 & 0xf0f0 == 0xf000) {
            c.pc = pc + 4;
            const shifted = shiftReg(c, (h >> 5) & 3, r(c, h & 15), r(c, h2 & 15) & 255);
            set(c, (h2 >> 8) & 15, shifted.v);
            if (h & 0x10 != 0) setNZC(c, shifted.v, shifted.carry);
            return .next;
        }
    }
    if (h & 0xff00 == 0xfb00) {
        if (thumbarm.multiply(h, h2)) |w| {
            c.pc = pc + 4;
            return (if (w & 0x0e00_0000 == 0) multiply(c, w, pc) else multiplyMedia(c, w, pc)).?;
        }
        // SDIV/UDIV are not implemented
        if (h & 0xffd0 != 0xfb90) return fault(c, .undefined, h << 16 | h2, pc);
    }
    if ((h & 0xfe00) == 0xea00) {
        if (h2 & 0x8000 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        const op = (h >> 5) & 15;
        if (op == 6 and h & 0x10 == 0 and h2 & 0x10 == 0) {
            set(c, bits(h2, 8, 4), packHalf(r(c, h & 15), r(c, h2 & 15), @intCast((bits(h2, 12, 3) << 2) | bits(h2, 6, 2)), h2 & 0x20 != 0));
            c.pc = pc + 4;
            return .next;
        }
        if (op <= 4 or op == 8 or op == 10 or op == 11 or op == 13 or op == 14) {
            c.pc = pc + 4;
            const shifted = shiftImm(c, (h2 >> 4) & 3, r(c, h2 & 15), (((h2 >> 12) & 7) << 2) | ((h2 >> 6) & 3));
            const n = h & 15;
            const d = (h2 >> 8) & 15;
            const S = h & 0x10 != 0;
            const out = thumbData(c, op, n, shifted.v, S);
            if (S and op <= 4) setNZC(c, out, shifted.carry);
            if (d != 15) set(c, d, out);
            return .next;
        }
    }
    return null;
}

inline fn execThumb32Transfers(c: *Cpu, h: u32, h2: u32, pc: u32) ?Status {
    if ((h & 0xfff0) == 0xe8d0) {
        if (h2 & 0xffe0 == 0xf000) {
            c.pc = pc + 4;
            const half = h2 & 0x10 != 0;
            const base = if ((h & 15) == 15) pc + 4 else r(c, h & 15);
            const index = r(c, h2 & 15);
            const a = addr(c, base +% if (half) index * 2 else index, if (half) 2 else 1) orelse return badAddr(c, h << 16 | h2, pc);
            const off: u32 = if (half) ld(u16, a) else ld(u8, a);
            return jump(c, pc +% 4 +% off * 2);
        }
    }
    if ((h & 0xff60) == 0xe840 and (h & 0x80 == 0 or h2 & 0xc0 == 0x40)) {
        const load = h & 0x10 != 0;
        const extended = h & 0x80 != 0;
        const kind = bits(h2, 4, 4);
        const double = extended and kind == 7;
        const byte = extended and kind == 4;
        const half = extended and kind == 5;
        const n = h & 15;
        const status = if (extended) h2 & 15 else (h2 >> 8) & 15;
        if (extended and ((!double and !byte and !half) or (!double and bits(h2, 8, 4) != 15))) return fault(c, .undefined, h << 16 | h2, pc);
        const size: u32 = if (double) 8 else if (byte) 1 else if (half) 2 else 4;
        const a = addr(c, r(c, n) +% (if (extended) 0 else (h2 & 255) * 4), size) orelse return badAddr(c, h << 16 | h2, pc);
        if ((load and status != 15) or (!load and status == 15)) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        if (load) {
            const v = loadExclusive(c, a, size);
            if (double) set(c, (h2 >> 8) & 15, @truncate(v >> 32));
            set(c, h2 >> 12, @truncate(v));
        } else {
            const stored = storeExclusive(c, a, size, r(c, h2 >> 12), if (double) r(c, (h2 >> 8) & 15) else 0) orelse return badAddr(c, h << 16 | h2, pc);
            set(c, status, @intFromBool(!stored));
        }
        return .next;
    }
    if ((h & 0xfe40) == 0xe840) {
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
        const a = addr(c, if (P) indexed else base, 8) orelse return badAddr(c, h << 16 | h2, pc);
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
        const list = h2;
        c.pc = pc + 4;
        const before = h & 0x100 != 0;
        const W = h & 0x20 != 0;
        const Ld = h & 0x10 != 0;
        const n = h & 15;
        const count: u32 = @popCount(list);
        const base = r(c, n);
        var a = if (before) base -% count * 4 else base;
        if (addr(c, a, count * 4) == null) return badAddr(c, h << 16 | list, pc);
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
        if (h2 & 0xfff0 == 0x8f20 or h2 & 0xfff0 == 0x8f40 or h2 & 0xfff0 == 0x8f50 or h2 & 0xfff0 == 0x8f60) {
            c.pc = pc + 4;
            if (h2 & 0xfff0 == 0x8f20) c.excl = 0;
            return .next;
        }
    }
    return null;
}

inline fn execThumb32Branches(c: *Cpu, h: u32, h2: u32, pc: u32) ?Status {
    if ((h & 0xf800) == 0xf000) {
        const cc = (h >> 6) & 15;
        if ((h2 & 0xd000) == 0x8000 and cc < 14) {
            c.pc = pc + 4;
            const raw = (((h >> 10) & 1) << 20) | (((h2 >> 11) & 1) << 19) | (((h2 >> 13) & 1) << 18) | ((h & 0x3f) << 12) | ((h2 & 0x7ff) << 1);
            const off: u32 = @bitCast(@as(i32, @bitCast(raw << 11)) >> 11);
            if (cond(c, cc)) return jump(c, pc +% 4 +% off);
            return .next;
        }
        if ((h2 & 0xd000) == 0x9000 or (h2 & 0xc000) == 0xc000) {
            c.pc = pc + 4;
            const Sb = (h >> 10) & 1;
            const I1 = 1 - (((h2 >> 13) & 1) ^ Sb);
            const I2 = 1 - (((h2 >> 11) & 1) ^ Sb);
            const raw = (Sb << 24) | (I1 << 23) | (I2 << 22) | ((h & 0x3ff) << 12) | ((h2 & 0x7ff) << 1);
            const off: u32 = @bitCast(@as(i32, @bitCast(raw << 7)) >> 7);
            if ((h2 & 0xc000) == 0xc000) {
                set(c, 14, pc +% 5);
                if (h2 & 0x1000 == 0) return bx(c, ((pc +% 4) & ~@as(u32, 3)) +% (off & ~@as(u32, 3)));
            }
            return jump(c, pc +% 4 +% off);
        }
    }
    return null;
}

inline fn execThumb32Late(c: *Cpu, h: u32, h2: u32, pc: u32) ?Status {
    if ((h & 0xff10) == 0xf900) {
        c.pc = pc + 4;
        return neon.neonStruct(c, h << 16 | h2, pc);
    }
    const wideMove = h & 0xfbf0;
    if (wideMove == 0xf240 or wideMove == 0xf2c0) {
        if (h2 & 0x8000 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const d = (h2 >> 8) & 15;
        const imm = ((h & 15) << 12) | (((h >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 255);
        set(c, d, if (wideMove == 0xf2c0) (r(c, d) & 0xffff) | (imm << 16) else imm);
        return .next;
    }
    const wideAddress = h & 0xfbe0;
    if (wideAddress == 0xf200 or wideAddress == 0xf2a0) {
        if (h2 & 0x8000 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        const imm = (((h >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 255);
        const n = h & 15;
        const base = if (n == 15) (pc + 4) & ~@as(u32, 3) else r(c, n);
        set(c, (h2 >> 8) & 15, if (wideAddress == 0xf2a0) base -% imm else base +% imm);
        return .next;
    }
    if (h & 0xfe00 == 0xf800 and bits(h, 5, 2) < 3) {
        const load = h & 0x10 != 0;
        const signed = h & 0x100 != 0;
        const size = bits(h, 5, 2);
        const n = h & 15;
        const t = h2 >> 12;
        const w = h << 16 | h2;
        if (signed and (!load or size == 2) or !load and n == 15) return fault(c, .undefined, w, pc);
        c.pc = pc + 4;
        if (load and t == 15 and size < 2) return .next; // PLD/PLI hints do not access memory.
        const base = if (n == 15) (pc +% 4) & ~@as(u32, 3) else r(c, n);
        var effective: u32 = undefined;
        var indexed: u32 = 0;
        var writeback = false;
        if (h & 0x80 != 0 or n == 15) {
            effective = if (h & 0x80 != 0) base +% (h2 & 0xfff) else base -% (h2 & 0xfff);
        } else if (h2 & 0xfc0 == 0) {
            effective = base +% (r(c, h2 & 15) << @intCast(bits(h2, 4, 2)));
        } else {
            if (h2 & 0x800 == 0 or h2 & 0x500 == 0) return fault(c, .undefined, w, pc);
            indexed = if (h2 & 0x200 != 0) base +% (h2 & 255) else base -% (h2 & 255);
            effective = if (h2 & 0x400 != 0) indexed else base;
            writeback = h2 & 0x100 != 0;
        }
        const a = addr(c, effective, @as(u32, 1) << @intCast(size)) orelse return badAddr(c, w, pc);
        if (load) {
            const value: u32 = switch (size) {
                0 => if (signed) sxb(ld(u8, a)) else ld(u8, a),
                1 => if (signed) sxh(ld(u16, a)) else ld(u16, a),
                else => ld(u32, a),
            };
            if (writeback) set(c, n, indexed);
            if (t == 15) return bx(c, value);
            set(c, t, value);
        } else {
            if (!(switch (size) {
                0 => st(u8, c, a, @truncate(r(c, t))),
                1 => st(u16, c, a, @truncate(r(c, t))),
                else => st(u32, c, a, r(c, t)),
            })) return badAddr(c, w, pc);
            if (writeback) set(c, n, indexed);
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
                const s = if (o == 0 and nsh == 0) Shifted{ .v = t, .carry = c.cf() } else shiftReg(c, o, t, if (nsh == 0) 32 else nsh);
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
                    5 => set(c, rd, if (implicitFlags) addFlags(c, R, Mv, @intCast(c.cf())) else R +% Mv +% c.cf()),
                    6 => set(c, rd, if (implicitFlags) subFlags(c, R, Mv, @intCast(c.cf())) else R -% Mv -% (1 - c.cf())),
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
            const a = addr(c, r(c, rn) +% r(c, rm), ([_]u32{ 4, 2, 1, 1, 4, 2, 1, 2 })[o]) orelse return badAddr(c, h, pc);
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
            const a = addr(c, r(c, rn) +% (if (B) imm else imm * 4), if (B) 1 else 4) orelse return badAddr(c, h, pc);
            if (Ld) set(c, rd, if (B) ld(u8, a) else ld(u32, a)) else if (!(if (B) st(u8, c, a, @truncate(r(c, rd))) else st(u32, c, a, r(c, rd)))) return badAddr(c, h, pc);
        },
        8 => {
            const a = addr(c, r(c, rn) +% ((h >> 6) & 31) * 2, 2) orelse return badAddr(c, h, pc);
            if (h & (1 << 11) != 0) set(c, rd, ld(u16, a)) else if (!st(u16, c, a, @truncate(r(c, rd)))) return badAddr(c, h, pc);
        },
        9 => {
            const rt = (h >> 8) & 7;
            const a = addr(c, r(c, 13) +% (h & 255) * 4, 4) orelse return badAddr(c, h, pc);
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
            var a = addr(c, r(c, n8), @as(u32, @popCount(list)) * 4) orelse return badAddr(c, h, pc);
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
        else => return fault(c, .unimplemented, h, pc),
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
        var a = addr(c, base, @as(u32, @popCount(list)) * 4) orelse return badAddr(c, h, pc);
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
        var a = addr(c, r(c, 13), @as(u32, @popCount(list)) * 4) orelse return badAddr(c, h, pc);
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
        0xba00, 0xba40, 0xbac0 => set(c, rd, reverse(t, bits(h, 6, 2))),
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
