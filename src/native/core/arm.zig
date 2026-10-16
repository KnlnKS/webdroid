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
inline fn fault(c: *Cpu, code: Fault, w: u32, pc: u32) Status {
    c.pc = pc;
    return cpu.raise(c, code, w);
}
inline fn badAddr(c: *Cpu, w: u32, pc: u32) Status {
    return fault(c, .bad_address, w, pc);
}
inline fn misaligned(c: *Cpu, a: u32, w: u32, pc: u32) Status {
    c.fault_addr = a;
    return badAddr(c, w, pc);
}
/// below LOW, or past the 2 GiB an ARM32 process's memory ends at, which as a signed compare
/// costs no more than the null page's alone
inline fn addr(c: *Cpu, a: u32) ?u32 {
    if (@as(i32, @bitCast(a)) < abi.LOW) {
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
    if (n == 0) return .{ .v = v, .carry = c.cf() };
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
        else => .{ .v = (v >> 1) | (c.cf() << 31), .carry = v & 1 },
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
        return .{ .v = v, .carry = c.cf() };
    }
    const rot = (imm12 >> 7) & 31;
    const v = std.math.rotr(u32, 0x80 | (imm12 & 0x7f), rot);
    return .{ .v = v, .carry = v >> 31 };
}

fn neonStruct(c: *Cpu, w: u32, pc: u32) Status {
    if (w & (1 << 23) != 0) return neonLane(c, w, pc);
    const kind = bits(w, 8, 4);
    const structures: u32 = switch (kind) {
        7, 10, 6, 2 => 1,
        8, 9, 3 => 2,
        4, 5 => 3,
        0, 1 => 4,
        else => return fault(c, .unimplemented, w, pc),
    };
    const regs: u32 = switch (kind) { 10, 3 => 2, 6 => 3, 2 => 4, else => 1 };
    const stride: u32 = if (kind == 9 or kind == 3 or kind == 5 or kind == 1) 2 else 1;
    const size = bits(w, 6, 2);
    const alignment = bits(w, 4, 2);
    if (structures > 1 and size == 3 or structures == 3 and alignment > 1 or structures == 2 and regs == 1 and alignment == 3)
        return fault(c, .undefined, w, pc);
    if (structures == 1 and (regs & 1 != 0 and alignment > 1 or regs == 2 and alignment == 3)) return fault(c, .undefined, w, pc);
    const load = w & (1 << 21) != 0;
    const n = bits(w, 16, 4);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    if (n == 15 or d + (structures - 1) * stride + regs > 32) return fault(c, .undefined, w, pc);
    const a = addr(c, r(c, n)) orelse return badAddr(c, w, pc);
    if (alignment != 0 and a & ((@as(u32, 4) << @intCast(alignment)) - 1) != 0) return misaligned(c, a, w, pc);
    if (structures == 1) {
        var i: u32 = 0;
        while (i < regs) : (i += 1) {
            if (load) vreg(u64, c, d + i).* = ld(u64, a + i * 8) else if (!st(u64, c, a + i * 8, vreg(u64, c, d + i).*)) return badAddr(c, w, pc);
        }
    } else {
        const ok = switch (size) {
            0 => neonInterleave(u8, c, a, d, regs, structures, stride, load),
            1 => neonInterleave(u16, c, a, d, regs, structures, stride, load),
            else => neonInterleave(u32, c, a, d, regs, structures, stride, load),
        };
        if (!ok) return badAddr(c, w, pc);
    }
    const m = w & 15;
    if (m != 15) set(c, n, r(c, n) +% (if (m == 13) regs * structures * 8 else r(c, m)));
    return .next;
}

fn neonLane(c: *Cpu, w: u32, pc: u32) Status {
    if (bits(w, 8, 2) != 0) return fault(c, .unimplemented, w, pc);
    const load = w & (1 << 21) != 0;
    const replicate = bits(w, 10, 2) == 3;
    const size = if (replicate) bits(w, 6, 2) else bits(w, 10, 2);
    const index_align = bits(w, 4, 4);
    if (replicate) {
        if (!load or size == 3 or size == 0 and index_align & 1 != 0) return fault(c, .undefined, w, pc);
    } else if (switch (size) {
        0 => index_align & 1 != 0,
        1 => index_align & 2 != 0,
        else => index_align & 7 != 0 and index_align & 7 != 3,
    }) return fault(c, .undefined, w, pc);
    const bytes = @as(u32, 1) << @intCast(size);
    const alignment = if (index_align & 1 != 0) bytes else 1;
    const regs: u32 = if (replicate) 1 + bits(w, 5, 1) else 1;
    const n = bits(w, 16, 4);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    if (n == 15 or d + regs > 32) return fault(c, .undefined, w, pc);
    const a = addr(c, r(c, n)) orelse return badAddr(c, w, pc);
    if (a & (alignment - 1) != 0) return misaligned(c, a, w, pc);
    const first = if (replicate) 0 else index_align >> @intCast(size + 1);
    const end = if (replicate) regs * 8 / bytes else first + 1;
    const dst: [*]u8 = @ptrCast(vreg(u64, c, d));
    var lane = first;
    while (lane < end) : (lane += 1) {
        var i: u32 = 0;
        while (i < bytes) : (i += 1) {
            if (load) dst[lane * bytes + i] = ld(u8, a + i) else if (!st(u8, c, a + i, dst[lane * bytes + i])) return badAddr(c, w, pc);
        }
    }
    const m = w & 15;
    if (m != 15) set(c, n, r(c, n) +% (if (m == 13) bytes else r(c, m)));
    return .next;
}

fn neonInterleave(comptime T: type, c: *Cpu, base: u32, d: u32, regs: u32, structures: u32, stride: u32, load: bool) bool {
    var a = base;
    var index: u32 = 0;
    while (index < regs) : (index += 1) {
        for (0..8 / @sizeOf(T)) |lane| {
            var s: u32 = 0;
            while (s < structures) : (s += 1) {
                const vector: [*]align(1) T = @ptrCast(vreg(u64, c, d + index + s * stride));
                if (load) vector[lane] = ld(T, a) else if (!st(T, c, a, vector[lane])) return false;
                a += @sizeOf(T);
            }
        }
    }
    return true;
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

fn neonShift(c: *Cpu, w: u32, pc: u32) Status {
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const m = (bits(w, 5, 1) << 4) | bits(w, 0, 4);
    const q = bits(w, 6, 1);
    const op = bits(w, 8, 4);
    const widen = op == 10;
    const narrow = op == 8 or op == 9;
    if (op > 7 and !widen and !narrow) return fault(c, .unimplemented, w, pc);
    if (narrow) {
        if (m & 1 != 0) return fault(c, .undefined, w, pc);
        const imm = (bits(w, 7, 1) << 6) | bits(w, 16, 6);
        @memcpy(&c.v[18], @as([*]u8, @ptrCast(vreg(u64, c, m)))[0..16]);
        const opcode = 16 + (op - 8) * 2 + q;
        const result = simd.exec(c, 0x0f000400 | (bits(w, 24, 1) << 29) | (imm << 16) | (opcode << 11) | (18 << 5) | 16);
        if (result == .next) @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..8], c.v[16][0..8]);
        return result;
    }
    if ((widen and (d & 1 != 0 or q != 0)) or (q != 0 and (d | m) & 1 != 0)) return fault(c, .undefined, w, pc);
    const imm = (bits(w, 7, 1) << 6) | bits(w, 16, 6);
    const count: usize = if (q != 0 or widen) 16 else 8;
    const read_count = if (widen) 8 else count;
    @memcpy(c.v[16][0..count], @as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count]);
    @memcpy(c.v[18][0..read_count], @as([*]u8, @ptrCast(vreg(u64, c, m)))[0..read_count]);
    const result = simd.exec(c, 0x0f000400 | (q << 30) | (bits(w, 24, 1) << 29) | (imm << 16) | (op << 12) | (18 << 5) | 16);
    if (result == .next) @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count], c.v[16][0..count]);
    return result;
}

fn neonMisc(c: *Cpu, w: u32, pc: u32) Status {
    if (w & 0xffb30e10 == 0xf3b20000) return neonPermute(c, w, pc);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const m = (bits(w, 5, 1) << 4) | bits(w, 0, 4);
    const q = bits(w, 6, 1);
    const duplicate = w & 0xffb00f90 == 0xf3b00c00;
    if (w & 0xffb00c10 == 0xf3b00800) {
        const n = (bits(w, 7, 1) << 4) | bits(w, 16, 4);
        const len = bits(w, 8, 2) + 1;
        if (n + len > 32) return fault(c, .undefined, w, pc);
        const table: [*]const u8 = @ptrCast(vreg(u64, c, n));
        var out: [8]u8 = @bitCast(vreg(u64, c, d).*);
        simd.tableLookup(table[0 .. 8 * len], std.mem.asBytes(vreg(u64, c, m)), &out, q != 0);
        vreg(u64, c, d).* = @bitCast(out);
        return .next;
    }
    const narrow = w & 0xffb30fd0 == 0xf3b20200;
    if (q != 0 and (d | (if (duplicate) @as(u32, 0) else m)) & 1 != 0) return fault(c, .undefined, w, pc);
    const translated: u32 = if (duplicate) blk: {
        const imm = bits(w, 16, 4);
        if (imm & 7 == 0) return fault(c, .undefined, w, pc);
        break :blk 0x0e000400 | (imm << 16);
    } else if (narrow) blk: {
        const size = bits(w, 18, 2);
        if (size == 3 or m & 1 != 0) return fault(c, .undefined, w, pc);
        break :blk 0x0e212800 | (size << 22);
    } else if (w & 0xffbf0f10 == 0xf3bb0500)
        0x0ea1d800 | (bits(w, 7, 1) << 29)
    else if (w & 0xffbf0f90 == 0xf3b00580)
        0x2e205800
    else if (w & 0xffbf0e10 == 0xf3bb0600)
        (if (w & 0x100 != 0) @as(u32, 0x0ea1b800) else 0x0e21d800) | (bits(w, 7, 1) << 29)
    else if (w & 0xffb30810 == 0xf3b10000) blk: {
        const size = bits(w, 18, 2);
        const op = bits(w, 7, 3);
        const float = bits(w, 10, 1);
        if (size == 3 or op == 5 or (float != 0 and size != 2)) return fault(c, .undefined, w, pc);
        break :blk 0x0e200800 | ((8 + op / 2 + 4 * float) << 12) | (size << 22) | ((op & 1) << 29);
    } else if (w & 0xffb30e10 == 0xf3b00000) blk: {
        const op = bits(w, 7, 2);
        const size = bits(w, 18, 2);
        if (op > 2 or size + op >= 3) return fault(c, .undefined, w, pc);
        break :blk 0x0e200800 | (size << 22) | (if (op == 1) @as(u32, 1 << 29) else if (op == 2) @as(u32, 1 << 12) else 0);
    } else return fault(c, .unimplemented, w, pc);
    const count: usize = if (q != 0) 16 else 8;
    const read_count = if (duplicate) 8 else if (narrow) 16 else count;
    @memcpy(c.v[18][0..read_count], @as([*]u8, @ptrCast(vreg(u64, c, m)))[0..read_count]);
    if (w & 0xffbf0c10 == 0xf3b90400 or w & 0xffbf0f10 == 0xf3bb0500) {
        const lanes: *[4]f32 = @ptrCast(&c.v[18]);
        for (lanes[0 .. count / 4]) |*lane| lane.* = fp.standard32(lane.*);
    }
    const result = simd.exec(c, translated | (q << 30) | (18 << 5) | 16);
    if (result == .next and (w & 0xffbf0f10 == 0xf3bb0500 or w & 0xffbf0f10 == 0xf3b90700)) {
        const lanes: *[4]f32 = @ptrCast(&c.v[16]);
        for (lanes[0 .. count / 4]) |*lane| lane.* = fp.standard32(lane.*);
    }
    if (result == .next) @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count], c.v[16][0..count]);
    return result;
}

fn neonPermute(c: *Cpu, w: u32, pc: u32) Status {
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const m = (bits(w, 5, 1) << 4) | bits(w, 0, 4);
    const q = bits(w, 6, 1);
    const size = bits(w, 18, 2);
    const op = bits(w, 7, 2);
    if (size == 3 or (q != 0 and (d | m) & 1 != 0)) return fault(c, .undefined, w, pc);
    if (op == 0) {
        if (size != 0) return fault(c, .undefined, w, pc);
        for (0..(if (q != 0) @as(usize, 2) else 1)) |i| {
            std.mem.swap(u64, vreg(u64, c, d + @as(u32, @intCast(i))), vreg(u64, c, m + @as(u32, @intCast(i))));
        }
        return .next;
    }
    const count: usize = if (q != 0) 16 else 8;
    @memcpy(c.v[17][0..count], @as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count]);
    @memcpy(c.v[18][0..count], @as([*]u8, @ptrCast(vreg(u64, c, m)))[0..count]);
    const opcode: u32 = if (op == 1) 2 else if (op == 2) 1 else 3;
    const translated = 0x0e000800 | (q << 30) | (size << 22) | (opcode << 12) | (18 << 16) | (17 << 5);
    const low = simd.exec(c, translated | 16);
    if (low != .next) return low;
    const high = simd.exec(c, translated | (4 << 12) | 19);
    if (high != .next) return high;
    @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count], c.v[16][0..count]);
    @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, m)))[0..count], c.v[19][0..count]);
    return .next;
}

/// The three-registers-of-different-lengths operation a long form computes: its own, or for a
/// by-scalar form (bit 6) the one it multiplies as (VMLAL, VQDMLAL, VMLSL, VQDMLSL, VMULL, VQDMULL).
pub fn neonLongOp(w: u32) u32 {
    return if (w & 0x40 != 0) 8 + (bits(w, 10, 2) << 1) + bits(w, 8, 1) else bits(w, 8, 4);
}

/// Whether a by-scalar form is one of those long forms, which neonLong computes.
pub fn neonLongByScalar(w: u32) bool {
    const op = bits(w, 8, 4);
    return op & 2 != 0 and op < 12;
}

/// A by-scalar form's Dm[x]: the D register and the lane.
pub fn neonScalar(w: u32, size: u32) struct { u32, u32 } {
    return if (size == 1) .{ bits(w, 0, 3), (bits(w, 5, 1) << 1) | bits(w, 3, 1) } else .{ bits(w, 0, 4), bits(w, 5, 1) };
}

/// The by-scalar forms' Dm[x], in every lane of v18.
fn splatScalar(c: *Cpu, w: u32, size: u32) void {
    const m, const lane = neonScalar(w, size);
    if (size == 1)
        @as(*[8]u16, @ptrCast(&c.v[18])).* = @splat(@as([*]u16, @ptrCast(vreg(u64, c, m)))[lane])
    else
        @as(*[4]u32, @ptrCast(&c.v[18])).* = @splat(@as([*]u32, @ptrCast(vreg(u64, c, m)))[lane]);
}

fn neonLong(c: *Cpu, w: u32, pc: u32) Status {
    const scalar = w & 0x40 != 0;
    const op = neonLongOp(w);
    const size = bits(w, 20, 2);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const n = (bits(w, 7, 1) << 4) | bits(w, 16, 4);
    const m = (bits(w, 5, 1) << 4) | bits(w, 0, 4);
    const narrow = op == 4 or op == 6;
    const wide = op == 1 or op == 3;
    if (size == 3 or (scalar and size == 0) or (if (narrow) n | m else d | (if (wide) n else 0)) & 1 != 0) return fault(c, .undefined, w, pc);
    // the saturating doubling forms
    if (op & 9 == 9) return fault(c, .unimplemented, w, pc);
    const count: usize = if (narrow) 8 else 16;
    @memcpy(c.v[16][0..count], @as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count]);
    @memcpy(c.v[17][0..(if (narrow or wide) @as(usize, 16) else 8)], @as([*]u8, @ptrCast(vreg(u64, c, n))));
    if (scalar) splatScalar(c, w, size) else @memcpy(c.v[18][0..(if (narrow) @as(usize, 16) else 8)], @as([*]u8, @ptrCast(vreg(u64, c, m))));
    const result = simd.exec(c, 0x0e200000 | (bits(w, 24, 1) << 29) | (size << 22) | (op << 12) | (18 << 16) | (17 << 5) | 16);
    if (result == .next) @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count], c.v[16][0..count]);
    return result;
}

fn neonSame(c: *Cpu, w: u32, pc: u32) Status {
    const scalar = w & 0xfe800050 == 0xf2800040 and bits(w, 20, 2) != 3;
    if (scalar and neonLongByScalar(w)) return neonLong(c, w, pc);
    const size = bits(w, 20, 2);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const n = (bits(w, 7, 1) << 4) | bits(w, 16, 4);
    const m = (bits(w, 5, 1) << 4) | bits(w, 0, 4);
    const q = if (scalar) bits(w, 24, 1) else bits(w, 6, 1);
    if (q != 0 and (d | n | (if (scalar) @as(u32, 0) else m)) & 1 != 0) return fault(c, .undefined, w, pc);
    const op = bits(w, 8, 4);
    const extract = w & 0xffb00010 == 0xf2b00000;
    if (extract and q == 0 and op >= 8) return fault(c, .undefined, w, pc);
    const b = bits(w, 4, 1);
    const u = bits(w, 24, 1);
    if (!scalar and op == 15 and b == 1 and u == 0 and size & 1 == 0) {
        const lhs: [*]f32 = @ptrCast(vreg(u64, c, n));
        const rhs: [*]f32 = @ptrCast(vreg(u64, c, m));
        const dst: [*]f32 = @ptrCast(vreg(u64, c, d));
        for (0..if (q != 0) @as(usize, 4) else 2) |i| dst[i] = fp.recipStep32(lhs[i], rhs[i], size == 2);
        return .next;
    }
    if (scalar and (size == 0 or (op & 1 != 0 and size != 2))) return fault(c, .undefined, w, pc);
    if (scalar and op & 0xe != 0 and op & 0xe != 4 and op & 0xe != 8) return fault(c, .unimplemented, w, pc);
    const variable_shift = !scalar and !extract and op == 4 and b == 0;
    const accumulate = if (scalar) op == 1 or op == 5 else op == 13 and b == 1 and u == 0 and size & 1 == 0;
    const translated: u32 = if (scalar and op & 1 == 0)
        0x0e209400 | (size << 22) | (if (op == 8) @as(u32, 1 << 11) else if (op == 4) @as(u32, 1 << 29) else 0)
    else if (scalar)
        (if (op == 9) @as(u32, 0x2e20dc00) else 0x0e20d400 | (if (op == 5) @as(u32, 1 << 23) else 0))
    else if (extract)
        0x2e000000 | (op << 11)
    else if (op == 8 and b == 0)
        0x0e208400 | (u << 29) | (size << 22)
    else if (op == 3 and size != 3)
        0x0e203400 | (u << 29) | (size << 22) | (b << 11)
    else if (op == 6 and size != 3)
        0x0e206400 | (u << 29) | (size << 22) | (b << 11)
    else if (op == 8 and b == 1)
        0x0e208c00 | (u << 29) | (size << 22)
    else if (op == 9 and size != 3 and (b == 0 or u == 0))
        0x0e209400 | (u << 29) | (size << 22) | (b << 11)
    else if (op == 10 and size != 3 and q == 0)
        0x0e20a400 | (u << 29) | (size << 22) | (b << 11)
    else if (op == 11 and b == 1 and u == 0 and size != 3 and q == 0)
        0x0e20bc00 | (size << 22)
    else if (op == 1 and b == 1)
        0x0e201c00 | (u << 29) | (size << 22)
    else if (variable_shift)
        0x0e204400 | (u << 29) | (size << 22)
    else if (op == 13 and size & 1 == 0 and b == 0)
        0x0e20d400 | (u << 29) | (bits(w, 21, 1) << 23)
    else if (op == 13 and size == 0 and b == 1 and u == 1)
        0x2e20dc00
    else if (op == 14 and size & 1 == 0 and (u == 1 or (b == 0 and size == 0)))
        0x0e20e400 | (u << 29) | (bits(w, 21, 1) << 23) | (b << 11)
    else if (op == 15 and b == 0 and size & 1 == 0)
        0x0e20f400 | (u << 29) | (bits(w, 21, 1) << 23)
    else if (accumulate)
        0x0e20d400 | (bits(w, 21, 1) << 23)
    else
        return fault(c, .unimplemented, w, pc);
    // A32 D registers alias halves of Q registers; the upper A64 registers are scratch.
    const count: usize = if (q != 0) 16 else 8;
    @memcpy(c.v[16][0..count], @as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count]);
    @memcpy(c.v[17][0..count], @as([*]u8, @ptrCast(vreg(u64, c, if (variable_shift) m else n)))[0..count]);
    if (scalar) splatScalar(c, w, size) else @memcpy(c.v[18][0..count], @as([*]u8, @ptrCast(vreg(u64, c, if (variable_shift) n else m)))[0..count]);
    if (accumulate) {
        // A32 VMLA/VMLS round the product before adding; A64 FMLA is fused.
        const multiplied = simd.exec(c, 0x2e20dc00 | (q << 30) | (18 << 16) | (17 << 5) | 19);
        if (multiplied != .next) return multiplied;
    }
    const result = simd.exec(c, translated | (q << 30) | (if (accumulate) @as(u32, (19 << 16) | (16 << 5)) else (18 << 16) | (17 << 5)) | 16);
    if (result == .next) @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count], c.v[16][0..count]);
    return result;
}

fn multiplyHigh(n: u32, m: u32, accumulator: u32, subtract: bool, round: bool) u32 {
    const product: u64 = @bitCast(@as(i64, @as(i32, @bitCast(n))) * @as(i64, @as(i32, @bitCast(m))));
    const base = @as(u64, accumulator) << 32;
    const result = (if (subtract) base -% product else base +% product) +% (if (round) @as(u64, 0x80000000) else 0);
    return @truncate(result >> 32);
}

fn extendBytePair(value: u32, base: u32, signed: bool) u32 {
    const low = if (signed) sxb(value) else value & 255;
    const high = if (signed) sxb(value >> 16) else (value >> 16) & 255;
    return ((base +% low) & 0xffff) | (((base >> 16) +% high) << 16);
}

fn extractField(value: u32, lsb: u32, width: u32, signed: bool) u32 {
    const shifted = value << @intCast(32 - lsb - width);
    const amount: u5 = @intCast(32 - width);
    return if (signed) @bitCast(@as(i32, @bitCast(shifted)) >> amount) else shifted >> amount;
}

fn packHalf(n: u32, m: u32, amount: u5, top: bool) u32 {
    const shifted = if (top) @as(u32, @bitCast(@as(i32, @bitCast(m)) >> (if (amount == 0) @as(u5, 31) else amount))) else m << amount;
    const mask: u32 = if (top) 0xffff0000 else 0xffff;
    return (n & mask) | (shifted & ~mask);
}

fn op2(c: *Cpu, w: u32, pc: u32) Shifted {
    if (w & (1 << 25) != 0) {
        const rot = bits(w, 8, 4) * 2;
        const imm8 = w & 255;
        if (rot == 0) return .{ .v = imm8, .carry = c.cf() };
        const v = std.math.rotr(u32, imm8, rot);
        return .{ .v = v, .carry = v >> 31 };
    }
    const m = w & 15;
    const kind = bits(w, 5, 2);
    const rm = reg(c, m, pc);
    if (w & (1 << 4) != 0) return shiftReg(c, kind, rm, r(c, bits(w, 8, 4)) & 255);
    return shiftImm(c, kind, rm, bits(w, 7, 5));
}

pub fn step(c: *Cpu, pc: u32) Status {
    return if (c.cpsr & (1 << 5) != 0) execThumb(c, pc) else execArm(c, pc);
}
fn execArm(c: *Cpu, pc: u32) Status {
    const w = ld(u32, pc);
    const cc = w >> 28;
    c.pc = pc + 4;
    if (cc == 15) {
        if (w & 0xfe800010 == 0xf2800010 and w & 0x00380080 != 0) return neonShift(c, w, pc);
        if (w & 0xffb00010 == 0xf3b00000) return neonMisc(c, w, pc);
        if (w & 0xfe800000 == 0xf2000000 or w & 0xffb00010 == 0xf2b00000 or w & 0xfe800050 == 0xf2800040) return neonSame(c, w, pc);
        if (w & 0xfe800050 == 0xf2800000) return neonLong(c, w, pc);
        if (w & 0xff100000 == 0xf4000000) return neonStruct(c, w, pc);
        if (w & 0xfeb00010 == 0xf2800010) return neonImmediate(c, w, pc, (bits(w, 24, 1) << 7) | (bits(w, 16, 3) << 4) | bits(w, 0, 4));
        if ((w & 0x0e000000) == 0x0a000000) {
            const off: u32 = @bitCast((@as(i32, @bitCast(w << 8)) >> 6) | @as(i32, @intCast((w >> 23) & 2)));
            set(c, 14, pc + 4);
            return bx(c, ((pc +% 8 +% off) & ~@as(u32, 1)) | 1);
        }
        if ((w & 0x0d70f000) == 0x0550f000) return .next;
        if ((w & 0x0ff000f0) == 0x05700040 or (w & 0x0ff000f0) == 0x05700050 or (w & 0x0ff000f0) == 0x05700060) return .next;
        if ((w & 0x0fffffff) == 0x057ff01f) {
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
            const target = reg(c, rm, pc);
            set(c, 14, pc + 4);
            return bx(c, target);
        }
        if ((w & 0x0ff000f0) == 0x01200070) return fault(c, .brk, w, pc);
        if ((w & 0x0f900df0) == 0x01000040) return fault(c, .unimplemented, w, pc); // CRC32{C}
        if ((w & 0x0fff0ff0) == 0x016f0f10) {
            set(c, rd, @clz(reg(c, rm, pc)));
            return .next;
        }
        if ((w & 0x0fbf0fff) == 0x010f0000) {
            set(c, rd, c.cpsr | 0x10);
            return .next;
        }
        if ((w & 0x0fc000f0) == 0x00000090 or (w & 0x0ff000f0) == 0x00600090) {
            var v = reg(c, rm, pc) *% reg(c, rs, pc);
            if (w & (1 << 22) != 0) v = r(c, rd) -% v else if (w & (1 << 21) != 0) v +%= r(c, rd);
            set(c, rn, v);
            if (w & (1 << 20) != 0) setNZ(c, v);
            return .next;
        }
        const dual_accumulate = w & 0x0ff000f0 == 0x00400090;
        if ((w & 0x0f8000f0) == 0x00800090 or dual_accumulate) {
            const signed = !dual_accumulate and w & (1 << 22) != 0;
            var p: u64 = if (signed) @bitCast(@as(i64, @as(i32, @bitCast(reg(c, rm, pc)))) *% @as(i64, @as(i32, @bitCast(reg(c, rs, pc))))) else @as(u64, reg(c, rm, pc)) *% @as(u64, reg(c, rs, pc));
            if (dual_accumulate) p += @as(u64, r(c, rn)) + r(c, rd)
            else if (w & (1 << 21) != 0) p +%= (@as(u64, r(c, rn)) << 32) | r(c, rd);
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
        if ((w & 0x0f800ff0) == 0x01800f90) {
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
                const ok = c.excl == 0 or switch (sz) {
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
            const m = reg(c, rm, pc);
            const s = reg(c, rs, pc);
            switch (o) {
                0 => set(c, rn, halfAccumulate(c, signedHalf(m, x), signedHalf(s, y), r(c, rd))),
                3 => set(c, rn, @bitCast(signedHalf(m, x) *% signedHalf(s, y))),
                1 => {
                    // SMLAW sets Q when its accumulation overflows, as SMLA does
                    const p: i64 = @as(i64, @as(i32, @bitCast(m))) * @as(i64, signedHalf(s, y)) >> 16;
                    set(c, rn, if (x == 0) halfAccumulate(c, @intCast(p), 1, r(c, rd)) else @truncate(@as(u64, @bitCast(p))));
                },
                else => {
                    const p: u64 = @bitCast(@as(i64, signedHalf(m, x)) * @as(i64, signedHalf(s, y)));
                    const acc = ((@as(u64, r(c, rn)) << 32) | r(c, rd)) +% p;
                    set(c, rd, @truncate(acc));
                    set(c, rn, @intCast(acc >> 32));
                },
            }
            return .next;
        }
        if ((w & 0x0f9000f0) == 0x01000050) {
            const o = bits(w, 21, 2);
            set(c, rd, saturatingAdd(c, reg(c, rm, pc), reg(c, rn, pc), o & 1 != 0, o & 2 != 0));
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
        5 => if (setf) addFlags(c, a, t.v, @intCast(c.cf())) else a +% t.v +% c.cf(),
        6 => if (setf) subFlags(c, a, t.v, @intCast(c.cf())) else a -% t.v -% 1 +% c.cf(),
        else => if (setf) subFlags(c, t.v, a, @intCast(c.cf())) else t.v -% a -% 1 +% c.cf(),
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
inline fn reverse(v: u32, kind: u32) u32 {
    return switch (kind) {
        0 => @byteSwap(v),
        1 => rev16(v),
        2 => @bitReverse(v),
        else => sxh(@byteSwap(@as(u16, @truncate(v)))),
    };
}
fn sat32(c: *Cpu, v: i64) i64 {
    return satN(c, v, 31, false);
}
fn satN(c: *Cpu, v: i64, width: u5, unsigned: bool) i64 {
    const bound = @as(i64, 1) << width;
    const result = @min(@max(v, if (unsigned) 0 else -bound), bound - 1);
    if (result != v) c.cpsr |= 1 << 27;
    return result;
}
/// QADD/QSUB/QDADD/QDSUB: m ± n, with n first doubled (saturating) for the D forms
fn saturatingAdd(c: *Cpu, m: u32, n: u32, subtract: bool, double: bool) u32 {
    const a: i64 = @as(i32, @bitCast(m));
    const b: i64 = if (double) sat32(c, @as(i64, @as(i32, @bitCast(n))) * 2) else @as(i32, @bitCast(n));
    return @bitCast(@as(i32, @intCast(sat32(c, if (subtract) a - b else a + b))));
}
/// SEL: each byte from n where its CPSR.GE bit is set, else from m
fn select(c: *Cpu, n: u32, m: u32) u32 {
    const ge = bits(c.cpsr, 16, 4);
    var v: u32 = 0;
    var i: u5 = 0;
    while (i < 4) : (i += 1) {
        const mask: u32 = @as(u32, 0xff) << (8 * i);
        v |= (if ((ge >> i) & 1 != 0) n else m) & mask;
    }
    return v;
}
/// The parallel add/subtract family in ARM encoding: kind 1/2/3 = S/Q/SH, 5/6/7 = U/UQ/UH;
/// op 0 ADD16, 1 ASX, 2 SAX, 3 SUB16, 4 ADD8, 7 SUB8. Only the plain forms set CPSR.GE.
fn parallel(c: *Cpu, n: u32, m: u32, kind: u32, op: u32) ?u32 {
    if (kind & 3 == 0 or op == 5 or op == 6) return null;
    const signed = kind < 4;
    const width: u5 = if (op >= 4) 8 else 16;
    const lanes: u5 = if (op >= 4) 4 else 2;
    const mask: u32 = (@as(u32, 1) << width) - 1;
    var out: u32 = 0;
    var ge: u32 = 0;
    var i: u5 = 0;
    while (i < lanes) : (i += 1) {
        const crossed = if (op == 1 or op == 2) 1 - i else i;
        const a = laneValue(n, i * width, width, signed);
        const b = laneValue(m, crossed * width, width, signed);
        const subtract = op == 3 or op == 7 or (op == 1 and i == 0) or (op == 2 and i == 1);
        const v = if (subtract) a - b else a + b;
        const bound = @as(i64, 1) << (if (signed) width - 1 else width);
        const result = switch (kind & 3) {
            1 => v,
            2 => @min(@max(v, if (signed) -bound else 0), bound - 1),
            else => v >> 1,
        };
        out |= (@as(u32, @truncate(@as(u64, @bitCast(result)))) & mask) << (i * width);
        if (v >= (if (signed or subtract) 0 else bound)) ge |= (if (width == 8) @as(u32, 1) else 3) << (i * (width / 8));
    }
    if (kind & 3 == 1) c.cpsr = (c.cpsr & ~@as(u32, 0xf0000)) | (ge << 16);
    return out;
}
inline fn laneValue(v: u32, shift: u5, width: u5, signed: bool) i64 {
    const raw = (v >> shift) & ((@as(u32, 1) << width) - 1);
    return if (signed and raw >> (width - 1) != 0) @as(i64, raw) - (@as(i64, 1) << width) else raw;
}
fn saturatingShift(c: *Cpu, value: u32, amount: u5, asr: bool, width: u5, unsigned: bool) u32 {
    const shifted: i32 = if (asr) @as(i32, @bitCast(value)) >> (if (amount == 0) 31 else amount) else @bitCast(value << amount);
    return @bitCast(@as(i32, @intCast(satN(c, shifted, width, unsigned))));
}

fn signedHalf(v: u32, top: u32) i32 {
    return if (top != 0) @as(i32, @bitCast(v)) >> 16 else @as(i16, @bitCast(@as(u16, @truncate(v))));
}
fn halfAccumulate(c: *Cpu, a: i32, b: i32, acc: u32) u32 {
    const sum = @as(i64, a) * b + @as(i32, @bitCast(acc));
    if (sum > std.math.maxInt(i32) or sum < std.math.minInt(i32)) c.cpsr |= 1 << 27;
    return @truncate(@as(u64, @bitCast(sum)));
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
        set(c, rd, if (rm == 15) r(c, rd) & ~mask else (r(c, rd) & ~mask) | ((RM << @intCast(lsb)) & mask));
        return .next;
    }
    if ((w & 0x0fa00070) == 0x07a00050) {
        const lsb = bits(w, 7, 5);
        const width = bits(w, 16, 5) + 1;
        if (lsb + width > 32) return fault(c, .undefined, w, pc);
        set(c, rd, extractField(RM, lsb, width, w & (1 << 22) == 0));
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
            8, 12 => extendBytePair(rotated, add, op1 == 8),
            else => return fault(c, .unimplemented, w, pc),
        };
        set(c, rd, v);
        return .next;
    }
    if ((w & 0x0fbf0f70) == 0x06bf0f30) {
        set(c, rd, reverse(RM, (bits(w, 22, 1) << 1) | bits(w, 7, 1)));
        return .next;
    }
    if ((w & 0x0ff00ff0) == 0x06800fb0) {
        set(c, rd, select(c, RN, RM));
        return .next;
    }
    if ((w & 0x0f800f10) == 0x06000f10) {
        set(c, rd, parallel(c, RN, RM, bits(w, 20, 3), bits(w, 5, 3)) orelse return fault(c, .undefined, w, pc));
        return .next;
    }
    if ((w & 0x0fe00030) == 0x06a00010 or (w & 0x0fe00030) == 0x06e00010) {
        set(c, rd, saturatingShift(c, RM, @intCast(bits(w, 7, 5)), w & (1 << 6) != 0, @intCast(bits(w, 16, 5)), w & (1 << 22) != 0));
        return .next;
    }
    if ((w & 0x0ff00030) == 0x06800010) {
        set(c, rd, packHalf(RN, RM, @intCast(bits(w, 7, 5)), w & (1 << 6) != 0));
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
    if ((w & 0x0ff000d0) == 0x07500010 or (w & 0x0ff000d0) == 0x075000d0) {
        const subtract = w & 0x80 != 0;
        if (subtract and rd == 15) return fault(c, .undefined, w, pc);
        set(c, rn, multiplyHigh(RM, reg(c, rs, pc), if (rd == 15) 0 else r(c, rd), subtract, w & 0x20 != 0));
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
        20 => set(c, 0, c.pid),
        224 => set(c, 0, c.os_tid),
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
    if (execThumb32Branches(c, h, second, pc)) |status| return status;
    if (h & 0xef80 == 0xef80 and second & 0x10 != 0 and (h & 0x38 != 0 or second & 0x80 != 0)) {
        c.pc = pc + 4;
        return neonShift(c, 0xf2000000 | ((h & 0x1000) << 12) | ((h & 0xff) << 16) | second, pc);
    }
    if (h & 0xffb0 == 0xffb0 and second & 0x10 == 0) {
        c.pc = pc + 4;
        return neonMisc(c, 0xf3000000 | ((h & 0xff) << 16) | second, pc);
    }
    if (h & 0xef80 == 0xef00 or (h & 0xffb0 == 0xefb0 and second & 0x10 == 0) or (h & 0xef80 == 0xef80 and second & 0x50 == 0x40)) {
        c.pc = pc + 4;
        return neonSame(c, 0xf2000000 | ((h & 0x1000) << 12) | ((h & 0xff) << 16) | second, pc);
    }
    if (h & 0xef80 == 0xef80 and second & 0x50 == 0) {
        c.pc = pc + 4;
        return neonLong(c, 0xf2000000 | ((h & 0x1000) << 12) | ((h & 0xff) << 16) | second, pc);
    }
    const cp = (second >> 8) & 15;
    if (cp == 10 or cp == 11) {
        if (vfp(c, h << 16 | second, pc -% 4)) |status| {
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
        return neonImmediate(c, h << 16 | h2, pc, imm8);
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
    if ((h & 0xff80) == 0xfb80) {
        const op = (h >> 4) & 7;
        const dual_accumulate = op == 6 and h2 & 0x00f0 == 0x60;
        if (op & 1 == 0 and (h2 & 0x00f0 == 0 or dual_accumulate)) {
            const lo = h2 >> 12;
            const hi = (h2 >> 8) & 15;
            const n = h & 15;
            const m = h2 & 15;
            if (lo == 15 or hi == 15 or lo == hi or n == 15 or m == 15) return fault(c, .undefined, h << 16 | h2, pc);
            var product: u64 = if (op == 0 or op == 4)
                @bitCast(@as(i64, @as(i32, @bitCast(r(c, n)))) *% @as(i64, @as(i32, @bitCast(r(c, m)))))
            else
                @as(u64, r(c, n)) *% @as(u64, r(c, m));
            if (dual_accumulate) product += @as(u64, r(c, hi)) + r(c, lo)
            else if (op >= 4) product +%= (@as(u64, r(c, hi)) << 32) | r(c, lo);
            c.pc = pc + 4;
            set(c, lo, @truncate(product));
            set(c, hi, @intCast(product >> 32));
            return .next;
        }
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
    if ((h & 0xfff0) == 0xfb50 or (h & 0xfff0) == 0xfb60) {
        const a = h2 >> 12;
        const subtract = h & 0x20 != 0;
        if (h2 & 0xe0 != 0 or (subtract and a == 15)) return fault(c, .undefined, h << 16 | h2, pc);
        set(c, bits(h2, 8, 4), multiplyHigh(r(c, h & 15), r(c, h2 & 15), if (a == 15) 0 else r(c, a), subtract, h2 & 0x10 != 0));
        c.pc = pc + 4;
        return .next;
    }
    if ((h & 0xfff0) == 0xfb10) {
        if (h2 & 0xc0 != 0) return fault(c, .undefined, h << 16 | h2, pc);
        const a = h2 >> 12;
        const n = signedHalf(r(c, h & 15), bits(h2, 5, 1));
        const m = signedHalf(r(c, h2 & 15), bits(h2, 4, 1));
        set(c, bits(h2, 8, 4), if (a == 15) @bitCast(n * m) else halfAccumulate(c, n, m, r(c, a)));
        c.pc = pc + 4;
        return .next;
    }
    if ((h & 0xfff0) == 0xfb00) {
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

inline fn execThumb32Transfers(c: *Cpu, h: u32, h2: u32, pc: u32) ?Status {
    if ((h & 0xfff0) == 0xe8d0) {
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
        const a = addr(c, r(c, n) +% (if (extended) 0 else (h2 & 255) * 4)) orelse return badAddr(c, h << 16 | h2, pc);
        if ((load and status != 15) or (!load and status == 15)) return fault(c, .undefined, h << 16 | h2, pc);
        c.pc = pc + 4;
        if (load) {
            if (double) set(c, (h2 >> 8) & 15, ld(u32, a + 4));
            set(c, h2 >> 12, if (byte) ld(u8, a) else if (half) ld(u16, a) else ld(u32, a));
            c.excl = 1;
        } else {
            if (c.excl != 0) {
                const value = r(c, h2 >> 12);
                if (!(if (byte) st(u8, c, a, @truncate(value)) else if (half) st(u16, c, a, @truncate(value)) else st(u32, c, a, value))) return badAddr(c, h << 16 | h2, pc);
                if (double and !st(u32, c, a + 4, r(c, (h2 >> 8) & 15))) return badAddr(c, h << 16 | h2, pc);
            }
            set(c, status, c.excl ^ 1);
            c.excl = 0;
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
        const list = h2;
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
        return neonStruct(c, h << 16 | h2, pc);
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
        const a = addr(c, effective) orelse return badAddr(c, w, pc);
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

pub fn block(c: *Cpu, start: u32, page: *cpu.Page) Status {
    const thumb = c.cpsr & (1 << 5) != 0;
    if (start & (if (thumb) @as(u32, 1) else 3) != 0) return fault(c, .misaligned_pc, start, start);
    c.bpc = start | @intFromBool(thumb);
    var pc = start;
    var last = start;
    var n: u32 = 0;
    var s: Status = .next;
    while (n < cpu.max_block) {
        n += 1;
        last = pc;
        s = if (thumb) execThumb(c, pc) else execArm(c, pc);
        if (s != .next) break;
        pc = @truncate(c.pc);
        // Stay on the page the caller looked up: cover() marks nothing for a range that leaves it,
        // and a store into a word this block executed would then not drop the page.
        if (pc >> abi.PAGE_SHIFT != start >> abi.PAGE_SHIFT) break;
    }
    cpu.cover(page, start, last);
    c.ic += n;
    return if (s == .next) .jump else s;
}
