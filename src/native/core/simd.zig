const std = @import("std");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const a64 = @import("a64.zig");
const fp = @import("fp.zig");
const Cpu = cpu.Cpu;
const Status = cpu.Status;

const V = [16]u8;
const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
inline fn L(comptime T: type, r: *align(16) V) *align(16) [16 / @sizeOf(T)]T {
    return @ptrCast(r);
}
inline fn get(comptime T: type, c: *Cpu, n: u8, i: usize) T {
    return L(T, &c.v[n])[i];
}
inline fn old(c: *Cpu, d: u8) V {
    return c.v[d];
}
inline fn write(c: *Cpu, d: u8, out: V, q: bool) void {
    c.v[d] = out;
    if (!q) @as(*align(8) u64, @ptrCast(&c.v[d][8])).* = 0;
}
inline fn writeScalar(c: *Cpu, d: u8, comptime T: type, v: T) void {
    var out: V align(16) = @splat(0);
    L(T, &out)[0] = v;
    c.v[d] = out;
}
inline fn fault(c: *Cpu, w: u32) Status {
    return cpu.raise(c, .unimplemented, w);
}
inline fn badAddr(c: *Cpu, w: u32) Status {
    return cpu.raise(c, .bad_address, w);
}
const Unsigned = bt.Unsigned;
const Signed = bt.Signed;
const Wide = bt.Wide;
fn sat(comptime T: type, c: *Cpu, v: anytype) T {
    if (v > std.math.maxInt(T)) {
        c.setQ();
        return std.math.maxInt(T);
    }
    if (v < std.math.minInt(T)) {
        c.setQ();
        return std.math.minInt(T);
    }
    return @intCast(v);
}
const cond = a64.cond;

pub fn vfpImm(imm8: u32, dp: bool) u64 {
    const sign = imm8 >> 7;
    const b6 = (imm8 >> 6) & 1;
    const frac = imm8 & 15;
    const e = (imm8 >> 4) & 3;
    if (dp) {
        const exp: u64 = ((1 - b6) << 10) | (if (b6 != 0) @as(u32, 0x3fc) else 0) | e;
        return (@as(u64, sign) << 63) | (exp << 52) | (@as(u64, frac) << 48);
    }
    const exp: u32 = ((1 - b6) << 7) | (if (b6 != 0) @as(u32, 0x7c) else 0) | e;
    return (sign << 31) | (exp << 23) | (frac << 19);
}

pub inline fn vload(c: *Cpu, t: u8, a: u32, width: usize) void {
    var out: V align(16) = @splat(0);
    @memcpy(out[0..width], mem.bytes(a)[0..width]);
    c.v[t] = out;
}
inline fn vstore(c: *Cpu, t: u8, a: u32, width: usize) bool {
    var i: usize = 0;
    while (i < width) : (i += 8) {
        if (width - i >= 8) {
            if (!cpu.st(u64, c, a + @as(u32, @intCast(i)), @as(*align(1) u64, @ptrCast(&c.v[t][i])).*)) return false;
        } else {
            var j = i;
            while (j < width) : (j += 1) if (!cpu.st(u8, c, a + @as(u32, @intCast(j)), c.v[t][j])) return false;
        }
    }
    return true;
}
inline fn wb(c: *Cpu, rn: u8, rm: u8, imm: u64) void {
    c.x[rn] +%= if (rm == 31) imm else a64.zr(c, rm);
}
pub fn memop(c: *Cpu, w: u32) Status {
    const rt: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    if (is(w, 0xbfbf0000, 0x0c000000) or is(w, 0xbfa00000, 0x0c800000)) {
        const q = bits(w, 30, 1) != 0;
        const Ld = bits(w, 22, 1) != 0;
        const post = bits(w, 23, 1) != 0;
        const opcode = bits(w, 12, 4);
        const size = bits(w, 10, 2);
        const regs: u32 = switch (opcode) {
            0, 2 => 4,
            4, 6 => 3,
            7 => 1,
            8, 10 => 2,
            else => 0,
        };
        const interleaved = opcode == 0 or opcode == 4 or opcode == 8;
        if (regs == 0 or (size == 3 and !q and interleaved)) return fault(c, w);
        const nbytes: u32 = if (q) 16 else 8;
        const es: u32 = @as(u32, 1) << @intCast(size);
        const count = nbytes / es;
        const a = a64.addr(c, c.x[rn]) orelse return badAddr(c, w);
        var k: u32 = 0;
        while (k < regs) : (k += 1) {
            const t: u8 = @intCast((rt + k) & 31);
            if (!interleaved) {
                if (Ld) vload(c, t, a + k * nbytes, nbytes) else if (!vstore(c, t, a + k * nbytes, nbytes)) return badAddr(c, w);
            } else {
                var out: V align(16) = if (Ld) @splat(0) else c.v[t];
                var i: u32 = 0;
                while (i < count) : (i += 1) {
                    const off = a + (i * regs + k) * es;
                    if (Ld) @memcpy(out[i * es ..][0..es], mem.bytes(off)[0..es]) else {
                        var j: u32 = 0;
                        while (j < es) : (j += 1) if (!cpu.st(u8, c, off + j, out[i * es + j])) return badAddr(c, w);
                    }
                }
                if (Ld) c.v[t] = out;
            }
        }
        if (post) wb(c, rn, rm, regs * nbytes);
        return .next;
    }
    if (is(w, 0xbf9f0000, 0x0d000000) or is(w, 0xbf800000, 0x0d800000)) {
        const q = bits(w, 30, 1);
        const Ld = bits(w, 22, 1) != 0;
        const post = bits(w, 23, 1) != 0;
        const R = bits(w, 21, 1);
        const opcode = bits(w, 13, 3);
        const S = bits(w, 12, 1);
        const size = bits(w, 10, 2);
        const regs: u32 = 1 + R + (opcode & 1) * 2;
        const a = a64.addr(c, c.x[rn]) orelse return badAddr(c, w);
        if (opcode >= 6) {
            if (!Ld or S != 0) return fault(c, w);
            const es: u32 = @as(u32, 1) << @intCast(size);
            const count: u32 = (if (q != 0) @as(u32, 16) else 8) / es;
            var k: u32 = 0;
            while (k < regs) : (k += 1) {
                var out: V align(16) = @splat(0);
                var i: u32 = 0;
                while (i < count) : (i += 1) @memcpy(out[i * es ..][0..es], mem.bytes(a + k * es)[0..es]);
                c.v[(rt + k) & 31] = out;
            }
            if (post) wb(c, rn, rm, regs * es);
            return .next;
        }
        const scale = opcode >> 1;
        const es: u32 = if (scale == 0) 1 else if (scale == 1) 2 else if (size & 1 != 0) 8 else 4;
        const idx: u32 = if (es == 1) (q << 3) | (S << 2) | size else if (es == 2) (q << 2) | (S << 1) | (size >> 1) else if (es == 4) (q << 1) | S else q;
        var k: u32 = 0;
        while (k < regs) : (k += 1) {
            const t: u8 = @intCast((rt + k) & 31);
            if (Ld) @memcpy(c.v[t][idx * es ..][0..es], mem.bytes(a + k * es)[0..es]) else {
                var j: u32 = 0;
                while (j < es) : (j += 1) if (!cpu.st(u8, c, a + k * es + j, c.v[t][idx * es + j])) return badAddr(c, w);
            }
        }
        if (post) wb(c, rn, rm, regs * es);
        return .next;
    }
    if (is(w, 0x3a000000, 0x28000000)) {
        const opc = bits(w, 30, 2);
        const Ld = bits(w, 22, 1) != 0;
        const imm7: i64 = bt.sx(i64, bits(w, 15, 7), 7);
        const rt2: u8 = @intCast(bits(w, 10, 5));
        const kind = bits(w, 23, 2);
        if (opc == 3) return fault(c, w);
        const width: u32 = @as(u32, 4) << @intCast(opc);
        const off: u64 = @bitCast(imm7 * width);
        const base = if (kind == 1) c.x[rn] else c.x[rn] +% off;
        const a = a64.addr(c, base) orelse return badAddr(c, w);
        if (kind == 1 or kind == 3) c.x[rn] +%= off;
        if (Ld) {
            vload(c, rt, a, width);
            vload(c, rt2, a + width, width);
        } else if (!vstore(c, rt, a, width) or !vstore(c, rt2, a + width, width)) return badAddr(c, w);
        return .next;
    }
    const size = bits(w, 30, 2);
    const opc = bits(w, 22, 2);
    const Ld = opc & 1 != 0;
    if (opc & 2 != 0 and size != 0) return fault(c, w);
    const scale: u5 = @intCast(if (opc & 2 != 0) 4 else size);
    const width: u32 = @as(u32, 1) << scale;
    var base = c.x[rn];
    var post: u64 = 0;
    var pre = false;
    if (is(w, 0x3b000000, 0x39000000)) {
        base +%= bits(w, 10, 12) << scale;
    } else if (is(w, 0x3b200c00, 0x38200800)) {
        const option = bits(w, 13, 3);
        const S = bits(w, 12, 1);
        const idx = bt.extend(a64.zr(c, rm), option);
        base +%= if (S != 0) idx << scale else idx;
    } else {
        const imm9: u64 = @bitCast(bt.sx(i64, bits(w, 12, 9), 9));
        const kind = bits(w, 10, 2);
        if (kind == 2) return fault(c, w);
        if (kind == 1) post = imm9 else base +%= imm9;
        pre = kind == 3;
    }
    const a = a64.addr(c, base) orelse return badAddr(c, w);
    if (pre) c.x[rn] = base;
    if (post != 0) c.x[rn] = base +% post;
    if (Ld) vload(c, rt, a, width) else if (!vstore(c, rt, a, width)) return badAddr(c, w);
    return .next;
}

pub const ImmKind = enum { movi, mvni, orr, bic, fmov };
pub fn expandImm(o: u32, cmode: u32, o2: u32, imm8: u32) ?struct { v: u64, kind: ImmKind } {
    const group = cmode >> 1;
    const logical: ImmKind = if (cmode & 1 != 0) (if (o != 0) .bic else .orr) else (if (o != 0) .mvni else .movi);
    if (group <= 3) {
        const v: u64 = @as(u64, imm8) << @intCast(8 * group);
        return .{ .v = v | (v << 32), .kind = logical };
    }
    if (group <= 5) {
        const v: u64 = @as(u64, imm8) << @intCast(8 * (group - 4));
        const rep = v | (v << 16);
        return .{ .v = rep | (rep << 32), .kind = logical };
    }
    const nonlog: ImmKind = if (o != 0) .mvni else .movi;
    if (cmode == 12) {
        const v: u64 = (imm8 << 8) | 0xff;
        return .{ .v = v | (v << 32), .kind = nonlog };
    }
    if (cmode == 13) {
        const v: u64 = (imm8 << 16) | 0xffff;
        return .{ .v = v | (v << 32), .kind = nonlog };
    }
    if (cmode == 14) {
        if (o == 0) {
            const v: u64 = imm8 * 0x01010101;
            return .{ .v = v | (v << 32), .kind = .movi };
        }
        var v: u64 = 0;
        var i: u6 = 0;
        while (i < 8) : (i += 1) if ((imm8 >> @intCast(i)) & 1 != 0) {
            v |= @as(u64, 0xff) << (8 * i);
        };
        return .{ .v = v, .kind = .movi };
    }
    if (o2 != 0) return null;
    if (o == 0) {
        const v = vfpImm(imm8, false);
        return .{ .v = v | (v << 32), .kind = .fmov };
    }
    return .{ .v = vfpImm(imm8, true), .kind = .fmov };
}

pub fn exec(c: *Cpu, w: u32) Status {
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const q = bits(w, 30, 1) != 0;

    if (is(w, 0x9ff80400, 0x0f000400)) {
        const o = bits(w, 29, 1);
        const cmode = bits(w, 12, 4);
        const e = expandImm(o, cmode, bits(w, 11, 1), (bits(w, 16, 3) << 5) | bits(w, 5, 5)) orelse return fault(c, w);
        if (e.kind == .fmov and o != 0 and !q) return fault(c, w);
        var out: V align(16) = old(c, rd);
        const D = L(u64, &out);
        for (0..2) |i| D[i] = switch (e.kind) {
            .orr => D[i] | e.v,
            .bic => D[i] & ~e.v,
            .mvni => ~e.v,
            else => e.v,
        };
        write(c, rd, out, q);
        return .next;
    }
    if (is(w, 0x9fe08400, 0x0e000400) or is(w, 0xdfe08400, 0x5e000400)) {
        const scalar = w & 0x10000000 != 0;
        const o = bits(w, 29, 1);
        const imm5 = bits(w, 16, 5);
        const imm4 = bits(w, 11, 4);
        if (imm5 & 15 == 0) return fault(c, w);
        const esz: u5 = @intCast(@ctz(imm5));
        const es: u32 = @as(u32, 1) << esz;
        const idx = imm5 >> (esz + 1);
        if (scalar) {
            if (o != 0 or imm4 != 0) return fault(c, w);
            var out: V align(16) = @splat(0);
            @memcpy(out[0..es], c.v[rn][idx * es ..][0..es]);
            c.v[rd] = out;
            return .next;
        }
        if (o != 0) {
            @memcpy(c.v[rd][idx * es ..][0..es], c.v[rn][(imm4 >> esz) * es ..][0..es]);
            return .next;
        }
        const count: u32 = (if (q) @as(u32, 16) else 8) / es;
        switch (imm4) {
            0, 1 => {
                var out: V align(16) = @splat(0);
                var src: [8]u8 = undefined;
                if (imm4 == 0) @memcpy(src[0..es], c.v[rn][idx * es ..][0..es]) else @as(*align(1) u64, @ptrCast(&src)).* = a64.zr(c, rn);
                for (0..count) |i| @memcpy(out[i * es ..][0..es], src[0..es]);
                write(c, rd, out, q);
            },
            3 => {
                var src: [8]u8 = undefined;
                @as(*align(1) u64, @ptrCast(&src)).* = a64.zr(c, rn);
                @memcpy(c.v[rd][idx * es ..][0..es], src[0..es]);
            },
            5 => {
                if (esz == 3 or (esz == 2 and !q)) return fault(c, w);
                const v: i64 = switch (esz) {
                    0 => get(i8, c, rn, idx),
                    1 => get(i16, c, rn, idx),
                    else => get(i32, c, rn, idx),
                };
                if (q) a64.setX(c, rd, @bitCast(v)) else a64.setW(c, rd, @bitCast(@as(i32, @truncate(v))));
            },
            7 => {
                if (esz == 3) {
                    if (!q) return fault(c, w);
                    a64.setX(c, rd, get(u64, c, rn, idx));
                } else {
                    if (q) return fault(c, w);
                    a64.setW(c, rd, switch (esz) {
                        0 => get(u8, c, rn, idx),
                        1 => get(u16, c, rn, idx),
                        else => get(u32, c, rn, idx),
                    });
                }
            },
            else => return fault(c, w),
        }
        return .next;
    }
    if (is(w, 0xbfe08400, 0x2e000000)) {
        const imm = bits(w, 11, 4);
        if (!q and imm > 7) return fault(c, w);
        const nbytes: usize = if (q) 16 else 8;
        var cat: [32]u8 = undefined;
        @memcpy(cat[0..nbytes], c.v[rn][0..nbytes]);
        @memcpy(cat[nbytes .. 2 * nbytes], c.v[rm][0..nbytes]);
        var out: V align(16) = @splat(0);
        @memcpy(out[0..nbytes], cat[imm .. imm + nbytes]);
        write(c, rd, out, q);
        return .next;
    }
    if (is(w, 0xbfe08c00, 0x0e000000)) {
        const len = bits(w, 13, 2) + 1;
        const tbx = bits(w, 12, 1) != 0;
        const nbytes: usize = if (q) 16 else 8;
        if (rn + len > 32) return fault(c, w);
        var out: V align(16) = c.v[rd];
        const table: [*]const u8 = @ptrCast(&c.v[rn]);
        tableLookup(table[0 .. 16 * len], c.v[rm][0..nbytes], out[0..nbytes], tbx);
        write(c, rd, out, q);
        return .next;
    }
    if (is(w, 0xbf208c00, 0x0e000800)) {
        const size = bits(w, 22, 2);
        const opcode = bits(w, 12, 3);
        if (opcode == 0 or opcode == 4 or (size == 3 and !q)) return fault(c, w);
        return switch (size) {
            inline 0...3 => |sz| permute(std.meta.Int(.unsigned, 8 << sz), c, rd, rn, rm, q, opcode),
            else => unreachable,
        };
    }
    if (is(w, 0x9f20fc00, 0x0e201c00)) {
        const U = bits(w, 29, 1) != 0;
        const size = bits(w, 22, 2);
        var out: V align(16) = undefined;
        const D = L(u64, &out);
        for (0..2) |i| {
            const n = get(u64, c, rn, i);
            const m = get(u64, c, rm, i);
            const d = get(u64, c, rd, i);
            D[i] = if (!U) switch (size) {
                0 => n & m,
                1 => n & ~m,
                2 => n | m,
                else => n | ~m,
            } else switch (size) {
                0 => n ^ m,
                1 => (d & n) | (~d & m),
                2 => (d & ~m) | (n & m),
                else => (d & m) | (n & ~m),
            };
        }
        write(c, rd, out, q);
        return .next;
    }
    if (is(w, 0xbffffc00, 0x2e205800)) {
        var out: V align(16) = undefined;
        for (0..2) |i| L(u64, &out)[i] = ~get(u64, c, rn, i);
        write(c, rd, out, q);
        return .next;
    }
    if (vector(c, w)) |st| return st;
    if ((w & 0x50000000) == 0x10000000) return scalarFp(c, w);
    return fault(c, w);
}

pub fn tableLookup(table: []const u8, indices: []const u8, out: []u8, extend: bool) void {
    for (indices, out) |index, *value| {
        if (index < table.len) value.* = table[index] else if (!extend) value.* = 0;
    }
}

pub const Lane = struct { m: bool, i: usize };
pub fn permuteIndex(opcode: u32, count: usize, e: usize) Lane {
    const half = count / 2;
    return switch (opcode) {
        1 => if (e < half) .{ .m = false, .i = 2 * e } else .{ .m = true, .i = 2 * (e - half) },
        5 => if (e < half) .{ .m = false, .i = 2 * e + 1 } else .{ .m = true, .i = 2 * (e - half) + 1 },
        2 => if (e & 1 != 0) .{ .m = true, .i = e - 1 } else .{ .m = false, .i = e },
        6 => if (e & 1 != 0) .{ .m = true, .i = e } else .{ .m = false, .i = e + 1 },
        3 => .{ .m = e & 1 != 0, .i = e >> 1 },
        else => .{ .m = e & 1 != 0, .i = half + (e >> 1) },
    };
}
fn permute(comptime T: type, c: *Cpu, rd: u8, rn: u8, rm: u8, q: bool, opcode: u32) Status {
    const count: usize = (if (q) @as(usize, 16) else 8) / @sizeOf(T);
    var out: V align(16) = @splat(0);
    for (0..count) |e| {
        const s = permuteIndex(opcode, count, e);
        L(T, &out)[e] = get(T, c, if (s.m) rm else rn, s.i);
    }
    write(c, rd, out, q);
    return .next;
}

const Ctx = struct {
    c: *Cpu,
    w: u32,
    rd: u8,
    rn: u8,
    rm: u8,
    q: bool,
    scalar: bool,
    U: bool,
    size: u32,
    fv: bool,
    fn finish(x: Ctx, comptime T: type, out: V) void {
        if (x.scalar) writeScalar(x.c, x.rd, T, std.mem.bytesToValue(T, out[0..@sizeOf(T)])) else write(x.c, x.rd, out, x.q);
    }
};

fn vector(c: *Cpu, w: u32) ?Status {
    const x = Ctx{
        .c = c,
        .w = w,
        .rd = @intCast(w & 31),
        .rn = @intCast(bits(w, 5, 5)),
        .rm = @intCast(bits(w, 16, 5)),
        .scalar = (w & 0x10000000) != 0 and (w & 0x40000000) != 0,
        .q = (w & 0x10000000) == 0 and bits(w, 30, 1) != 0,
        .U = bits(w, 29, 1) != 0,
        .size = bits(w, 22, 2),
        .fv = bits(w, 23, 1) != 0,
    };
    const vecOrScalar = (w & 0x10000000) == 0 or (w & 0x40000000) != 0;
    if (is(w, 0x8f200400, 0x0e200400) and vecOrScalar) return threeSame(x);
    if (is(w, 0x8f3e0c00, 0x0e200800) and vecOrScalar) return twoMisc(x);
    if (is(w, 0x8f3e0c00, 0x0e300800) and vecOrScalar) return across(x);
    if ((is(w, 0x9f800400, 0x0f000400) or is(w, 0xdf800400, 0x5f000400)) and bits(w, 19, 4) != 0) return shiftImm(x);
    if (is(w, 0x9f000400, 0x0f000000) or is(w, 0xdf000400, 0x5f000000)) return byElement(x);
    if (is(w, 0x9f20fc00, 0x0e009400)) return dot(x, x.rm, 0);
    if (is(w, 0x9f200c00, 0x0e200000) and (w & 0x10000000) == 0) return threeDifferent(x);
    return null;
}

inline fn bySize(comptime f: anytype, x: Ctx, size: u32, signed: bool) Status {
    return switch (size) {
        0 => if (signed) f(i8, x) else f(u8, x),
        1 => if (signed) f(i16, x) else f(u16, x),
        2 => if (signed) f(i32, x) else f(u32, x),
        else => if (signed) f(i64, x) else f(u64, x),
    };
}
inline fn byFloat(comptime f: anytype, x: Ctx) Status {
    return if (x.size & 1 != 0) f(f64, x) else f(f32, x);
}
inline fn laneCount(x: Ctx, comptime T: type) usize {
    return if (x.scalar) 1 else (if (x.q) @as(usize, 16) else 8) / @sizeOf(T);
}
inline fn pair(comptime T: type, x: Ctx, i: usize) [2]T {
    const count = laneCount(x, T);
    const half = @max(count / 2, 1);
    return if (i < half) .{ get(T, x.c, x.rn, 2 * i), get(T, x.c, x.rn, 2 * i + 1) } else .{ get(T, x.c, x.rm, 2 * i - count), get(T, x.c, x.rm, 2 * i + 1 - count) };
}
inline fn absDiff(comptime T: type, n: T, m: T) T {
    const W = std.meta.Int(.signed, @bitSizeOf(T) * 2);
    return @bitCast(@as(Unsigned(T), @truncate(@abs(@as(W, n) - @as(W, m)))));
}

fn threeSame(x: Ctx) Status {
    const opcode = bits(x.w, 11, 5);
    if (opcode >= 24) return byFloat(threeSameF, x);
    if (opcode == 3) return fault(x.c, x.w);
    return bySize(threeSameI, x, x.size, !x.U);
}
fn threeSameF(comptime F: type, x: Ctx) Status {
    const c = x.c;
    const opcode = bits(x.w, 11, 5);
    const count = laneCount(x, F);
    var out: V align(16) = old(c, x.rd);
    const O = L(F, &out);
    const U = Unsigned(F);
    const OU = L(U, &out);
    for (0..count) |i| {
        const n = get(F, c, x.rn, i);
        const m = get(F, c, x.rm, i);
        const d = get(F, c, x.rd, i);
        const mask: U = std.math.maxInt(U);
        switch (opcode) {
            24 => O[i] = if (!x.U) fp.fnm(F, n, m, !x.fv) else blk: {
                const p = pair(F, x, i);
                break :blk fp.fnm(F, p[0], p[1], !x.fv);
            },
            25 => {
                if (x.U) return fault(c, x.w);
                O[i] = fp.fma(F, if (x.fv) -n else n, m, d);
            },
            26 => O[i] = if (!x.U) (if (x.fv) n - m else n + m) else if (x.fv) @abs(n - m) else blk: {
                const p = pair(F, x, i);
                break :blk p[0] + p[1];
            },
            27 => O[i] = if (x.U) n * m else fp.fmulx(F, n, m),
            28 => OU[i] = if (if (!x.U) n == m else if (x.fv) n > m else n >= m) mask else 0,
            29 => {
                if (!x.U) return fault(c, x.w);
                OU[i] = if (if (x.fv) @abs(n) > @abs(m) else @abs(n) >= @abs(m)) mask else 0;
            },
            30 => O[i] = if (!x.U) (if (x.fv) fp.fmin(F, n, m) else fp.fmax(F, n, m)) else blk: {
                const p = pair(F, x, i);
                break :blk if (x.fv) fp.fmin(F, p[0], p[1]) else fp.fmax(F, p[0], p[1]);
            },
            else => O[i] = if (x.U) n / m else if (x.fv) fp.fma(F, -n, m, 3) / 2 else fp.fma(F, -n, m, 2),
        }
    }
    x.finish(F, out);
    return .next;
}
inline fn shiftLeftSat(comptime T: type, v: T, s: u32) T {
    return if (s >= @bitSizeOf(T)) 0 else v << @intCast(s);
}
inline fn saturatingShiftLeft(comptime T: type, c: *Cpu, v: T, s: u32) T {
    if (s >= @bitSizeOf(T)) {
        if (v == 0) return 0;
        c.setQ();
        return if (@typeInfo(T).int.signedness == .signed)
            (if (v < 0) std.math.minInt(T) else std.math.maxInt(T))
        else
            std.math.maxInt(T);
    }
    const W = std.meta.Int(.signed, if (@bitSizeOf(T) == 64) 128 else 64);
    return sat(T, c, @as(W, v) << @intCast(s));
}
fn threeSameI(comptime T: type, x: Ctx) Status {
    const c = x.c;
    const opcode = bits(x.w, 11, 5);
    const count = laneCount(x, T);
    const W = std.meta.Int(.signed, if (@bitSizeOf(T) == 64) 128 else 64);
    const bitsT = @bitSizeOf(T);
    var out: V align(16) = old(c, x.rd);
    const O = L(T, &out);
    const S = Signed(T);
    const Un = Unsigned(T);
    const OS = L(S, &out);
    for (0..count) |i| {
        const n = get(T, c, x.rn, i);
        const m = get(T, c, x.rm, i);
        const d = get(T, c, x.rd, i);
        const wn: W = n;
        const wm: W = m;
        switch (opcode) {
            0 => O[i] = @intCast(@divFloor(wn + wm, 2)),
            1 => O[i] = sat(T, c, wn + wm),
            2 => O[i] = @intCast(@divFloor(wn + wm + 1, 2)),
            4 => O[i] = @bitCast(@as(Un, @truncate(@as(Unsigned(W), @bitCast(@divFloor(wn - wm, 2)))))),
            5 => O[i] = sat(T, c, wn - wm),
            6 => OS[i] = if (n > m) -1 else 0,
            7 => OS[i] = if (n >= m) -1 else 0,
            8, 9, 10, 11 => {
                const s: i32 = get(i8, c, x.rm, i * @sizeOf(T));
                if (s >= 0) O[i] = if (opcode & 1 != 0) saturatingShiftLeft(T, c, n, @intCast(s)) else shiftLeftSat(T, n, @intCast(s)) else {
                    const r: u32 = @intCast(-s);
                    if (opcode >= 10) {
                        if (r > bitsT) O[i] = 0 else {
                            const rounded: W = wn + (@as(W, 1) << @intCast(r - 1));
                            O[i] = @intCast(rounded >> @intCast(r));
                        }
                    } else if (r >= bitsT) O[i] = if (@typeInfo(T).int.signedness == .signed) (n >> (bitsT - 1)) else 0 else O[i] = n >> @intCast(r);
                }
            },
            12 => O[i] = @max(n, m),
            13 => O[i] = @min(n, m),
            14 => O[i] = absDiff(T, n, m),
            15 => O[i] = d +% absDiff(T, n, m),
            16 => O[i] = if (x.U) n -% m else n +% m,
            17 => OS[i] = if (if (x.U) n == m else (n & m) != 0) -1 else 0,
            18 => O[i] = if (x.U) d -% (n *% m) else d +% (n *% m),
            19 => O[i] = if (x.U) (if (T == u8) @truncate(fp.pmul8(@bitCast(n), @bitCast(m))) else return fault(c, x.w)) else n *% m,
            20, 21 => {
                const p = pair(T, x, i);
                O[i] = if (opcode == 20) @max(p[0], p[1]) else @min(p[0], p[1]);
            },
            22 => {
                if (bitsT == 8) return fault(c, x.w);
                const round: W = if (x.U) @as(W, 1) << (bitsT - 1) else 0;
                const ws: W = @as(S, @bitCast(n));
                const ms: W = @as(S, @bitCast(m));
                O[i] = @bitCast(sat(S, c, (2 * ws * ms + round) >> bitsT));
            },
            23 => {
                if (x.U) return fault(c, x.w);
                const p = pair(T, x, i);
                O[i] = p[0] +% p[1];
            },
            else => return fault(c, x.w),
        }
    }
    x.finish(T, out);
    return .next;
}

fn twoMisc(x: Ctx) Status {
    const opcode = bits(x.w, 12, 5);
    if (opcode >= 22 or (opcode >= 12 and opcode <= 15 and x.fv)) return byFloat(twoMiscF, x);
    return bySize(twoMiscI, x, x.size, !x.U);
}
inline fn roundMode(comptime F: type, c: *Cpu, v: F, mode: u8) F {
    return switch (mode) {
        'N' => fp.rne(F, v),
        'P' => @ceil(v),
        'M' => @floor(v),
        'Z' => @trunc(v),
        'A' => @round(v),
        else => fp.rint(F, c.fpcr, v),
    };
}
fn twoMiscF(comptime F: type, x: Ctx) Status {
    const c = x.c;
    const opcode = bits(x.w, 12, 5);
    const count = laneCount(x, F);
    const U = Unsigned(F);
    const I = Signed(F);
    var out: V align(16) = old(c, x.rd);
    const O = L(F, &out);
    const OU = L(U, &out);
    const OI = L(I, &out);
    const mask: U = std.math.maxInt(U);
    switch (opcode) {
        22 => {
            if (x.U or x.fv) return fault(c, x.w);
            var narrow: [8]u8 align(8) = undefined;
            if (F == f64) {
                for (0..2) |i| @as(*align(4) [2]f32, @ptrCast(&narrow))[i] = @floatCast(get(f64, c, x.rn, i));
            } else {
                for (0..4) |i| @as(*align(2) [4]u16, @ptrCast(&narrow))[i] = fp.f2hb(f32, get(u32, c, x.rn, i));
            }
            return narrowed(x, narrow, if (F == f64) 4 else 2);
        },
        23 => {
            const off: usize = if (x.q) (if (F == f64) 2 else 4) else 0;
            if (F == f64) {
                for (0..2) |i| O[i] = get(f32, c, x.rn, off + i);
            } else {
                for (0..4) |i| O[i] = @floatCast(fp.h2f(get(u16, c, x.rn, off + i)));
            }
            write(c, x.rd, out, true);
            return .next;
        },
        else => {},
    }
    for (0..count) |i| {
        const n = get(F, c, x.rn, i);
        switch (opcode) {
            24 => O[i] = roundMode(F, c, n, if (x.U) (if (x.fv) 'X' else 'A') else if (x.fv) 'P' else 'N'),
            25 => O[i] = roundMode(F, c, n, if (x.U) 'X' else if (x.fv) 'Z' else 'M'),
            26, 27, 28 => {
                if (opcode == 28 and x.fv) return fault(c, x.w);
                const mode: u8 = if (opcode == 26) (if (x.fv) 'P' else 'N') else if (opcode == 27) (if (x.fv) 'Z' else 'M') else 'A';
                const r = roundMode(F, c, n, mode);
                if (x.U) OU[i] = fp.toInt(U, r) else OI[i] = fp.toInt(I, r);
            },
            29 => O[i] = if (!x.fv) (if (x.U) @floatFromInt(get(U, c, x.rn, i)) else @floatFromInt(get(I, c, x.rn, i))) else if (x.U) fp.rsqrte(F, n) else fp.recpe(F, n),
            31 => {
                if (x.U) O[i] = @sqrt(n) else if (x.scalar) O[i] = fp.recpx(F, n) else return fault(c, x.w);
            },
            12 => OU[i] = if (if (x.U) n >= 0 else n > 0) mask else 0,
            13 => OU[i] = if (if (x.U) n <= 0 else n == 0) mask else 0,
            14 => OU[i] = if (n < 0) mask else 0,
            15 => OU[i] = if (x.U) get(U, c, x.rn, i) ^ (@as(U, 1) << (@bitSizeOf(F) - 1)) else get(U, c, x.rn, i) & (mask >> 1),
            else => return fault(c, x.w),
        }
    }
    x.finish(F, out);
    return .next;
}
inline fn LN(comptime T: type, r: *align(8) [8]u8) *align(8) [8 / @sizeOf(T)]T {
    return @ptrCast(r);
}
fn xtn(comptime Src: type, comptime N: type, x: Ctx, comptime saturate: bool) Status {
    var narrow: [8]u8 align(8) = undefined;
    for (0..(if (x.scalar) 1 else 8 / @sizeOf(N))) |i| {
        const v = get(Src, x.c, x.rn, i);
        LN(N, &narrow)[i] = if (saturate) sat(N, x.c, v) else @bitCast(@as(Unsigned(N), @truncate(@as(Unsigned(Src), @bitCast(v)))));
    }
    return narrowed(x, narrow, @sizeOf(N));
}
fn shrn(comptime N: type, x: Ctx, shr: u32, comptime round: bool, comptime plain: bool, comptime srcSigned: bool) Status {
    const WS = std.meta.Int(.signed, @bitSizeOf(N) * 2);
    const WU = std.meta.Int(.unsigned, @bitSizeOf(N) * 2);
    const R = std.meta.Int(.signed, @bitSizeOf(N) * 4);
    var narrow: [8]u8 align(8) = undefined;
    for (0..(if (x.scalar) 1 else 8 / @sizeOf(N))) |i| {
        const raw = get(WU, x.c, x.rn, i);
        const v: R = if (srcSigned and !plain) @as(WS, @bitCast(raw)) else raw;
        const shifted: R = if (round) (v + (@as(R, 1) << @intCast(shr - 1))) >> @intCast(shr) else v >> @intCast(shr);
        LN(N, &narrow)[i] = if (plain) @bitCast(@as(Unsigned(N), @truncate(@as(Unsigned(R), @bitCast(shifted))))) else sat(N, x.c, shifted);
    }
    return narrowed(x, narrow, @sizeOf(N));
}
fn narrowed(x: Ctx, narrow: [8]u8, es: usize) Status {
    const c = x.c;
    if (x.scalar) {
        var o: V align(16) = @splat(0);
        @memcpy(o[0..es], narrow[0..es]);
        c.v[x.rd] = o;
        return .next;
    }
    if (x.q) {
        @memcpy(c.v[x.rd][8..16], &narrow);
    } else {
        var o: V align(16) = @splat(0);
        @memcpy(o[0..8], &narrow);
        c.v[x.rd] = o;
    }
    return .next;
}
fn twoMiscI(comptime T: type, x: Ctx) Status {
    const c = x.c;
    const opcode = bits(x.w, 12, 5);
    const count = laneCount(x, T);
    const bitsT = @bitSizeOf(T);
    const S = Signed(T);
    const Un = Unsigned(T);
    const W = Wide(T);
    var out: V align(16) = old(c, x.rd);
    const O = L(T, &out);
    const OS = L(S, &out);
    switch (opcode) {
        0, 1 => {
            const group: usize = if (opcode == 1) 2 else if (x.U) 4 else 8;
            if (@sizeOf(T) >= group) return fault(c, x.w);
            const per = group / @sizeOf(T);
            for (0..count) |i| O[i] = get(T, c, x.rn, (i - (i % per)) + (per - 1 - (i % per)));
            x.finish(T, out);
            return .next;
        },
        2, 6 => {
            if (bitsT == 64) return fault(c, x.w);
            const OW = L(W, &out);
            for (0..count / 2) |i| {
                const s: W = @as(W, get(T, c, x.rn, 2 * i)) + @as(W, get(T, c, x.rn, 2 * i + 1));
                OW[i] = if (opcode == 6) get(W, c, x.rd, i) +% s else s;
            }
            x.finish(T, out);
            return .next;
        },
        18, 20 => {
            if (bitsT == 64) return fault(c, x.w);
            if (opcode == 18 and !x.U) return xtn(Unsigned(W), Unsigned(T), x, false);
            if (opcode == 18) return xtn(Signed(W), Unsigned(T), x, true);
            if (!x.U) return xtn(Signed(W), Signed(T), x, true);
            return xtn(Unsigned(W), Unsigned(T), x, true);
        },
        19 => {
            if (!x.U or bitsT == 64) return fault(c, x.w);
            const half = 8 / @sizeOf(T);
            const off: usize = if (x.q) half else 0;
            const OW = L(Unsigned(W), &out);
            for (0..half) |i| OW[i] = @as(Unsigned(W), get(Un, c, x.rn, off + i)) << bitsT;
            write(c, x.rd, out, true);
            return .next;
        },
        else => {},
    }
    for (0..count) |i| {
        const n = get(T, c, x.rn, i);
        const ns: S = @bitCast(n);
        switch (opcode) {
            4 => O[i] = if (x.U) @clz(n) else @intCast(@clz(ns ^ (ns >> (bitsT - 1))) - 1),
            5 => {
                if (x.U and bitsT == 16) {
                    for (0..count * 2) |j| L(u8, &out)[j] = @bitReverse(get(u8, c, x.rn, j));
                    break;
                }
                if (!x.U and bitsT == 8) O[i] = @popCount(@as(Un, @bitCast(n))) else return fault(c, x.w);
            },
            7 => O[i] = @bitCast(sat(S, c, if (x.U) -@as(Wide(S), ns) else @as(Wide(S), if (ns < 0) -@as(Wide(S), ns) else ns))),
            8 => OS[i] = if (if (x.U) ns >= 0 else ns > 0) -1 else 0,
            9 => OS[i] = if (if (x.U) ns <= 0 else ns == 0) -1 else 0,
            10 => {
                if (x.U) return fault(c, x.w);
                OS[i] = if (ns < 0) -1 else 0;
            },
            11 => OS[i] = if (x.U) 0 -% ns else if (ns < 0) 0 -% ns else ns,
            else => return fault(c, x.w),
        }
    }
    x.finish(T, out);
    return .next;
}

fn across(x: Ctx) Status {
    const c = x.c;
    const opcode = bits(x.w, 12, 5);
    if (x.scalar) {
        if (!x.U and opcode == 27) {
            writeScalar(c, x.rd, u64, get(u64, c, x.rn, 0) +% get(u64, c, x.rn, 1));
            return .next;
        }
        if (!x.U) return fault(c, x.w);
        return byFloat(pairwiseF, x);
    }
    if (x.U and (opcode == 12 or opcode == 15)) {
        if (x.size & 1 != 0 or !x.q) return fault(c, x.w);
        var a = get(f32, c, x.rn, 0);
        for (1..4) |i| a = if (opcode == 15) (if (x.fv) fp.fmin(f32, a, get(f32, c, x.rn, i)) else fp.fmax(f32, a, get(f32, c, x.rn, i))) else fp.fnm(f32, a, get(f32, c, x.rn, i), !x.fv);
        writeScalar(c, x.rd, f32, a);
        return .next;
    }
    if (x.size == 3) return fault(c, x.w);
    return bySize(acrossI, x, x.size, !x.U);
}
fn pairwiseF(comptime F: type, x: Ctx) Status {
    const c = x.c;
    const opcode = bits(x.w, 12, 5);
    const a = get(F, c, x.rn, 0);
    const b = get(F, c, x.rn, 1);
    const r: F = switch (opcode) {
        12 => fp.fnm(F, a, b, !x.fv),
        13 => a + b,
        15 => if (x.fv) fp.fmin(F, a, b) else fp.fmax(F, a, b),
        else => return fault(c, x.w),
    };
    writeScalar(c, x.rd, F, r);
    return .next;
}
fn acrossI(comptime T: type, x: Ctx) Status {
    const c = x.c;
    const opcode = bits(x.w, 12, 5);
    const count: usize = (if (bits(x.w, 30, 1) != 0) @as(usize, 16) else 8) / @sizeOf(T);
    const W = Wide(T);
    var acc: W = get(T, c, x.rn, 0);
    for (1..count) |i| {
        const v: W = get(T, c, x.rn, i);
        acc = switch (opcode) {
            3, 27 => acc + v,
            10 => @max(acc, v),
            26 => @min(acc, v),
            else => return fault(c, x.w),
        };
    }
    if (opcode == 3) writeScalar(c, x.rd, Unsigned(W), @bitCast(acc)) else writeScalar(c, x.rd, Unsigned(T), @truncate(@as(Unsigned(W), @bitCast(acc))));
    return .next;
}

fn shiftImm(x: Ctx) Status {
    const immh = bits(x.w, 19, 4);
    const esz: u32 = if (immh & 8 != 0) 3 else if (immh & 4 != 0) 2 else if (immh & 2 != 0) 1 else 0;
    return bySize(shiftImmT, x, esz, !x.U);
}
fn shiftImmT(comptime T: type, x: Ctx) Status {
    const c = x.c;
    const immh = bits(x.w, 19, 4);
    const immb = bits(x.w, 16, 3);
    const opcode = bits(x.w, 11, 5);
    const bitsT = @bitSizeOf(T);
    const shr: u32 = 2 * bitsT - ((immh << 3) | immb);
    const shl: u32 = ((immh << 3) | immb) - bitsT;
    const count = laneCount(x, T);
    const S = Signed(T);
    const Un = Unsigned(T);
    const W = Wide(T);
    var out: V align(16) = old(c, x.rd);
    const O = L(T, &out);
    const OU = L(Un, &out);
    switch (opcode) {
        inline 16, 17, 18, 19 => |op| {
            if (bitsT == 64) return fault(c, x.w);
            const round = op & 1 != 0;
            if (op <= 17) return if (x.U) shrn(Un, x, shr, round, false, true) else shrn(Un, x, shr, round, true, true);
            return if (x.U) shrn(Un, x, shr, round, false, false) else shrn(S, x, shr, round, false, true);
        },
        20 => {
            if (bitsT == 64) return fault(c, x.w);
            const half = 8 / @sizeOf(T);
            const off: usize = if (x.q) half else 0;
            const OW = L(W, &out);
            for (0..half) |i| OW[i] = @as(W, get(T, c, x.rn, off + i)) << @intCast(shl);
            write(c, x.rd, out, true);
            return .next;
        },
        else => {},
    }
    for (0..count) |i| {
        const n = get(T, c, x.rn, i);
        const d = get(T, c, x.rd, i);
        const nu: Un = @bitCast(n);
        const du: Un = @bitCast(d);
        switch (opcode) {
            0, 2 => {
                const rs: T = if (shr >= bitsT) (if (@typeInfo(T).int.signedness == .signed) n >> (bitsT - 1) else 0) else n >> @intCast(shr);
                O[i] = if (opcode == 0) rs else d +% rs;
            },
            4, 6 => {
                const rounded: T = @intCast((@as(W, n) + (@as(W, 1) << @intCast(shr - 1))) >> @intCast(shr));
                O[i] = if (opcode == 4) rounded else d +% rounded;
            },
            8 => {
                if (!x.U) return fault(c, x.w);
                OU[i] = if (shr >= bitsT) du else (du & ~(@as(Un, std.math.maxInt(Un)) >> @intCast(shr))) | (nu >> @intCast(shr));
            },
            10 => {
                if (!x.U) O[i] = n << @intCast(shl) else OU[i] = (du & ((@as(Un, 1) << @intCast(shl)) - 1)) | (nu << @intCast(shl));
            },
            12 => {
                if (!x.U) return fault(c, x.w);
                OU[i] = sat(Un, c, @as(Wide(S), @as(S, @bitCast(n))) << @intCast(shl));
            },
            14 => O[i] = sat(T, c, @as(W, n) << @intCast(shl)),
            28 => {
                const F = if (bitsT == 64) f64 else f32;
                L(F, &out)[i] = std.math.ldexp(@as(F, @floatFromInt(n)), -@as(i32, @intCast(shr)));
            },
            31 => {
                const F = if (bitsT == 64) f64 else f32;
                const t = @trunc(std.math.ldexp(get(F, c, x.rn, i), @intCast(shr)));
                O[i] = fp.toInt(T, t);
            },
            else => return fault(c, x.w),
        }
    }
    x.finish(T, out);
    return .next;
}

fn byElement(x: Ctx) Status {
    const c = x.c;
    const w = x.w;
    const Lb = bits(w, 21, 1);
    const M = bits(w, 20, 1);
    const H = bits(w, 11, 1);
    const opcode = bits(w, 12, 4);
    const rmLow = bits(w, 16, 4);
    if (opcode == 1 or opcode == 5 or opcode == 9) {
        if (x.size & 2 == 0) return fault(c, w);
        const dp = x.size & 1 != 0;
        if (dp and Lb != 0) return fault(c, w);
        const idx: usize = if (dp) H else (H << 1) | Lb;
        const m: u8 = @intCast((M << 4) | rmLow);
        return if (dp) byElementF(f64, x, m, idx) else byElementF(f32, x, m, idx);
    }
    if (x.scalar or (x.size != 1 and x.size != 2)) return fault(c, w);
    const idx: usize = if (x.size == 1) (H << 2) | (Lb << 1) | M else (H << 1) | Lb;
    const m: u8 = @intCast(if (x.size == 1) rmLow else (M << 4) | rmLow);
    if (opcode == 14) return dot(x, m, idx);
    return if (x.size == 1) byElementI(i16, x, m, idx) else byElementI(i32, x, m, idx);
}
fn byElementF(comptime F: type, x: Ctx, m: u8, idx: usize) Status {
    const c = x.c;
    const opcode = bits(x.w, 12, 4);
    const count = laneCount(x, F);
    const t = get(F, c, m, idx);
    var out: V align(16) = old(c, x.rd);
    const O = L(F, &out);
    for (0..count) |i| {
        const n = get(F, c, x.rn, i);
        const d = get(F, c, x.rd, i);
        O[i] = if (opcode == 9) (if (x.U) fp.fmulx(F, n, t) else n * t) else fp.fma(F, if (opcode == 5) -n else n, t, d);
    }
    x.finish(F, out);
    return .next;
}
fn byElementI(comptime S: type, x: Ctx, m: u8, idx: usize) Status {
    const c = x.c;
    const opcode = bits(x.w, 12, 4);
    const bitsT = @bitSizeOf(S);
    const Un = Unsigned(S);
    const W = Wide(S);
    const WU = Unsigned(W);
    const count = laneCount(x, S);
    var out: V align(16) = old(c, x.rd);
    switch (opcode) {
        8, 0, 4, 12, 13 => {
            if ((opcode == 0 or opcode == 4) and !x.U) return fault(c, x.w);
            const t = get(S, c, m, idx);
            const O = L(S, &out);
            for (0..count) |i| {
                const n = get(S, c, x.rn, i);
                const d = get(S, c, x.rd, i);
                O[i] = switch (opcode) {
                    8 => n *% t,
                    0 => d +% n *% t,
                    4 => d -% n *% t,
                    else => sat(S, c, (2 * @as(W, n) * @as(W, t) + (if (opcode == 13) @as(W, 1) << (bitsT - 1) else 0)) >> bitsT),
                };
            }
            x.finish(S, out);
        },
        10, 2, 6 => {
            const wcount = 8 / @sizeOf(S);
            const off: usize = if (x.q) wcount else 0;
            if (x.U) {
                const t: WU = get(Un, c, m, idx);
                const O = L(WU, &out);
                for (0..wcount) |i| {
                    const p = @as(WU, get(Un, c, x.rn, off + i)) *% t;
                    O[i] = if (opcode == 10) p else if (opcode == 2) get(WU, c, x.rd, i) +% p else get(WU, c, x.rd, i) -% p;
                }
            } else {
                const t: W = get(S, c, m, idx);
                const O = L(W, &out);
                for (0..wcount) |i| {
                    const p = @as(W, get(S, c, x.rn, off + i)) *% t;
                    O[i] = if (opcode == 10) p else if (opcode == 2) get(W, c, x.rd, i) +% p else get(W, c, x.rd, i) -% p;
                }
            }
            write(c, x.rd, out, true);
        },
        else => return fault(c, x.w),
    }
    return .next;
}
fn dot(x: Ctx, m: u8, idx: usize) Status {
    const c = x.c;
    if (x.size != 2) return fault(c, x.w);
    const count = laneCount(x, u32);
    const byVector = is(x.w, 0x9f20fc00, 0x0e009400);
    var out: V align(16) = old(c, x.rd);
    const O = L(i32, &out);
    for (0..count) |i| {
        var acc: i32 = get(i32, c, x.rd, i);
        for (0..4) |k| {
            const j = if (byVector) 4 * i + k else 4 * idx + k;
            acc +%= if (x.U) @as(i32, get(u8, c, x.rn, 4 * i + k)) * @as(i32, get(u8, c, m, j)) else @as(i32, get(i8, c, x.rn, 4 * i + k)) * @as(i32, get(i8, c, m, j));
        }
        O[i] = acc;
    }
    x.finish(i32, out);
    return .next;
}

fn threeDifferent(x: Ctx) Status {
    if (x.size == 3) return fault(x.c, x.w);
    return bySize(threeDifferentT, x, x.size, !x.U);
}
fn threeDifferentT(comptime T: type, x: Ctx) Status {
    const c = x.c;
    const opcode = bits(x.w, 12, 4);
    const q = bits(x.w, 30, 1) != 0;
    const W = Wide(T);
    const bitsT = @bitSizeOf(T);
    const wcount = 8 / @sizeOf(T);
    const off: usize = if (q) wcount else 0;
    var out: V align(16) = old(c, x.rd);
    if (opcode == 4 or opcode == 6) {
        const WU = Unsigned(W);
        var narrow: [8]u8 align(8) = undefined;
        for (0..wcount) |i| {
            const n: WU = get(WU, c, x.rn, i);
            const m: WU = get(WU, c, x.rm, i);
            const r: WU = (if (opcode == 4) n +% m else n -% m) +% (if (x.U) @as(WU, 1) << (bitsT - 1) else 0);
            LN(Unsigned(T), &narrow)[i] = @truncate(r >> bitsT);
        }
        return narrowed(x, narrow, @sizeOf(T));
    }
    const O = L(W, &out);
    for (0..wcount) |i| {
        const n: W = get(T, c, x.rn, off + i);
        const m: W = get(T, c, x.rm, off + i);
        const wn: W = get(W, c, x.rn, i);
        const d: W = get(W, c, x.rd, i);
        const ad: W = if (n > m) n - m else m - n;
        O[i] = switch (opcode) {
            0 => n +% m,
            1 => wn +% m,
            2 => n -% m,
            3 => wn -% m,
            5 => d +% ad,
            7 => ad,
            8 => d +% n *% m,
            10 => d -% n *% m,
            12 => n *% m,
            14 => if (x.U or bitsT != 8) return fault(c, x.w) else @bitCast(fp.pmul8(@truncate(@as(Unsigned(W), @bitCast(n))), @truncate(@as(Unsigned(W), @bitCast(m))))),
            else => return fault(c, x.w),
        };
    }
    write(c, x.rd, out, true);
    return .next;
}

fn scalarFp(c: *Cpu, w: u32) Status {
    const ftype = bits(w, 22, 2);
    if (w & 0x20000000 != 0) return fault(c, w);
    return switch (ftype) {
        0 => fpT(f32, c, w),
        1 => fpT(f64, c, w),
        3 => fpHalf(c, w),
        else => if (is(w, 0x5f20fc00, 0x1e200000) and bits(w, 16, 3) >= 6) fpT(f64, c, w) else fault(c, w),
    };
}
fn fpHalf(c: *Cpu, w: u32) Status {
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    if (is(w, 0x5f207c00, 0x1e204000)) {
        const opcode = bits(w, 15, 6);
        if (opcode >= 4 and opcode <= 7) {
            const to = opcode & 3;
            const src = fp.h2f(get(u16, c, rn, 0));
            switch (to) {
                0 => writeScalar(c, rd, f32, @floatCast(src)),
                1 => writeScalar(c, rd, f64, src),
                else => return fault(c, w),
            }
            return .next;
        }
    }
    return fault(c, w);
}
fn fpT(comptime F: type, c: *Cpu, w: u32) Status {
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const sf = w >> 31 != 0;
    const dp = F == f64;
    const U = Unsigned(F);
    const n = get(F, c, rn, 0);
    const m = get(F, c, rm, 0);
    if (is(w, 0x5f20fc00, 0x1e200000)) {
        const rmode = bits(w, 19, 2);
        const opcode = bits(w, 16, 3);
        if (opcode >= 6) {
            if (bits(w, 22, 2) == 2 and rmode == 1 and sf) {
                if (opcode == 6) a64.setX(c, rd, get(u64, c, rn, 1)) else L(u64, &c.v[rd])[1] = a64.zr(c, rn);
                return .next;
            }
            if (rmode != 0 or dp != sf) return fault(c, w);
            if (opcode == 6) {
                if (sf) a64.setX(c, rd, get(u64, c, rn, 0)) else a64.setW(c, rd, get(u32, c, rn, 0));
            } else if (sf) writeScalar(c, rd, u64, a64.zr(c, rn)) else writeScalar(c, rd, u32, @truncate(a64.zr(c, rn)));
            return .next;
        }
        if (opcode == 2 or opcode == 3) {
            writeScalar(c, rd, F, cvtInt(F, a64.zr(c, rn), sf, opcode == 2));
            return .next;
        }
        if (opcode <= 1 or opcode == 4 or opcode == 5) {
            const mode: u8 = if (opcode >= 4) 'A' else if (rmode == 0) 'N' else if (rmode == 1) 'P' else if (rmode == 2) 'M' else 'Z';
            const t = roundMode(F, c, n, mode);
            toIntReg(c, rd, sf, opcode & 1 != 0, t);
            return .next;
        }
        return fault(c, w);
    }
    if (is(w, 0x5f200000, 0x1e000000)) {
        const rmode = bits(w, 19, 2);
        const opcode = bits(w, 16, 3);
        const fbits: i32 = 64 - @as(i32, @intCast(bits(w, 10, 6)));
        const scale = std.math.ldexp(@as(F, 1), fbits);
        if (rmode == 0 and (opcode == 2 or opcode == 3)) {
            writeScalar(c, rd, F, cvtInt(F, a64.zr(c, rn), sf, opcode == 2) / scale);
            return .next;
        }
        if (rmode == 3 and opcode <= 1) {
            toIntReg(c, rd, sf, opcode == 1, @trunc(n * scale));
            return .next;
        }
        return fault(c, w);
    }
    if (sf) return fault(c, w);
    if (is(w, 0x5f207c00, 0x1e204000)) {
        const opcode = bits(w, 15, 6);
        if (opcode >= 4 and opcode <= 7) {
            const to = opcode & 3;
            switch (to) {
                0 => if (dp) writeScalar(c, rd, f32, @floatCast(n)) else return fault(c, w),
                1 => if (!dp) writeScalar(c, rd, f64, n) else return fault(c, w),
                3 => writeScalar(c, rd, u16, fp.f2hb(F, @bitCast(n))),
                else => return fault(c, w),
            }
            return .next;
        }
        const sign: U = @as(U, 1) << (@bitSizeOf(F) - 1);
        const nb: U = @bitCast(n);
        switch (opcode) {
            0 => writeScalar(c, rd, F, n),
            1 => writeScalar(c, rd, U, nb & ~sign),
            2 => writeScalar(c, rd, U, nb ^ sign),
            3 => writeScalar(c, rd, F, @sqrt(n)),
            8, 9, 10, 11, 12, 14, 15 => {
                const mode: u8 = switch (opcode) {
                    8 => 'N',
                    9 => 'P',
                    10 => 'M',
                    11 => 'Z',
                    12 => 'A',
                    else => 'X',
                };
                writeScalar(c, rd, F, roundMode(F, c, n, mode));
            },
            else => return fault(c, w),
        }
        return .next;
    }
    if (is(w, 0x5f203c00, 0x1e202000)) {
        const opcode2 = w & 31;
        if (opcode2 & 7 != 0) return fault(c, w);
        c.setNZCV(fp.fcmp(n, if (opcode2 & 8 != 0) @as(F, 0) else m));
        return .next;
    }
    if (is(w, 0x5f201c00, 0x1e201000)) {
        const imm = vfpImm(bits(w, 13, 8), dp);
        writeScalar(c, rd, U, @truncate(imm));
        return .next;
    }
    if (is(w, 0x5f200c00, 0x1e200400)) {
        if (cond(c, @intCast(bits(w, 12, 4)))) c.setNZCV(fp.fcmp(n, m)) else c.setNZCV((w & 15) << 28);
        return .next;
    }
    if (is(w, 0x5f200c00, 0x1e200800)) {
        const opcode = bits(w, 12, 4);
        const v: F = switch (opcode) {
            0 => n * m,
            1 => n / m,
            2 => n + m,
            3 => n - m,
            4 => fp.fmax(F, n, m),
            5 => fp.fmin(F, n, m),
            6 => fp.fnm(F, n, m, true),
            7 => fp.fnm(F, n, m, false),
            8 => -(n * m),
            else => return fault(c, w),
        };
        writeScalar(c, rd, F, v);
        return .next;
    }
    if (is(w, 0x5f200c00, 0x1e200c00)) {
        writeScalar(c, rd, U, if (cond(c, @intCast(bits(w, 12, 4)))) get(U, c, rn, 0) else get(U, c, rm, 0));
        return .next;
    }
    if (is(w, 0x5f000000, 0x1f000000)) {
        const o1 = bits(w, 21, 1) != 0;
        const o0 = bits(w, 15, 1) != 0;
        const acc = get(F, c, @intCast(bits(w, 10, 5)), 0);
        const a: F = if (o1 == o0) n else -n;
        const cc: F = if (o1) -acc else acc;
        const v: F = fp.fma(F, a, m, cc);
        writeScalar(c, rd, F, v);
        return .next;
    }
    return fault(c, w);
}
fn cvtInt(comptime F: type, src: u64, sf: bool, signed: bool) F {
    if (sf) return if (signed) @floatFromInt(@as(i64, @bitCast(src))) else @floatFromInt(src);
    return if (signed) @floatFromInt(@as(i32, @truncate(@as(i64, @bitCast(src))))) else @floatFromInt(@as(u32, @truncate(src)));
}
fn toIntReg(c: *Cpu, rd: u8, sf: bool, unsigned: bool, t: anytype) void {
    if (sf) {
        a64.setX(c, rd, if (unsigned) fp.toInt(u64, t) else @bitCast(fp.toInt(i64, t)));
    } else {
        a64.setW(c, rd, if (unsigned) fp.toInt(u32, t) else @bitCast(fp.toInt(i32, t)));
    }
}
