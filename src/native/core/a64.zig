const abi = @import("abi.zig");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const libc = @import("libc.zig");
const simd = @import("simd.zig");
const Cpu = cpu.Cpu;
const Status = cpu.Status;
const Fault = cpu.Fault;

pub const Kind = enum(u16) {
    raw = 0,
    fault,
    nop,
    adr,
    addsub,
    logic,
    movw,
    bfm,
    extr,
    b,
    bcond,
    cbz,
    tbz,
    br,
    svc,
    clrex,
    mrs,
    msr,
    ldrlit,
    ldp,
    excl,
    atomic,
    ldst,
    adc,
    ccmp,
    csel,
    one,
    two,
    three,
    simd,
    vldrlit,
    vmem,
};

pub const Op = extern struct {
    kind: Kind,
    rd: u8,
    rn: u8,
    rm: u8,
    ra: u8,
    a: u8,
    b: u8,
    imm: u64,
};

const std = @import("std");
const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
const ones = bt.ones;
const raise = cpu.raise;
const st = cpu.st;
/// an A64 process's loads: it has no window
inline fn ld(comptime T: type, a: u32) T {
    return mem.ptr(T, a).*;
}
fn op(kind: Kind, w: u32) Op {
    return .{ .kind = kind, .rd = @intCast(w & 31), .rn = @intCast((w >> 5) & 31), .rm = @intCast((w >> 16) & 31), .ra = @intCast((w >> 10) & 31), .a = 0, .b = 0, .imm = 0 };
}
fn faultOp(code: Fault) Op {
    return .{ .kind = .fault, .rd = 0, .rn = 0, .rm = 0, .ra = 0, .a = @intCast(@intFromEnum(code)), .b = 0, .imm = 0 };
}

const Masks = struct { wmask: u64, tmask_ones: u8, esize_log: u8 };
fn bitMasks(n: u32, imms: u32, immr: u32, sf: bool, immediate: bool) ?Masks {
    const width: u32 = if (sf) 64 else 32;
    const combined = (n << 6) | (~imms & 0x3f);
    if (combined == 0) return null;
    const len: u5 = @intCast(31 - @clz(combined));
    if (len < 1 or (@as(u32, 1) << len) > width) return null;
    const levels = (@as(u32, 1) << len) - 1;
    const s = imms & levels;
    const r = immr & levels;
    if (immediate and s == levels) return null;
    const d = (s -% r) & levels;
    const esize: u32 = @as(u32, 1) << len;
    const welem = ones(s + 1);
    const rot = if (r == 0) welem else ((welem >> @intCast(r)) | (welem << @intCast(esize - r))) & ones(esize);
    return .{ .wmask = replicate(rot, esize, width), .tmask_ones = @intCast(d + 1), .esize_log = len };
}
pub inline fn replicate(v: u64, esize: u32, width: u32) u64 {
    const unit = if (esize >= 64) 1 else (~@as(u64, 0) / ones(esize));
    return (v *% unit) & ones(width);
}

pub fn decode(w: u32, pc: u32) Op {
    const sf = (w >> 31) & 1;
    if (is(w, 0x1c000000, 0x10000000)) {
        const o = bits(w, 23, 3);
        switch (o) {
            0, 1 => {
                var r = op(.adr, w);
                const imm = bt.sx(i32, (bits(w, 5, 19) << 2) | bits(w, 29, 2), 21);
                r.imm = if (w & 0x80000000 != 0) (pc & ~@as(u32, 0xfff)) +% @as(u32, @bitCast(imm)) *% 4096 else pc +% @as(u32, @bitCast(imm));
                return r;
            },
            2, 3 => {
                var r = op(.addsub, w);
                r.a = @intCast(bits(w, 30, 1) | (bits(w, 29, 1) << 1) | (sf << 2));
                r.imm = @as(u64, bits(w, 10, 12)) << @as(u6, if (bits(w, 22, 1) != 0) 12 else 0);
                return r;
            },
            4 => {
                const m = bitMasks(bits(w, 22, 1), bits(w, 10, 6), bits(w, 16, 6), sf == 1, true) orelse return faultOp(.undefined);
                var r = op(.logic, w);
                r.a = @intCast(bits(w, 29, 2) | (sf << 2));
                r.b = 0;
                r.imm = m.wmask;
                return r;
            },
            5 => {
                const opc = bits(w, 29, 2);
                if (opc == 1) return faultOp(.undefined);
                const hw = bits(w, 21, 2);
                if (sf == 0 and hw > 1) return faultOp(.undefined);
                var r = op(.movw, w);
                r.a = @intCast(opc | (sf << 2));
                r.b = @intCast(hw * 16);
                r.imm = bits(w, 5, 16);
                return r;
            },
            6 => {
                const opc = bits(w, 29, 2);
                const nb = bits(w, 22, 1);
                if (opc == 3 or nb != sf) return faultOp(.undefined);
                const m = bitMasks(nb, bits(w, 10, 6), bits(w, 16, 6), sf == 1, false) orelse return faultOp(.undefined);
                var r = op(.bfm, w);
                r.a = @intCast(opc | (sf << 2) | (@as(u32, m.esize_log) << 3));
                r.b = @intCast(bits(w, 16, 6));
                r.ra = @intCast(bits(w, 10, 6));
                r.rm = m.tmask_ones;
                r.imm = m.wmask;
                return r;
            },
            else => {
                var r = op(.extr, w);
                r.a = @intCast(sf);
                r.b = @intCast(bits(w, 10, 6));
                return r;
            },
        }
    }
    if (is(w, 0x1c000000, 0x14000000)) {
        if (is(w, 0x7c000000, 0x14000000)) {
            var r = op(.b, w);
            r.a = @intCast(w >> 31);
            r.imm = pc +% @as(u32, @bitCast(bt.sx(i32, w & 0x3ffffff, 26) *% 4));
            return r;
        }
        if (is(w, 0xff000010, 0x54000000)) {
            var r = op(.bcond, w);
            r.a = @intCast(w & 15);
            r.imm = pc +% @as(u32, @bitCast(bt.sx(i32, bits(w, 5, 19), 19) *% 4));
            return r;
        }
        if (is(w, 0x7e000000, 0x34000000)) {
            var r = op(.cbz, w);
            r.a = @intCast(sf | (bits(w, 24, 1) << 1));
            r.imm = pc +% @as(u32, @bitCast(bt.sx(i32, bits(w, 5, 19), 19) *% 4));
            return r;
        }
        if (is(w, 0x7e000000, 0x36000000)) {
            var r = op(.tbz, w);
            r.a = @intCast(bits(w, 24, 1));
            r.b = @intCast((bits(w, 31, 1) << 5) | bits(w, 19, 5));
            r.imm = pc +% @as(u32, @bitCast(bt.sx(i32, bits(w, 5, 14), 14) *% 4));
            return r;
        }
        if (is(w, 0xff9ffc1f, 0xd61f0000)) {
            var r = op(.br, w);
            r.a = @intCast(bits(w, 21, 2));
            return r;
        }
        if (is(w, 0xffe0001f, 0xd4000001)) return op(.svc, w);
        if (is(w, 0xfffff01f, 0xd503201f)) return op(.nop, w);
        if (is(w, 0xfffff01f, 0xd503301f)) return if (bits(w, 5, 3) == 2) op(.clrex, w) else op(.nop, w);
        if (is(w, 0xfff8f01f, 0xd500401f)) return op(.nop, w);
        if (is(w, 0xfff80000, 0xd5080000)) return if (bits(w, 5, 11) == 0x3a1) faultOp(.dc_zva) else op(.nop, w);
        if (is(w, 0xfff00000, 0xd5300000)) {
            var r = op(.mrs, w);
            r.imm = bits(w, 5, 15);
            return r;
        }
        if (is(w, 0xfff00000, 0xd5100000)) {
            var r = op(.msr, w);
            r.imm = bits(w, 5, 15);
            return r;
        }
        if (is(w, 0xffe0001f, 0xd4200000)) return faultOp(.brk);
        return faultOp(.unimplemented);
    }
    if (is(w, 0x0a000000, 0x08000000)) {
        if (w & 0x04000000 != 0) {
            if (is(w, 0x3b000000, 0x18000000)) {
                if (bits(w, 30, 2) == 3) return faultOp(.undefined);
                var r = op(.vldrlit, w);
                r.b = @intCast(bits(w, 30, 2));
                r.imm = pc +% @as(u32, @bitCast(bt.sx(i32, bits(w, 5, 19), 19) *% 4));
                return r;
            }
            var r = op(.vmem, w);
            r.imm = w;
            return r;
        }
        if (is(w, 0x3b000000, 0x18000000)) {
            var r = op(.ldrlit, w);
            r.b = @intCast(bits(w, 30, 2));
            r.imm = pc +% @as(u32, @bitCast(bt.sx(i32, bits(w, 5, 19), 19) *% 4));
            return r;
        }
        if (is(w, 0x3a000000, 0x28000000)) {
            const opc = bits(w, 30, 2);
            if (opc == 3) return faultOp(.undefined);
            var r = op(.ldp, w);
            r.a = @intCast(bits(w, 23, 2) | (bits(w, 22, 1) << 2) | (opc << 3));
            r.rm = @intCast(bits(w, 10, 5));
            r.imm = @bitCast(@as(i64, bt.sx(i32, bits(w, 15, 7), 7)) * @as(i64, if (opc == 2) 8 else 4));
            return r;
        }
        if (is(w, 0x3f000000, 0x08000000)) {
            var r = op(.excl, w);
            r.a = @intCast(bits(w, 30, 2));
            r.b = @intCast((bits(w, 23, 1) << 2) | (bits(w, 22, 1) << 1) | bits(w, 21, 1));
            r.ra = @intCast(bits(w, 10, 5));
            return r;
        }
        const size = bits(w, 30, 2);
        const opc = bits(w, 22, 2);
        if (is(w, 0x3f200c00, 0x38200000)) {
            var r = op(.atomic, w);
            r.a = @intCast(size);
            r.b = @intCast(bits(w, 12, 4));
            return r;
        }
        if (size == 3 and opc == 2) return op(.nop, w);
        var r = op(.ldst, w);
        r.b = @intCast((size << 2) | opc);
        if (is(w, 0x3b000000, 0x39000000)) {
            r.a = 0;
            r.imm = bits(w, 10, 12) << @intCast(size);
        } else if (is(w, 0x3b200c00, 0x38200800)) {
            r.a = 3;
            r.ra = @intCast((bits(w, 13, 3) << 1) | bits(w, 12, 1));
        } else {
            const kind = bits(w, 10, 2);
            if (kind == 2) return faultOp(.unimplemented);
            r.a = @as(u8, if (kind == 1) 1 else if (kind == 3) 2 else 0);
            r.imm = @bitCast(@as(i64, bt.sx(i32, bits(w, 12, 9), 9)));
        }
        return r;
    }
    if (is(w, 0x0e000000, 0x0a000000)) {
        if (is(w, 0x1f000000, 0x0a000000)) {
            const amt = bits(w, 10, 6);
            if (sf == 0 and amt > 31) return faultOp(.undefined);
            var r = op(.logic, w);
            r.a = @intCast(bits(w, 29, 2) | (sf << 2) | (1 << 3));
            r.b = 1;
            r.ra = @intCast(bits(w, 22, 2) | (bits(w, 21, 1) << 2));
            r.imm = amt;
            return r;
        }
        if (is(w, 0x1f000000, 0x0b000000)) {
            var r = op(.addsub, w);
            const ext = bits(w, 21, 1);
            r.a = @intCast(bits(w, 30, 1) | (bits(w, 29, 1) << 1) | (sf << 2) | (ext << 3));
            if (ext != 0) {
                r.b = 2;
                r.ra = @intCast(bits(w, 13, 3));
                r.imm = bits(w, 10, 3);
            } else {
                const t = bits(w, 22, 2);
                const amt = bits(w, 10, 6);
                if (t == 3 or (sf == 0 and amt > 31)) return faultOp(.undefined);
                r.b = 1;
                r.ra = @intCast(t);
                r.imm = amt;
            }
            return r;
        }
        if (is(w, 0x1fe00000, 0x1a000000)) {
            var r = op(.adc, w);
            r.a = @intCast(bits(w, 30, 1) | (bits(w, 29, 1) << 1) | (sf << 2));
            return r;
        }
        if (is(w, 0x1fe00000, 0x1a400000) and bits(w, 10, 2) <= 2) {
            var r = op(.ccmp, w);
            r.a = @intCast(bits(w, 30, 1) | (sf << 2) | (bits(w, 11, 1) << 3));
            r.b = @intCast(bits(w, 12, 4));
            r.ra = @intCast(w & 15);
            r.imm = bits(w, 16, 5);
            return r;
        }
        if (is(w, 0x1fe00000, 0x1a800000)) {
            var r = op(.csel, w);
            r.a = @intCast(bits(w, 30, 1) | (bits(w, 10, 2) << 1) | (sf << 2));
            r.b = @intCast(bits(w, 12, 4));
            return r;
        }
        if (is(w, 0x5fff0000, 0x5ac00000)) {
            const opc = bits(w, 10, 6);
            if (opc > 5 or (opc == 3 and sf == 0)) return faultOp(.unimplemented);
            var r = op(.one, w);
            r.a = @intCast(opc | (sf << 3));
            return r;
        }
        if (is(w, 0x5fe00000, 0x1ac00000)) {
            const opc = bits(w, 10, 6);
            const crc = opc >= 16 and opc <= 23 and (opc & 3 == 3) == (sf == 1);
            if (!(opc == 2 or opc == 3 or (opc >= 8 and opc <= 11) or crc)) return faultOp(.unimplemented);
            var r = op(.two, w);
            r.a = @intCast(opc | (sf << 6));
            return r;
        }
        if (is(w, 0x1f000000, 0x1b000000)) {
            const op31 = bits(w, 21, 3);
            if (!(op31 == 0 or op31 == 1 or op31 == 5 or op31 == 2 or op31 == 6)) return faultOp(.unimplemented);
            var r = op(.three, w);
            r.a = @intCast(op31 | (bits(w, 15, 1) << 3) | (sf << 4));
            return r;
        }
        return faultOp(.unimplemented);
    }
    if ((w & 0x0e000000) == 0x0e000000) {
        var r = op(.simd, w);
        r.imm = w;
        return r;
    }
    return faultOp(if (w == 0) .undefined else .unimplemented);
}

pub inline fn zr(c: *Cpu, n: u8) u64 {
    return if (n == 31) 0 else c.x[n];
}
pub inline fn setX(c: *Cpu, n: u8, v: u64) void {
    if (n != 31) c.x[n] = v;
}
pub inline fn setW(c: *Cpu, n: u8, v: u32) void {
    if (n != 31) c.x[n] = v;
}
pub fn cond(c: *Cpu, cc: u8) bool {
    const f = c.cpsr;
    const n = f >> 31 != 0;
    const z = f & (1 << 30) != 0;
    const cy = f & (1 << 29) != 0;
    const v = f & (1 << 28) != 0;
    const r = switch (cc >> 1) {
        0 => z,
        1 => cy,
        2 => n,
        3 => v,
        4 => cy and !z,
        5 => n == v,
        6 => !z and n == v,
        else => return true,
    };
    return r != (cc & 1 != 0);
}
pub inline fn nz(comptime T: type, v: T) u32 {
    const bitsT = @typeInfo(T).int.bits;
    return (@as(u32, @intCast(v >> (bitsT - 1))) << 31) | (@as(u32, @intFromBool(v == 0)) << 30);
}
fn Flagged(comptime T: type) type {
    return struct { r: T, f: u32 };
}
pub fn addc(comptime T: type, a: T, b: T, cin: u1) Flagged(T) {
    const r1 = @addWithOverflow(a, b);
    const r2 = @addWithOverflow(r1[0], @as(T, cin));
    const res = r2[0];
    const cflag: u32 = r1[1] | r2[1];
    const bitsT = @typeInfo(T).int.bits;
    const vflag: u32 = @intCast(((a ^ res) & (b ^ res)) >> (bitsT - 1));
    return .{ .r = res, .f = nz(T, res) | (cflag << 29) | (vflag << 28) };
}
inline fn subc(comptime T: type, a: T, b: T, cin: u1) Flagged(T) {
    return addc(T, a, ~b, cin);
}
inline fn shift(comptime T: type, v: T, kind: u8, amt: u32) T {
    const bitsT = @typeInfo(T).int.bits;
    const k: u32 = amt & (bitsT - 1);
    const s: std.math.Log2Int(T) = @intCast(k);
    return switch (kind & 3) {
        0 => v << s,
        1 => v >> s,
        2 => @bitCast(@as(std.meta.Int(.signed, bitsT), @bitCast(v)) >> s),
        else => if (k == 0) v else (v >> s) | (v << @intCast(bitsT - k)),
    };
}
fn operand2(c: *Cpu, o: *const Op) u64 {
    switch (o.b) {
        0 => return o.imm,
        1 => {
            const v = if (o.a & 4 != 0) shift(u64, zr(c, o.rm), o.ra, @intCast(o.imm)) else @as(u64, shift(u32, @truncate(zr(c, o.rm)), o.ra, @intCast(o.imm)));
            return if (o.ra & 4 != 0) ~v else v;
        },
        else => {
            return bt.extend(zr(c, o.rm), o.ra) << @intCast(o.imm);
        },
    }
}

/// the address bits of a data access under Top Byte Ignore, which Linux enables for arm64 user space
pub const TBI_MASK: u64 = 0x00ff_ffff_ffff_ffff;
pub inline fn addr(c: *Cpu, va: u64) ?u32 {
    const lo: u32 = @truncate(va);
    const hi: u32 = @intCast((va & TBI_MASK) >> 32);
    if (hi != 0) {
        const p = mem.tx(hi, lo);
        if (p == 0) {
            c.fault_addr = va & TBI_MASK;
            return null;
        }
        return p;
    }
    if (lo < abi.LOW) {
        c.fault_addr = lo;
        return null;
    }
    return lo;
}
inline fn badAddr(c: *Cpu, pc: u32) Status {
    return raise(c, .bad_address, ld(u32, pc));
}

fn sysRead(c: *Cpu, key: u64) ?u64 {
    return switch (key) {
        0x5a10 => c.cpsr & 0xf000_0000,
        0x5a20 => c.fpcr,
        0x5a21 => c.fpsr,
        0x5e82 => c.tls,
        0x5e83 => 0,
        0x5807 => 0x10,
        0x5801 => 0x8444c004,
        0x5f00 => 19200000,
        0x5f01, 0x5f02 => cnt(),
        else => if ((key & 0x7f80) == 0x4000) 0 else null,
    };
}
extern "env" fn now_ms() f64;
fn cnt() u64 {
    return @intFromFloat(now_ms() * 19200);
}

pub fn exec(c: *Cpu, o: *const Op, pc: u32) Status {
    switch (o.kind) {
        .raw => unreachable,
        .fault => return raise(c, @enumFromInt(o.a), ld(u32, pc)),
        .nop => {},
        .adr => setX(c, o.rd, o.imm),
        .addsub => if (o.a & 4 != 0) addsub(u64, c, o) else addsub(u32, c, o),
        .logic => {
            const opc = o.a & 3;
            const sf = o.a & 4 != 0;
            const a = zr(c, o.rn);
            const t = operand2(c, o);
            var v: u64 = switch (opc) {
                0, 3 => a & t,
                1 => a | t,
                else => a ^ t,
            };
            if (!sf) v &= 0xffff_ffff;
            if (opc == 3) {
                c.setNZCV(if (sf) nz(u64, v) else nz(u32, @truncate(v)));
                setX(c, o.rd, v);
            } else if (o.a & 8 != 0) setX(c, o.rd, v) else c.x[o.rd] = v;
        },
        .movw => {
            const sf = o.a & 4 != 0;
            const sh: u6 = @intCast(o.b);
            const val = o.imm << sh;
            switch (o.a & 3) {
                0 => setX(c, o.rd, if (sf) ~val else (~val & 0xffff_ffff)),
                2 => setX(c, o.rd, val),
                else => {
                    const keep = ~(@as(u64, 0xffff) << sh);
                    const v = (zr(c, o.rd) & keep) | val;
                    setX(c, o.rd, if (sf) v else v & 0xffff_ffff);
                },
            }
        },
        .bfm => {
            const opc = o.a & 3;
            const sf = o.a & 4 != 0;
            const width: u32 = if (sf) 64 else 32;
            const src = if (sf) zr(c, o.rn) else zr(c, o.rn) & 0xffff_ffff;
            const r: u32 = o.b;
            const rot = if (r == 0) src else if (sf) (src >> @intCast(r)) | (src << @intCast(64 - r)) else ((src >> @intCast(r)) | (src << @intCast(32 - r))) & 0xffff_ffff;
            const wmask = o.imm;
            const tmask = replicate(ones(o.rm), @as(u32, 1) << @intCast(o.a >> 3), width);
            const dst = if (opc == 1) zr(c, o.rd) else 0;
            const bot = if (opc == 1) (rot & wmask) | (dst & ~wmask) else rot & wmask;
            const top: u64 = if (opc == 0) (if ((src >> @intCast(o.ra)) & 1 != 0) ~@as(u64, 0) else 0) else dst;
            var v = (top & ~tmask) | (bot & tmask);
            if (!sf) v &= 0xffff_ffff;
            setX(c, o.rd, v);
        },
        .extr => if (o.a != 0) extr(u64, c, o) else extr(u32, c, o),
        .b => {
            if (o.a != 0) c.x[30] = pc + 4;
            c.pc = o.imm;
            return .jump;
        },
        .bcond => {
            if (cond(c, o.a)) {
                c.pc = o.imm;
                return .jump;
            }
        },
        .cbz => {
            const v = zr(c, o.rd);
            const zero = if (o.a & 1 != 0) v == 0 else @as(u32, @truncate(v)) == 0;
            if (zero != (o.a & 2 != 0)) {
                c.pc = o.imm;
                return .jump;
            }
        },
        .tbz => {
            const set = (zr(c, o.rd) >> @intCast(o.b)) & 1;
            if (set == o.a) {
                c.pc = o.imm;
                return .jump;
            }
        },
        .br => {
            const target = zr(c, o.rn);
            if (o.a == 1) c.x[30] = pc + 4;
            c.pc = target;
            return .jump;
        },
        .svc => {
            c.pc = pc + 4;
            return svc(c);
        },
        .clrex => c.excl = 0,
        .mrs => setX(c, o.rd, sysRead(c, o.imm) orelse return raise(c, .sysreg, ld(u32, pc))),
        .msr => {
            const t = zr(c, o.rd);
            switch (o.imm) {
                0x5a10 => c.setNZCV(@truncate(t)),
                0x5a20 => c.fpcr = @truncate(t),
                0x5a21 => c.fpsr = @truncate(t),
                0x5e82 => c.tls = t,
                else => return raise(c, .sysreg, ld(u32, pc)),
            }
        },
        .ldrlit => {
            const a: u32 = @truncate(o.imm);
            switch (o.b) {
                0 => setW(c, o.rd, ld(u32, a)),
                1 => setX(c, o.rd, ld(u64, a)),
                2 => setX(c, o.rd, @bitCast(@as(i64, ld(i32, a)))),
                else => {},
            }
        },
        .ldp => {
            const kind = o.a & 3;
            const opc = o.a >> 3;
            const base = if (kind == 1) c.x[o.rn] else c.x[o.rn] +% o.imm;
            const a = addr(c, base) orelse return badAddr(c, pc);
            if (kind == 1 or kind == 3) c.x[o.rn] +%= o.imm;
            for ([_]u8{ o.rd, o.rm }, 0..) |t, k| {
                const ea = a + (if (opc == 2) @as(u32, 8) else 4) * @as(u32, @intCast(k));
                if (o.a & 4 != 0) {
                    const v = if (opc == 2) ld(u64, ea) else ld(u32, ea);
                    setX(c, t, if (opc == 1) bt.sxw(v) else v);
                } else if (!(if (opc == 2) st(u64, c, ea, zr(c, t)) else st(u32, c, ea, @truncate(zr(c, t))))) return badAddr(c, pc);
            }
        },
        .excl => return exclusive(c, o, pc),
        .atomic => return atomic(c, o, pc),
        .ldst => {
            const size: u5 = @intCast(o.b >> 2);
            const opc = o.b & 3;
            var base = c.x[o.rn];
            switch (o.a) {
                0, 2 => base +%= o.imm,
                3 => {
                    const idx = bt.extend(zr(c, o.rm), o.ra >> 1);
                    base +%= if (o.ra & 1 != 0) idx << size else idx;
                },
                else => {},
            }
            const a = addr(c, base) orelse return badAddr(c, pc);
            if (o.a == 1 or o.a == 2) c.x[o.rn] = if (o.a == 1) base +% o.imm else base;
            const load = opc != 0 and !(size == 3 and opc == 2);
            if (!load) {
                if (!stSized(c, a, size, zr(c, o.rd))) return badAddr(c, pc);
            } else {
                const v = ldSized(a, size);
                const shl: u6 = @intCast(64 - (@as(u32, 8) << size));
                const s: u64 = @bitCast(@as(i64, @bitCast(v << shl)) >> shl);
                setX(c, o.rd, if (opc == 1 or size == 3) v else if (opc == 2) s else s & 0xffff_ffff);
            }
        },
        .adc => if (o.a & 4 != 0) adc(u64, c, o) else adc(u32, c, o),
        .ccmp => if (!cond(c, o.b)) c.setNZCV(@as(u32, o.ra) << 28) else if (o.a & 4 != 0) ccmp(u64, c, o) else ccmp(u32, c, o),
        .csel => {
            const opc = o.a & 1;
            const op2 = (o.a >> 1) & 1;
            const sf = o.a & 4 != 0;
            var v: u64 = undefined;
            if (cond(c, o.b)) v = zr(c, o.rn) else {
                const m = zr(c, o.rm);
                v = if (opc == 0) (if (op2 == 0) m else m +% 1) else (if (op2 == 0) ~m else 0 -% m);
            }
            setX(c, o.rd, if (sf) v else v & 0xffff_ffff);
        },
        .one => if (o.a & 8 != 0) one(u64, c, o) else one(u32, c, o),
        .two => if (o.a & 64 != 0) two(u64, c, o) else two(u32, c, o),
        .three => {
            const op31 = o.a & 7;
            const o0 = o.a & 8 != 0;
            const sf = o.a & 16 != 0;
            const n = zr(c, o.rn);
            const m = zr(c, o.rm);
            const acc = zr(c, o.ra);
            switch (op31) {
                0 => {
                    const p = n *% m;
                    const v = if (o0) acc -% p else acc +% p;
                    setX(c, o.rd, if (sf) v else v & 0xffff_ffff);
                },
                1, 5 => {
                    const p: u64 = if (op31 == 1) @bitCast(@as(i64, @as(i32, @bitCast(@as(u32, @truncate(n))))) *% @as(i64, @as(i32, @bitCast(@as(u32, @truncate(m)))))) else @as(u64, @as(u32, @truncate(n))) *% @as(u64, @as(u32, @truncate(m)));
                    setX(c, o.rd, if (o0) acc -% p else acc +% p);
                },
                else => {
                    const p: u64 = if (op31 == 2) @bitCast(@as(i64, @truncate((@as(i128, @as(i64, @bitCast(n))) * @as(i128, @as(i64, @bitCast(m)))) >> 64))) else @truncate((@as(u128, n) * @as(u128, m)) >> 64);
                    setX(c, o.rd, p);
                },
            }
        },
        .simd => return simd.exec(c, @truncate(o.imm)),
        .vldrlit => simd.vload(c, o.rd, @truncate(o.imm), @as(usize, 4) << @intCast(o.b)),
        .vmem => return simd.memop(c, @truncate(o.imm)),
    }
    return .next;
}

fn addsub(comptime T: type, c: *Cpu, o: *const Op) void {
    const base: T = @truncate(if (o.b == 1) zr(c, o.rn) else c.x[o.rn]);
    const t: T = @truncate(operand2(c, o));
    const r = if (o.a & 1 != 0) subc(T, base, t, 1) else addc(T, base, t, 0);
    if (o.a & 2 != 0) {
        c.setNZCV(r.f);
        setX(c, o.rd, r.r);
    } else c.x[o.rd] = r.r;
}
fn extr(comptime T: type, c: *Cpu, o: *const Op) void {
    const hi: T = @truncate(zr(c, o.rn));
    const lo: T = @truncate(zr(c, o.rm));
    setX(c, o.rd, if (o.b == 0) lo else (lo >> @intCast(o.b)) | (hi << @intCast(@bitSizeOf(T) - o.b)));
}
fn adc(comptime T: type, c: *Cpu, o: *const Op) void {
    const m: T = @truncate(zr(c, o.rm));
    const r = addc(T, @truncate(zr(c, o.rn)), if (o.a & 1 != 0) ~m else m, @intCast(c.cf()));
    if (o.a & 2 != 0) c.setNZCV(r.f);
    setX(c, o.rd, r.r);
}
fn ccmp(comptime T: type, c: *Cpu, o: *const Op) void {
    const n: T = @truncate(zr(c, o.rn));
    const rhs: T = @truncate(if (o.a & 8 != 0) o.imm else zr(c, o.rm));
    c.setNZCV(if (o.a & 1 != 0) subc(T, n, rhs, 1).f else addc(T, n, rhs, 0).f);
}
fn one(comptime T: type, c: *Cpu, o: *const Op) void {
    const x: T = @truncate(zr(c, o.rn));
    const v: T = switch (o.a & 7) {
        0 => @bitReverse(x),
        1 => @bitCast(@byteSwap(@as(@Vector(@sizeOf(T) / 2, u16), @bitCast(x)))),
        2 => if (T == u64) @bitCast(@byteSwap(@as(@Vector(2, u32), @bitCast(x)))) else @byteSwap(x),
        3 => @byteSwap(x),
        4 => @clz(x),
        else => @clz(x ^ @as(T, @bitCast(@as(bt.Signed(T), @bitCast(x)) >> (@bitSizeOf(T) - 1)))) - 1,
    };
    setX(c, o.rd, v);
}
/// CRC32{B,H,W,X} and CRC32C*: the reflected CRC of Rm's low 1 << sz bytes, onto Wn
fn crc32(c: *Cpu, o: *const Op) void {
    const poly: u32 = if (o.a & 4 != 0) 0x82f63b78 else 0xedb88320;
    var crc: u32 = @truncate(zr(c, o.rn));
    var m = zr(c, o.rm);
    for (0..@as(u32, 1) << @intCast(o.a & 3)) |_| {
        crc ^= @as(u8, @truncate(m));
        m >>= 8;
        for (0..8) |_| crc = (crc >> 1) ^ (if (crc & 1 != 0) poly else 0);
    }
    setX(c, o.rd, @as(u32, crc));
}
fn two(comptime T: type, c: *Cpu, o: *const Op) void {
    if (o.a & 63 >= 16) return crc32(c, o);
    const a: T = @truncate(zr(c, o.rn));
    const m: T = @truncate(zr(c, o.rm));
    const as: bt.Signed(T) = @bitCast(a);
    const ms: bt.Signed(T) = @bitCast(m);
    const v: T = switch (o.a & 63) {
        2 => if (m == 0) 0 else a / m,
        3 => if (m == 0) 0 else if (ms == -1) 0 -% a else @bitCast(@divTrunc(as, ms)),
        else => shift(T, a, o.a - 8, @intCast(m & (@bitSizeOf(T) - 1))),
    };
    setX(c, o.rd, v);
}

fn exclusive(c: *Cpu, o: *const Op, pc: u32) Status {
    const size = o.a;
    const o2 = o.b & 4 != 0;
    const load = o.b & 2 != 0;
    const o1 = o.b & 1 != 0;
    const a = addr(c, c.x[o.rn]) orelse return badAddr(c, pc);
    if (!o1) {
        if (load) {
            if (!o2) c.excl = 1;
            setX(c, o.rd, ldSized(a, size));
        } else {
            if ((o2 or c.excl != 0) and !stSized(c, a, size, zr(c, o.rd))) return badAddr(c, pc);
            if (!o2) {
                setW(c, o.rm, c.excl ^ 1);
                c.excl = 0;
            }
        }
    } else if (!o2 and size >= 2) {
        const step: u32 = if (size == 3) 8 else 4;
        if (load) {
            c.excl = 1;
            setX(c, o.rd, ldSized(a, size));
            setX(c, o.ra, ldSized(a + step, size));
        } else {
            if (c.excl != 0 and (!stSized(c, a, size, zr(c, o.rd)) or !stSized(c, a + step, size, zr(c, o.ra)))) return badAddr(c, pc);
            setW(c, o.rm, c.excl ^ 1);
            c.excl = 0;
        }
    } else if (o2) {
        const v = ldSized(a, size);
        const cmp = zr(c, o.rm) & sizeMask(size);
        if (v == cmp) if (!stSized(c, a, size, zr(c, o.rd))) return badAddr(c, pc);
        setX(c, o.rm, v);
    } else if (size == 1) {
        const v = ld(u64, a);
        const t = ld(u64, a + 8);
        if (v == zr(c, o.rm) and t == zr(c, o.rm + 1)) {
            if (!st(u64, c, a, zr(c, o.rd)) or !st(u64, c, a + 8, zr(c, o.rd + 1))) return badAddr(c, pc);
        }
        setX(c, o.rm, v);
        setX(c, o.rm + 1, t);
    } else {
        const v = ld(u32, a);
        const t = ld(u32, a + 4);
        if (v == @as(u32, @truncate(zr(c, o.rm))) and t == @as(u32, @truncate(zr(c, o.rm + 1)))) {
            if (!st(u32, c, a, @truncate(zr(c, o.rd))) or !st(u32, c, a + 4, @truncate(zr(c, o.rd + 1)))) return badAddr(c, pc);
        }
        setW(c, o.rm, v);
        setW(c, o.rm + 1, t);
    }
    return .next;
}
inline fn sizeMask(size: u8) u64 {
    return bt.ones(@as(u32, 8) << @intCast(size));
}
inline fn ldSized(a: u32, size: u8) u64 {
    return switch (size) {
        0 => ld(u8, a),
        1 => ld(u16, a),
        2 => ld(u32, a),
        else => ld(u64, a),
    };
}
inline fn stSized(c: *Cpu, a: u32, size: u8, v: u64) bool {
    return switch (size) {
        0 => st(u8, c, a, @truncate(v)),
        1 => st(u16, c, a, @truncate(v)),
        2 => st(u32, c, a, @truncate(v)),
        else => st(u64, c, a, v),
    };
}
fn atomic(c: *Cpu, o: *const Op, pc: u32) Status {
    const size = o.a;
    const a = addr(c, c.x[o.rn]) orelse return badAddr(c, pc);
    const v = ldSized(a, size);
    const s = zr(c, o.rm) & sizeMask(size);
    const shl: u6 = @intCast(64 - (@as(u32, 8) << @intCast(size)));
    const sv: i64 = @as(i64, @bitCast(v << shl)) >> shl;
    const ss: i64 = @as(i64, @bitCast(s << shl)) >> shl;
    const t: ?u64 = switch (o.b) {
        0 => v +% s,
        1 => v & ~s,
        2 => v ^ s,
        3 => v | s,
        4 => if (sv > ss) v else s,
        5 => if (sv < ss) v else s,
        6 => if (v > s) v else s,
        7 => if (v < s) v else s,
        8 => s,
        12 => null,
        else => return raise(c, .unimplemented, ld(u32, pc)),
    };
    if (t) |nv| if (!stSized(c, a, size, nv & sizeMask(size))) return badAddr(c, pc);
    setX(c, o.rd, v);
    return .next;
}

fn svc(c: *Cpu) Status {
    switch (@as(u32, @truncate(c.x[8]))) {
        172 => c.x[0] = c.pid,
        178 => c.x[0] = c.os_tid,
        // what the vDSO serves on a device: the clock without a trip to the host
        113 => c.x[0] = if (libc.clockGettime(c) == .done) 0 else @bitCast(@as(i64, -14)),
        // every other number is the host's: it serves the same table as libc's syscall(2)
        else => {
            c.exit = @truncate(c.x[8]);
            return .syscall;
        },
    }
    return .jump;
}

/// the decoded op at `pc`, decoding it and marking its word executed on first use
pub inline fn opAt(page: *cpu.Page, pc: u32) *Op {
    const o = &page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2];
    if (o.kind == .raw) {
        o.* = decode(ld(u32, pc), pc);
        cpu.cover(page, pc, pc);
    }
    return o;
}

pub fn block(c: *Cpu, start: u32, page: *cpu.Page) Status {
    if (start & 3 != 0) return raise(c, .misaligned_pc, start);
    c.bpc = start;
    var pc = start;
    var n: u32 = 0;
    var s: Status = .next;
    while (true) {
        const o = opAt(page, pc);
        n += 1;
        s = exec(c, o, pc);
        if (s != .next) {
            if (s == .fault) c.pc = pc;
            break;
        }
        pc += 4;
        if (n >= cpu.max_block or pc & (abi.PAGE_SIZE - 1) == 0 or mem.page_flags[pc >> abi.PAGE_SHIFT] & 1 == 0) {
            c.pc = pc;
            s = .jump;
            break;
        }
    }
    c.ic += n;
    return s;
}
