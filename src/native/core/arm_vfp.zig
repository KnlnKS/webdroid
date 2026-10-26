//! ARM32 VFP in the interpreter.
const std = @import("std");
const fp = @import("fp.zig");
const simd = @import("simd.zig");
const cpu = @import("cpu.zig");
const arm = @import("arm.zig");
const Cpu = cpu.Cpu;
const Status = cpu.Status;
const bits = @import("bits.zig").bits;
const mem = @import("mem.zig");
const ld = mem.ld;
const st = cpu.st;
const r = arm.r;
const set = arm.set;
const reg = arm.reg;
const cond = arm.cond;
const fault = arm.fault;
const badAddr = arm.badAddr;
const addr = arm.addr;
const vreg = arm.vreg;
const sxb = arm.sxb;
const sxh = arm.sxh;

pub fn vfp(c: *Cpu, w: u32, pc: u32) ?Status {
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
        if (top == 12 and !U and !W and bits(w, 21, 2) == 2) {
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
        if (count == 0 or d + count > 32 or dp and count > 16) return fault(c, .undefined, w, pc);
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
    if (w >> 28 == 15) return if (w & 0x10 != 0) null else if (dp) vfpV8(f64, c, w, d, n, m) else vfpV8(f32, c, w, d, n, m);
    if (w & 0x10 != 0) {
        const rt = bits(w, 12, 4);
        const o = bits(w, 21, 3);
        const Ld = bits(w, 20, 1) != 0;
        if (dp and !Ld and o & 4 != 0 and w & 0x4f == 0) {
            const q = bits(w, 21, 1);
            const size: u32 = if (w & (1 << 22) != 0) 1 else if (w & (1 << 5) != 0) 2 else 4;
            if (q != 0 and n & 1 != 0) return fault(c, .undefined, w, pc);
            const value = r(c, rt);
            const out: [*]u8 = @ptrCast(vreg(u64, c, n));
            var i: u32 = 0;
            while (i < (if (q != 0) @as(u32, 16) else 8)) : (i += 1) out[i] = @truncate(value >> @intCast((i % size) * 8));
            return .next;
        }
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
        if (dp and (Ld or o < 4) and w & 15 == 0) {
            const size: u32 = if (w & (1 << 22) != 0) 1 else if (w & 0x20 != 0) 2 else 4;
            if (size == 4 and w & 0x800040 != 0) return fault(c, .undefined, w, pc);
            const offset = (bits(w, 21, 1) << 2) | (if (size == 1) bits(w, 5, 2) else if (size == 2) bits(w, 6, 1) << 1 else 0);
            const a = @as(u32, @intFromPtr(vreg(u64, c, n))) + offset;
            const unsigned = w & (1 << 23) != 0;
            if (Ld) set(c, rt, switch (size) {
                1 => if (unsigned) ld(u8, a) else sxb(ld(u8, a)),
                2 => if (unsigned) ld(u16, a) else sxh(ld(u16, a)),
                else => ld(u32, a),
            }) else switch (size) {
                1 => mem.ptr(u8, a).* = @truncate(r(c, rt)),
                2 => mem.ptr(u16, a).* = @truncate(r(c, rt)),
                else => mem.ptr(u32, a).* = r(c, rt),
            }
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
                const imm = simd.vfpImm(bits(w, 16, 4) << 4 | (w & 15), dp);
                if (dp) vreg(u32, c, d * 2).* = @truncate(imm) else vreg(u32, c, d).* = @truncate(imm);
                if (dp) vreg(u32, c, d * 2 + 1).* = @intCast(imm >> 32);
                return .next;
            }
            const opc2 = bits(w, 16, 4);
            const o7 = bits(w, 7, 1) != 0;
            switch (opc2) {
                0 => vreg(F, c, d).* = if (o7) @abs(vm) else vm,
                1 => vreg(F, c, d).* = if (o7) @sqrt(vm) else -vm,
                // VCVTB and VCVTT (bit 7, the top half) from or to half precision, whose S register its fields name
                2 => vreg(F, c, d).* = @floatCast(fp.h2f(@as([*]u16, @ptrCast(vreg(u32, c, (bits(w, 0, 4) << 1) | bits(w, 5, 1))))[@intFromBool(o7)])),
                3 => @as([*]u16, @ptrCast(vreg(u32, c, (bits(w, 12, 4) << 1) | bits(w, 22, 1))))[@intFromBool(o7)] = fp.f2hb(F, @bitCast(vm)),
                4, 5 => c.fpcr = (c.fpcr & 0x0fff_ffff) | fp.fcmp(vd, if (opc2 == 5) @as(F, 0) else vm),
                // VRINTR and VRINTZ (bit 7), VRINTX
                6 => vreg(F, c, d).* = if (o7) @trunc(vm) else fp.rint(F, c.fpcr, vm),
                7 => {
                    if (!o7) vreg(F, c, d).* = fp.rint(F, c.fpcr, vm)
                    else if (dp) vreg(f32, c, (bits(w, 12, 4) << 1) | bits(w, 22, 1)).* = @floatCast(vm)
                    else vreg(f64, c, (bits(w, 22, 1) << 4) | bits(w, 12, 4)).* = vreg(f32, c, m).*;
                },
                8 => {
                    const src = vreg(u32, c, (bits(w, 0, 4) << 1) | bits(w, 5, 1)).*;
                    vreg(F, c, d).* = if (o7) @floatFromInt(@as(i32, @bitCast(src))) else @floatFromInt(src);
                },
                10, 11, 14, 15 => {
                    // VCVT between floating-point and fixed-point, in place: a 16- or 32-bit (bit 7) value, unsigned when
                    // bit 16, whose size less the immediate is its fraction bits; to fixed (bit 18) rounds toward zero
                    const size: u32 = if (o7) 32 else 16;
                    const imm = (bits(w, 0, 4) << 1) | bits(w, 5, 1);
                    if (imm > size) return null;
                    const scale = std.math.ldexp(@as(F, 1), @intCast(size - imm));
                    const unsigned = w & 0x10000 != 0;
                    if (opc2 & 4 != 0) {
                        const t = @trunc(vd * scale);
                        const v: i64 = if (unsigned) (if (o7) fp.toInt(u32, t) else fp.toInt(u16, t)) else if (o7) fp.toInt(i32, t) else fp.toInt(i16, t);
                        if (dp) vreg(i64, c, d).* = v else vreg(i32, c, d).* = @truncate(v);
                    } else {
                        const raw = vreg(u32, c, if (dp) d * 2 else d).*;
                        const v: i64 = if (unsigned) (if (o7) raw else raw & 0xffff) else if (o7) @as(i32, @bitCast(raw)) else @as(i16, @bitCast(@as(u16, @truncate(raw))));
                        vreg(F, c, d).* = @as(F, @floatFromInt(v)) / scale;
                    }
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

/// The ARMv8 floating-point instructions of the unconditional space: VSEL, VMAXNM and VMINNM, and VRINTA/N/P/M and
/// VCVTA/N/P/M, which round as their RM field (bits 17:16) says rather than as FPSCR does.
fn vfpV8(comptime F: type, c: *Cpu, w: u32, d: u32, n: u32, m: u32) ?Status {
    const vm = vreg(F, c, m).*;
    const o6 = w & 0x40 != 0;
    switch (bits(w, 20, 4) & 0xb) {
        0...3 => {
            if (o6) return null;
            // EQ, VS, GE or GT: cc:(cc<1> EOR cc<0>):0
            const cc = bits(w, 20, 2);
            vreg(F, c, d).* = if (cond(c, (cc << 2) | ((((cc >> 1) ^ cc) & 1) << 1))) vreg(F, c, n).* else vm;
        },
        8 => vreg(F, c, d).* = fp.fnm(F, vreg(F, c, n).*, vm, !o6),
        0xb => {
            if (!o6 or bits(w, 19, 1) == 0) return null;
            const mode = bits(w, 16, 2);
            const t = if (mode == 0) @round(vm) else fp.rint(F, (mode - 1) << 22, vm);
            if (bits(w, 18, 1) == 0) {
                if (w & 0x80 != 0) return null;
                vreg(F, c, d).* = t;
            } else {
                const dst = vreg(u32, c, (bits(w, 12, 4) << 1) | bits(w, 22, 1));
                dst.* = if (w & 0x80 != 0) @bitCast(fp.toInt(i32, t)) else fp.toInt(u32, t);
            }
        },
        else => return null,
    }
    return .next;
}
