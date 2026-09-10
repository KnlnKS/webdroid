// ARM32: the A32 instruction set, Thumb-1 (T16, ARMv5T/v6) and the VFPv3 coprocessor, decoded
// as they execute over the Cpu. Registers are the low words of `x`; flags are CPSR's; the VFP
// file is `v` with Sn at byte 4n and Dn at byte 8n (d0-d15 aliasing s0-s31 as the hardware does);
// FPSCR lives in `fpcr`. Every instruction leaves the next pc in c.pc.

const std = @import("std");
const abi = @import("abi.zig");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const a64 = @import("a64.zig");
const fp = @import("fp.zig");
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
/// a register as an operand: r15 reads as the fetch address
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
/// interworking branch: the low bit selects the instruction set
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

/// register-specified shift with carry-out
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
/// operand2 with its shifter carry (the carry in when the shift leaves it alone)
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

// ── A32
/// one instruction, for the JIT's fallback
pub fn step(c: *Cpu, pc: u32) Status {
    return if (c.cpsr & (1 << 5) != 0) execThumb(c, pc) else execArm(c, pc);
}
fn execArm(c: *Cpu, pc: u32) Status {
    const w = ld(u32, pc);
    const cc = w >> 28;
    c.pc = pc + 4;
    if (cc == 15) {
        if ((w & 0x0e000000) == 0x0a000000) { // BLX (immediate): to Thumb
            const off: u32 = @bitCast((@as(i32, @bitCast(w << 8)) >> 6) | @as(i32, @intCast((w >> 23) & 2)));
            set(c, 14, pc + 4);
            return bx(c, ((pc +% 8 +% off) & ~@as(u32, 1)) | 1);
        }
        if ((w & 0x0d70f000) == 0x0550f000) return .next; // PLD
        if ((w & 0x0ff000f0) == 0x05700040 or (w & 0x0ff000f0) == 0x05700050 or (w & 0x0ff000f0) == 0x05700060) return .next; // barriers
        if ((w & 0x0fff00ff) == 0x057ff01f) { // CLREX
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
        5 => { // B / BL
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
        4 => { // LDM / STM
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
            if (w & (1 << 24) != 0) return swi(c, pc);
            if ((w & 0x0ff00fff) == 0x0e1d0f70 and bits(w, 8, 4) == 15) { // mrc p15, 0, rd, c13, c0, 3
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
        if ((w & 0x0ff000f0) == 0x01200010) return bx(c, reg(c, rm, pc)); // BX
        if ((w & 0x0ff000f0) == 0x01200030) { // BLX (register)
            set(c, 14, pc + 4);
            return bx(c, reg(c, rm, pc));
        }
        if ((w & 0x0ff000f0) == 0x01200070) return fault(c, .brk, w, pc);
        if ((w & 0x0fff0ff0) == 0x016f0f10) { // CLZ
            set(c, rd, @clz(reg(c, rm, pc)));
            return .next;
        }
        if ((w & 0x0fbf0fff) == 0x010f0000) { // MRS
            set(c, rd, c.cpsr | 0x10);
            return .next;
        }
        if ((w & 0x0fc000f0) == 0x00000090) { // MUL / MLA
            var v = reg(c, rm, pc) *% reg(c, rs, pc);
            if (w & (1 << 21) != 0) v +%= r(c, rd);
            set(c, rn, v);
            if (w & (1 << 20) != 0) setNZ(c, v);
            return .next;
        }
        if ((w & 0x0f8000f0) == 0x00800090) { // UMULL / UMLAL / SMULL / SMLAL
            const signed = w & (1 << 22) != 0;
            var p: u64 = if (signed) @bitCast(@as(i64, @as(i32, @bitCast(reg(c, rm, pc)))) *% @as(i64, @as(i32, @bitCast(reg(c, rs, pc))))) else @as(u64, reg(c, rm, pc)) *% @as(u64, reg(c, rs, pc));
            if (w & (1 << 21) != 0) p +%= (@as(u64, r(c, rn)) << 32) | r(c, rd);
            set(c, rd, @truncate(p));
            set(c, rn, @intCast(p >> 32));
            if (w & (1 << 20) != 0) c.cpsr = (c.cpsr & 0x3fff_ffff) | (@as(u32, @intCast(p >> 63)) << 31) | (@as(u32, @intFromBool(p == 0)) << 30);
            return .next;
        }
        if ((w & 0x0fb000f0) == 0x01000090) { // SWP / SWPB
            const byte = w & (1 << 22) != 0;
            const a = addr(c, reg(c, rn, pc)) orelse return badAddr(c, w, pc);
            const t: u32 = if (byte) ld(u8, a) else ld(u32, a);
            if (!(if (byte) st(u8, c, a, @truncate(reg(c, rm, pc))) else st(u32, c, a, reg(c, rm, pc)))) return badAddr(c, w, pc);
            set(c, rd, t);
            return .next;
        }
        if ((w & 0x0f9000f0) == 0x01800090) { // LDREX / STREX family (0 word, 1 dword, 2 byte, 3 half)
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
        if ((w & 0x0f900090) == 0x01000080) { // DSP: SMLAxy SMULxy SMLAWy SMULWy SMLALxy
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
        if ((w & 0x0f9000f0) == 0x01000050) { // QADD / QSUB / QDADD / QDSUB
            const o = bits(w, 21, 2);
            const n: i64 = @as(i32, @bitCast(reg(c, rn, pc)));
            const dbl: i64 = if (o & 2 != 0) sat32(c, n * 2) else n;
            const m: i64 = @as(i32, @bitCast(reg(c, rm, pc)));
            set(c, rd, @bitCast(@as(i32, @intCast(sat32(c, if (o & 1 != 0) m - dbl else m + dbl)))));
            return .next;
        }
        if ((w & 0x0e000090) == 0x00000090) { // LDRH/STRH/LDRSB/LDRSH/LDRD/STRD
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
                    2 => set(c, rd, @bitCast(@as(i32, ld(i8, a)))),
                    3 => set(c, rd, @bitCast(@as(i32, ld(i16, a)))),
                    else => return fault(c, .unimplemented, w, pc),
                }
            } else switch (sh) {
                1 => if (!st(u16, c, a, @truncate(r(c, rd)))) return badAddr(c, w, pc),
                2 => { // LDRD
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
    if ((w & 0x0db0f000) == 0x0120f000 and (top == 1 or (w & 0xf0) == 0)) { // MSR
        const src = if (top == 1) op2(c, w, pc).v else reg(c, rm, pc);
        if (w & (1 << 19) != 0) c.cpsr = (c.cpsr & 0x07ff_ffff) | (src & 0xf800_0000);
        return .next;
    }
    if (top == 1 and (w & 0x0fb00000) == 0x03000000) { // MOVW / MOVT
        const imm16 = ((w >> 4) & 0xf000) | (w & 0xfff);
        set(c, rd, if (w & (1 << 22) != 0) (r(c, rd) & 0xffff) | (imm16 << 16) else imm16);
        return .next;
    }
    const o = bits(w, 21, 4);
    const setf = w & (1 << 20) != 0;
    const t = op2(c, w, pc);
    const a = reg(c, rn, pc);
    var v: u32 = undefined;
    var logical = false;
    switch (o) {
        0, 8 => {
            v = a & t.v;
            logical = true;
        },
        1, 9 => {
            v = a ^ t.v;
            logical = true;
        },
        12 => {
            v = a | t.v;
            logical = true;
        },
        14 => {
            v = a & ~t.v;
            logical = true;
        },
        13 => {
            v = t.v;
            logical = true;
        },
        15 => {
            v = ~t.v;
            logical = true;
        },
        2, 10 => v = if (setf) subFlags(c, a, t.v, 1) else a -% t.v,
        3 => v = if (setf) subFlags(c, t.v, a, 1) else t.v -% a,
        4, 11 => v = if (setf) addFlags(c, a, t.v, 0) else a +% t.v,
        5 => v = if (setf) addFlags(c, a, t.v, @intCast(cf(c))) else a +% t.v +% cf(c),
        6 => v = if (setf) subFlags(c, a, t.v, @intCast(cf(c))) else a -% t.v -% 1 +% cf(c),
        else => v = if (setf) subFlags(c, t.v, a, @intCast(cf(c))) else t.v -% a -% 1 +% cf(c),
    }
    if (setf and logical) setNZC(c, v, t.carry);
    if (o < 8 or o > 11) {
        if (rd == 15) return bx(c, v);
        set(c, rd, v);
    }
    return .next;
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

/// ARMv6 media instructions (top = 3, bit 4 set): extends, reverses, bitfields, saturates, pack
fn media(c: *Cpu, w: u32, pc: u32, rd: u32, rn: u32, rm: u32, rs: u32) Status {
    const op1 = bits(w, 20, 5);
    const op2b = bits(w, 5, 3);
    const RM = reg(c, rm, pc);
    const RN = reg(c, rn, pc);
    if ((w & 0x0fe00070) == 0x07c00010) { // BFI / BFC
        const lsb = bits(w, 7, 5);
        const msb = bits(w, 16, 5);
        const width = msb -% lsb +% 1;
        const mask: u32 = if (width >= 32) 0xffff_ffff else ((@as(u32, 1) << @intCast(width)) - 1) << @intCast(lsb);
        set(c, rd, if (rn == 15) r(c, rd) & ~mask else (r(c, rd) & ~mask) | ((RN << @intCast(lsb)) & mask));
        return .next;
    }
    if ((w & 0x0fa00070) == 0x07a00050) { // SBFX / UBFX
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
    if (op1 >= 8 and op1 <= 15 and (op2b & 3) == 3) { // SXTB16/SXTB/SXTH/UXTB16/UXTB/UXTH (+A)
        const rot = bits(w, 10, 2) * 8;
        const rotated = std.math.rotr(u32, RM, rot);
        const add: u32 = if (rn == 15) 0 else RN;
        const v: u32 = switch (op1) {
            10 => add +% @as(u32, @bitCast(@as(i32, @as(i8, @bitCast(@as(u8, @truncate(rotated))))))),
            11 => add +% @as(u32, @bitCast(@as(i32, @as(i16, @bitCast(@as(u16, @truncate(rotated))))))),
            14 => add +% (rotated & 255),
            15 => add +% (rotated & 65535),
            8 => (@as(u32, @bitCast(@as(i32, @as(i8, @bitCast(@as(u8, @truncate(rotated))))))) & 0xffff) | (@as(u32, @bitCast(@as(i32, @as(i8, @bitCast(@as(u8, @truncate(rotated >> 16))))))) << 16),
            12 => rotated & 0xff00ff,
            else => return fault(c, .unimplemented, w, pc),
        };
        set(c, rd, v);
        return .next;
    }
    if ((w & 0x0fff0ff0) == 0x06bf0f30) { // REV
        set(c, rd, @byteSwap(RM));
        return .next;
    }
    if ((w & 0x0fff0ff0) == 0x06bf0fb0) { // REV16
        set(c, rd, ((RM & 0xff00ff) << 8) | ((RM >> 8) & 0xff00ff));
        return .next;
    }
    if ((w & 0x0fff0ff0) == 0x06ff0fb0) { // REVSH
        set(c, rd, @bitCast(@as(i32, @as(i16, @bitCast(@as(u16, @byteSwap(@as(u16, @truncate(RM)))))))));
        return .next;
    }
    if ((w & 0x0ff00ff0) == 0x06800fb0) { // SEL
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
    if ((w & 0x0fe00030) == 0x06a00010 or (w & 0x0fe00030) == 0x06e00010) { // SSAT / USAT
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
    if ((w & 0x0ff00030) == 0x06800010) { // PKHBT / PKHTB
        const sh = bits(w, 7, 5);
        if (w & (1 << 6) != 0) set(c, rd, (RN & 0xffff0000) | (@as(u32, @bitCast(@as(i32, @bitCast(RM)) >> @intCast(if (sh == 0) 31 else sh))) & 0xffff)) else set(c, rd, (RN & 0xffff) | ((RM << @intCast(sh)) & 0xffff0000));
        return .next;
    }
    if ((w & 0x0ff000f0) == 0x07800010) { // USAD8 / USADA8
        const s = reg(c, rs, pc);
        var sum: u32 = if (rd == 15) 0 else r(c, rd);
        var i: u5 = 0;
        while (i < 4) : (i += 1) sum +%= @abs(@as(i32, @intCast((RM >> (8 * i)) & 255)) - @as(i32, @intCast((s >> (8 * i)) & 255)));
        set(c, rn, sum);
        return .next;
    }
    if ((w & 0x0ff000f0) == 0x0700f010) { // SMUAD-shaped fallback: the low product
        set(c, rn, RM *% reg(c, rs, pc));
        return .next;
    }
    if ((w & 0x0ff0f0f0) == 0x0750f010 or (w & 0x0ff000f0) == 0x07500010) { // SMMUL / SMMLA
        const p: i64 = @as(i64, @as(i32, @bitCast(RM))) * @as(i64, @as(i32, @bitCast(reg(c, rs, pc))));
        var v: u32 = @truncate(@as(u64, @bitCast(p)) >> 32);
        if ((w & 0x0ff0f0f0) != 0x0750f010) v +%= r(c, rd);
        set(c, rn, v);
        return .next;
    }
    return fault(c, .unimplemented, w, pc);
}

/// EABI syscall (swi 0, number in r7): only what a userspace runtime issues directly
fn swi(c: *Cpu, pc: u32) Status {
    switch (r(c, 7)) {
        0xf0002 => { // __ARM_NR_cacheflush
            cpu.invalidate_range(r(c, 0), r(c, 1) -% r(c, 0));
            set(c, 0, 0);
        },
        0xf0005 => { // __ARM_NR_set_tls
            c.tls = r(c, 0);
            set(c, 0, 0);
        },
        175 => {
            c.exit = 175;
            return .syscall;
        },
        20 => set(c, 0, 4242),
        224 => set(c, 0, 4242 + c.tid),
        else => {
            c.exit = @intFromEnum(Fault.unsupported_syscall);
            c.fault_word = r(c, 7);
            c.pc = pc;
            return .fault;
        },
    }
    return .jump;
}

// ── VFP
inline fn S(c: *Cpu, n: u32) *align(4) f32 {
    return @ptrCast(@alignCast(&c.v[n >> 2][(n & 3) * 4]));
}
inline fn D(c: *Cpu, n: u32) *align(8) f64 {
    return @ptrCast(@alignCast(&c.v[n >> 1][(n & 1) * 8]));
}
inline fn SI(c: *Cpu, n: u32) *align(4) u32 {
    return @ptrCast(@alignCast(&c.v[n >> 2][(n & 3) * 4]));
}
/// one VFP instruction (ARM encoding, cond already handled); null when not VFP
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
        if (top == 12 and !P and !W and bits(w, 21, 2) == 2) { // 64-bit transfers
            const rt = bits(w, 12, 4);
            const rt2 = bits(w, 16, 4);
            const lo = if (dp) m * 2 else m;
            if (Ld) {
                set(c, rt, SI(c, lo).*);
                set(c, rt2, SI(c, lo + 1).*);
            } else {
                SI(c, lo).* = r(c, rt);
                SI(c, lo + 1).* = r(c, rt2);
            }
            return .next;
        }
        if (P and !W) { // VLDR / VSTR
            const base = if (rn == 15) (pc +% 8) & ~@as(u32, 3) else r(c, rn);
            const a = addr(c, if (U) base +% imm8 * 4 else base -% imm8 * 4) orelse return badAddr(c, w, pc);
            if (Ld) {
                if (dp) SI(c, d * 2).* = ld(u32, a) else SI(c, d).* = ld(u32, a);
                if (dp) SI(c, d * 2 + 1).* = ld(u32, a + 4);
            } else {
                if (!st(u32, c, a, SI(c, if (dp) d * 2 else d).*)) return badAddr(c, w, pc);
                if (dp and !st(u32, c, a + 4, SI(c, d * 2 + 1).*)) return badAddr(c, w, pc);
            }
            return .next;
        }
        // VLDM / VSTM / VPUSH / VPOP
        const count = if (dp) imm8 >> 1 else imm8;
        const nbytes = imm8 * 4;
        var a = addr(c, if (U) r(c, rn) else r(c, rn) -% nbytes) orelse return badAddr(c, w, pc);
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            const words: u32 = if (dp) 2 else 1;
            var k: u32 = 0;
            while (k < words) : (k += 1) {
                const slot = if (dp) (d + i) * 2 + k else d + i;
                if (Ld) SI(c, slot).* = ld(u32, a) else if (!st(u32, c, a, SI(c, slot).*)) return badAddr(c, w, pc);
                a += 4;
            }
        }
        if (W) set(c, rn, if (U) r(c, rn) +% nbytes else r(c, rn) -% nbytes);
        return .next;
    }
    if (top != 14) return null;
    if (w & 0x10 != 0) { // register transfers
        const rt = bits(w, 12, 4);
        const o = bits(w, 21, 3);
        const Ld = bits(w, 20, 1) != 0;
        if (o == 0 and !dp) {
            if (Ld) set(c, rt, SI(c, n).*) else SI(c, n).* = reg(c, rt, pc);
            return .next;
        }
        if (o == 7 and !dp) { // VMRS / VMSR: FPSCR is register 1; FPSID/MVFR read as constants
            if (Ld) {
                if (vn == 1) {
                    if (rt == 15) c.cpsr = (c.cpsr & 0x0fff_ffff) | (c.fpcr & 0xf000_0000) else set(c, rt, c.fpcr);
                } else set(c, rt, if (vn == 0) 0x410330c0 else if (vn == 6) 0x11111111 else if (vn == 7) 0x00011100 else 0);
            } else if (vn == 1) c.fpcr = r(c, rt);
            return .next;
        }
        if (dp and (o == 0 or o == 1) and (w & 0x60) == 0) { // VMOV scalar ↔ core, the 32-bit lane form
            const lane = n * 2 + (o & 1);
            if (Ld) set(c, rt, SI(c, lane).*) else SI(c, lane).* = reg(c, rt, pc);
            return .next;
        }
        return null;
    }
    return if (dp) vfpArith(f64, c, w, d, n, m) else vfpArith(f32, c, w, d, n, m);
}
fn vfpArith(comptime F: type, c: *Cpu, w: u32, d: u32, n: u32, m: u32) ?Status {
    const dp = F == f64;
    const get = struct {
        fn f(cc: *Cpu, i: u32) F {
            return if (dp) D(cc, i).* else S(cc, i).*;
        }
    }.f;
    const put = struct {
        fn f(cc: *Cpu, i: u32, v: F) void {
            if (dp) D(cc, i).* = v else S(cc, i).* = v;
        }
    }.f;
    const opc1 = bits(w, 20, 4) & 0xb;
    const o6 = bits(w, 6, 1) != 0;
    const vd = get(c, d);
    const vn = get(c, n);
    const vm = get(c, m);
    switch (opc1) {
        0x0 => put(c, d, if (o6) vd - vn * vm else vd + vn * vm),
        0x1 => put(c, d, if (o6) -vd - vn * vm else -vd + vn * vm),
        0x2 => put(c, d, if (o6) -(vn * vm) else vn * vm),
        0x3 => put(c, d, if (o6) vn - vm else vn + vm),
        0x8 => if (o6) return null else put(c, d, vn / vm),
        0x9 => put(c, d, if (o6) fp.fma(F, -vn, vm, -vd) else fp.fma(F, vn, vm, -vd)),
        0xa => put(c, d, if (o6) fp.fma(F, -vn, vm, vd) else fp.fma(F, vn, vm, vd)),
        0xb => {
            if (!o6) { // VMOV (immediate)
                const imm = @import("simd.zig").vfpImm(bits(w, 16, 4) << 4 | (w & 15), dp);
                if (dp) SI(c, d * 2).* = @truncate(imm) else SI(c, d).* = @truncate(imm);
                if (dp) SI(c, d * 2 + 1).* = @intCast(imm >> 32);
                return .next;
            }
            const opc2 = bits(w, 16, 4);
            const o7 = bits(w, 7, 1) != 0;
            switch (opc2) {
                0 => put(c, d, if (o7) @abs(vm) else vm),
                1 => put(c, d, if (o7) @sqrt(vm) else -vm),
                4, 5 => c.fpcr = (c.fpcr & 0x0fff_ffff) | fp.fcmp(vd, if (opc2 == 5) @as(F, 0) else vm),
                7 => { // VCVT between single and double
                    if (!o7) return null;
                    if (dp) S(c, (bits(w, 12, 4) << 1) | bits(w, 22, 1)).* = @floatCast(vm) else D(c, (bits(w, 22, 1) << 4) | bits(w, 12, 4)).* = S(c, m).*;
                },
                8 => { // VCVT from int (o7: signed)
                    const src = SI(c, (bits(w, 0, 4) << 1) | bits(w, 5, 1)).*;
                    put(c, d, if (o7) @floatFromInt(@as(i32, @bitCast(src))) else @floatFromInt(src));
                },
                12, 13 => { // VCVT to int (12 unsigned, 13 signed); o7: round toward zero
                    const t = if (o7) @trunc(vm) else fp.rne(F, vm);
                    const dst = SI(c, (bits(w, 12, 4) << 1) | bits(w, 22, 1));
                    dst.* = if (opc2 == 13) @bitCast(fp.toInt(i32, t)) else fp.toInt(u32, t);
                },
                else => return null,
            }
        },
        else => return null,
    }
    return .next;
}

// ── Thumb-1
fn execThumb(c: *Cpu, pc: u32) Status {
    const h: u32 = ld(u16, pc);
    c.pc = pc + 2;
    const top = h >> 12;
    const rd = h & 7;
    const rn = (h >> 3) & 7;
    const rm = (h >> 6) & 7;
    switch (top) {
        0, 1 => {
            const o = (h >> 11) & 3;
            if (o == 3) {
                const t: u32 = if (h & (1 << 10) != 0) rm else r(c, rm);
                set(c, rd, if (h & (1 << 9) != 0) subFlags(c, r(c, rn), t, 1) else addFlags(c, r(c, rn), t, 0));
            } else {
                const nsh = (h >> 6) & 31;
                const t = r(c, rn);
                const s = if (o == 0 and nsh == 0) Shifted{ .v = t, .carry = cf(c) } else shiftReg(c, o, t, if (nsh == 0) 32 else nsh);
                set(c, rd, s.v);
                setNZC(c, s.v, s.carry);
            }
        },
        2, 3 => {
            const o = (h >> 11) & 3;
            const r8 = (h >> 8) & 7;
            const imm = h & 255;
            switch (o) {
                0 => {
                    set(c, r8, imm);
                    setNZ(c, imm);
                },
                1 => _ = subFlags(c, r(c, r8), imm, 1),
                2 => set(c, r8, addFlags(c, r(c, r8), imm, 0)),
                else => set(c, r8, subFlags(c, r(c, r8), imm, 1)),
            }
        },
        4 => {
            if ((h & 0xfc00) == 0x4000) {
                const o = (h >> 6) & 15;
                const R = r(c, rd);
                const Mv = r(c, rn);
                switch (o) {
                    0 => {
                        set(c, rd, R & Mv);
                        setNZ(c, R & Mv);
                    },
                    1 => {
                        set(c, rd, R ^ Mv);
                        setNZ(c, R ^ Mv);
                    },
                    2, 3, 4, 7 => {
                        const s = shiftReg(c, if (o == 7) 3 else o - 2, R, Mv & 255);
                        set(c, rd, s.v);
                        setNZC(c, s.v, s.carry);
                    },
                    5 => set(c, rd, addFlags(c, R, Mv, @intCast(cf(c)))),
                    6 => set(c, rd, subFlags(c, R, Mv, @intCast(cf(c)))),
                    8 => setNZ(c, R & Mv),
                    9 => set(c, rd, subFlags(c, 0, Mv, 1)),
                    10 => _ = subFlags(c, R, Mv, 1),
                    11 => _ = addFlags(c, R, Mv, 0),
                    12 => {
                        set(c, rd, R | Mv);
                        setNZ(c, R | Mv);
                    },
                    13 => {
                        set(c, rd, R *% Mv);
                        setNZ(c, R *% Mv);
                    },
                    14 => {
                        set(c, rd, R & ~Mv);
                        setNZ(c, R & ~Mv);
                    },
                    else => {
                        set(c, rd, ~Mv);
                        setNZ(c, ~Mv);
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
                3 => set(c, rd, @bitCast(@as(i32, ld(i8, a)))),
                4 => set(c, rd, ld(u32, a)),
                5 => set(c, rd, ld(u16, a)),
                6 => set(c, rd, ld(u8, a)),
                else => set(c, rd, @bitCast(@as(i32, ld(i16, a)))),
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
            if (cc == 15) return swi(c, pc);
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
    if ((h & 0xfe00) == 0xb400) { // PUSH
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
    if ((h & 0xfe00) == 0xbc00) { // POP
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
    if ((h & 0xff00) == 0xbf00 or (h & 0xffe8) == 0xb660) return .next; // hints, CPS
    const t = r(c, rn);
    switch (h & 0xffc0) {
        0xb200 => set(c, rd, @bitCast(@as(i32, @as(i16, @bitCast(@as(u16, @truncate(t))))))),
        0xb240 => set(c, rd, @bitCast(@as(i32, @as(i8, @bitCast(@as(u8, @truncate(t))))))),
        0xb280 => set(c, rd, t & 0xffff),
        0xb2c0 => set(c, rd, t & 255),
        0xba00 => set(c, rd, @byteSwap(t)),
        0xba40 => set(c, rd, ((t & 0xff00ff) << 8) | ((t >> 8) & 0xff00ff)),
        0xbac0 => set(c, rd, @bitCast(@as(i32, @as(i16, @bitCast(@as(u16, @byteSwap(@as(u16, @truncate(t))))))))),
        else => {
            if ((h & 0xf500) == 0xb100) { // CBZ / CBNZ
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

/// interpret from `start` to the first control transfer (or max_block instructions)
pub fn block(c: *Cpu, start: u32) Status {
    const thumb = c.cpsr & (1 << 5) != 0;
    if (start & (if (thumb) @as(u32, 1) else 3) != 0) return fault(c, .misaligned_pc, start, start);
    c.bpc = start | @intFromBool(thumb);
    var pc = start;
    var n: u32 = 0;
    var s: Status = .next;
    while (n < cpu.max_block) {
        if (pc < abi.LOW) {
            s = fault(c, .bad_address, pc, pc);
            break;
        }
        n += 1;
        s = if (thumb) execThumb(c, pc) else execArm(c, pc);
        if (s != .next) break;
        pc = @truncate(c.pc);
    }
    c.ic += n;
    cpu.stats.interp += n;
    return if (s == .next) .jump else s;
}
