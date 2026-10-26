//! ARM32 Advanced SIMD in the interpreter: each operation runs as its A64 form (simd.zig) on
//! scratch registers v16 and up, or element by element for the structure loads and stores.
const std = @import("std");
const fp = @import("fp.zig");
const simd = @import("simd.zig");
const cpu = @import("cpu.zig");
const arm = @import("arm.zig");
const Cpu = cpu.Cpu;
const Status = cpu.Status;
const bits = @import("bits.zig").bits;
const ld = @import("mem.zig").ld;
const st = cpu.st;
const r = arm.r;
const set = arm.set;
const fault = arm.fault;
const badAddr = arm.badAddr;
const misaligned = arm.misaligned;
const addr = arm.addr;
const vreg = arm.vreg;

pub fn neonStruct(c: *Cpu, w: u32, pc: u32) Status {
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
    const a = addr(c, r(c, n), regs * structures * 8) orelse return badAddr(c, w, pc);
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

/// VLDn/VSTn of one n-element structure: to or from one lane of n registers, or loaded to every lane of them
/// (VLD1's every-lane form fills one or two registers with its element).
fn neonLane(c: *Cpu, w: u32, pc: u32) Status {
    const elements = bits(w, 8, 2) + 1;
    const load = w & (1 << 21) != 0;
    const replicate = bits(w, 10, 2) == 3;
    const size = if (replicate) bits(w, 6, 2) else bits(w, 10, 2);
    const index_align = bits(w, 4, 4);
    const bytes = if (size == 3) 4 else @as(u32, 1) << @intCast(size);
    var alignment: u32 = 1;
    var spacing: u32 = 1;
    var copies: u32 = 1;
    if (replicate) {
        const aligned = w & 0x10 != 0;
        if (!load or size == 3 and (elements != 4 or !aligned) or aligned and (elements == 3 or elements == 1 and size == 0)) return fault(c, .undefined, w, pc);
        if (elements == 1) copies += bits(w, 5, 1) else spacing += bits(w, 5, 1);
        if (aligned) alignment = switch (elements) { 1, 2 => bytes * elements, else => if (size >= 2) @as(u32, 8) << @intCast(size - 2) else 4 * bytes };
    } else {
        if (switch (elements) {
            1 => switch (size) { 0 => index_align & 1 != 0, 1 => index_align & 2 != 0, else => index_align & 7 != 0 and index_align & 7 != 3 },
            2 => size == 2 and index_align & 2 != 0,
            3 => index_align & 1 != 0 or size == 2 and index_align & 2 != 0,
            else => size == 2 and index_align & 3 == 3,
        }) return fault(c, .undefined, w, pc);
        if (size != 0) spacing += (index_align >> @intCast(size)) & 1;
        alignment = switch (elements) {
            1, 2 => if (index_align & 1 != 0) bytes * elements else 1,
            3 => 1,
            else => if (size == 2) (if (index_align & 3 == 0) 1 else @as(u32, 4) << @intCast(index_align & 3)) else if (index_align & 1 != 0) 4 * bytes else 1,
        };
    }
    const n = bits(w, 16, 4);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    if (n == 15 or d + (elements - 1) * spacing + copies > 32) return fault(c, .undefined, w, pc);
    const a = addr(c, r(c, n), elements * bytes) orelse return badAddr(c, w, pc);
    if (a & (alignment - 1) != 0) return misaligned(c, a, w, pc);
    const first = if (replicate) 0 else index_align >> @intCast(size + 1);
    const end = if (replicate) 8 / bytes else first + 1;
    var e: u32 = 0;
    while (e < elements) : (e += 1) {
        var k: u32 = 0;
        while (k < copies) : (k += 1) {
            const dst: [*]u8 = @ptrCast(vreg(u64, c, d + e * spacing + k));
            var lane = first;
            while (lane < end) : (lane += 1) {
                var i: u32 = 0;
                while (i < bytes) : (i += 1) {
                    const at = a + e * bytes + i;
                    if (load) dst[lane * bytes + i] = ld(u8, at) else if (!st(u8, c, at, dst[lane * bytes + i])) return badAddr(c, w, pc);
                }
            }
        }
    }
    const m = w & 15;
    if (m != 15) set(c, n, r(c, n) +% (if (m == 13) elements * bytes else r(c, m)));
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

pub fn neonImmediate(c: *Cpu, w: u32, pc: u32, imm8: u32) Status {
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

pub fn neonShift(c: *Cpu, w: u32, pc: u32) Status {
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const m = (bits(w, 5, 1) << 4) | bits(w, 0, 4);
    const q = bits(w, 6, 1);
    const op = bits(w, 8, 4);
    const widen = op == 10;
    const narrow = op == 8 or op == 9;
    // VCVT between floating-point and fixed-point: SCVTF/UCVTF and FCVTZS/FCVTZU, whose fraction bits encode as A64's
    const convert = op >= 14;
    if (op > 7 and !widen and !narrow and !convert) return fault(c, .unimplemented, w, pc);
    if (convert and (bits(w, 21, 1) == 0 or bits(w, 7, 1) != 0)) return fault(c, .undefined, w, pc);
    if (narrow) {
        if (m & 1 != 0) return fault(c, .undefined, w, pc);
        const imm = (bits(w, 7, 1) << 6) | bits(w, 16, 6);
        @memcpy(&c.v[18], @as([*]u8, @ptrCast(vreg(u64, c, m)))[0..16]);
        const result = simd.exec(c, 0x0f000400 | (bits(w, 24, 1) << 29) | (imm << 16) | ((16 + (op - 8) * 2 + q) << 11) | (18 << 5) | 16);
        if (result == .next) @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..8], c.v[16][0..8]);
        return result;
    }
    if ((widen and (d & 1 != 0 or q != 0)) or (q != 0 and (d | m) & 1 != 0)) return fault(c, .undefined, w, pc);
    const imm = (bits(w, 7, 1) << 6) | bits(w, 16, 6);
    const count: usize = if (q != 0 or widen) 16 else 8;
    const read_count = if (widen) 8 else count;
    @memcpy(c.v[16][0..count], @as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count]);
    @memcpy(c.v[18][0..read_count], @as([*]u8, @ptrCast(vreg(u64, c, m)))[0..read_count]);
    const opcode = if (convert) 28 + (op - 14) * 3 else op * 2;
    const result = simd.exec(c, 0x0f000400 | (q << 30) | (bits(w, 24, 1) << 29) | (imm << 16) | (opcode << 11) | (18 << 5) | 16);
    if (result == .next) @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count], c.v[16][0..count]);
    return result;
}

pub fn neonMisc(c: *Cpu, w: u32, pc: u32) Status {
    if (w & 0xffb30e10 == 0xf3b20000) return neonPermute(c, w, pc);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const m = (bits(w, 5, 1) << 4) | bits(w, 0, 4);
    // VMOVN, VQMOVUN and VQMOVN (bits 7:6 are the operation) and VCVT.F16.F32 write a D register from a Q register;
    // VSHLL by the element size and VCVT.F32.F16 a Q register from a D register
    const narrow = w & 0xffb30f10 == 0xf3b20200 or w & 0xffb30fd0 == 0xf3b20600;
    const widen = w & 0xffb30bd0 == 0xf3b20300;
    const half = (narrow or widen) and w & 0x400 != 0;
    const q = if (narrow or widen) 0 else bits(w, 6, 1);
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
    if (q != 0 and (d | (if (duplicate) @as(u32, 0) else m)) & 1 != 0) return fault(c, .undefined, w, pc);
    const out: NeonOp = if (duplicate) blk: {
        const imm = bits(w, 16, 4);
        if (imm & 7 == 0) return fault(c, .undefined, w, pc);
        break :blk .{ .word = 0x0e000400 | (imm << 16), .read = 8 };
    } else if (narrow or widen) blk: {
        const size = bits(w, 18, 2);
        if (size == 3 or (if (narrow) m else d) & 1 != 0 or half and size != 1) return fault(c, .undefined, w, pc);
        // FCVTN and FCVTL; XTN, SQXTUN, SQXTN, UQXTN; SHLL
        const word = if (half) (if (narrow) @as(u32, 0x0e216800) else 0x0e217800) else if (widen) 0x2e213800 | (size << 22) else @as(u32, switch (bits(w, 6, 2)) {
            0 => 0x0e212800,
            1 => 0x2e212800,
            2 => 0x0e214800,
            else => 0x2e214800,
        }) | (size << 22);
        break :blk if (narrow) .{ .word = word, .read = 16, .write = 8, .std_in = half } else .{ .word = word, .read = 8, .write = 16, .std_out = half };
    } else if (w & 0xffbf0f10 == 0xf3bb0500)
        // VRECPE and VRSQRTE (bit 7): FRECPE and FRSQRTE
        .{ .word = 0x0ea1d800 | (bits(w, 7, 1) << 29), .std_in = true, .std_out = true }
    // VCNT and VMVN (bit 7): CNT and NOT
    else if (w & 0xffbf0f10 == 0xf3b00500)
        .{ .word = 0x0e205800 | (bits(w, 7, 1) << 29) }
    else if (w & 0xffbf0e10 == 0xf3bb0600)
        .{ .word = (if (w & 0x100 != 0) @as(u32, 0x0ea1b800) else 0x0e21d800) | (bits(w, 7, 1) << 29) }
    else if (w & 0xffb30810 == 0xf3b10000) blk: {
        // compares with zero, VABS and VNEG; the float forms' results standardized for VABS and VNEG
        const size = bits(w, 18, 2);
        const op = bits(w, 7, 3);
        const float = bits(w, 10, 1);
        if (size == 3 or op == 5 or (float != 0 and size != 2)) return fault(c, .undefined, w, pc);
        break :blk .{ .word = 0x0e200800 | ((8 + op / 2 + 4 * float) << 12) | (size << 22) | ((op & 1) << 29), .std_in = float != 0, .std_out = float != 0 and op >= 6 };
    } else if (w & 0xffb30f10 == 0xf3b00400 or w & 0xffb30f10 == 0xf3b00700) blk: {
        // VCLS and VCLZ, VQABS and VQNEG (bit 7): CLS and CLZ, SQABS and SQNEG
        const size = bits(w, 18, 2);
        if (size == 3) return fault(c, .undefined, w, pc);
        break :blk .{ .word = (if (w & 0x100 != 0) @as(u32, 0x0e207800) else 0x0e204800) | (size << 22) | (bits(w, 7, 1) << 29) };
    } else if (w & 0xffb30b10 == 0xf3b00200) blk: {
        // VPADDL and VPADAL (bit 10): SADDLP/UADDLP and SADALP/UADALP
        const size = bits(w, 18, 2);
        if (size == 3) return fault(c, .undefined, w, pc);
        const accumulate = w & 0x400 != 0;
        break :blk .{ .word = (if (accumulate) @as(u32, 0x0e206800) else 0x0e202800) | (size << 22) | (bits(w, 7, 1) << 29), .reads_d = accumulate };
    } else if (w & 0xffb30e10 == 0xf3b00000) blk: {
        const op = bits(w, 7, 2);
        const size = bits(w, 18, 2);
        if (op > 2 or size + op >= 3) return fault(c, .undefined, w, pc);
        break :blk .{ .word = 0x0e200800 | (size << 22) | (if (op == 1) @as(u32, 1 << 29) else if (op == 2) @as(u32, 1 << 12) else 0) };
    } else return fault(c, .unimplemented, w, pc);
    const write: usize = out.write orelse @as(usize, 8) << @intCast(q);
    const read = out.read orelse write;
    @memcpy(c.v[18][0..read], @as([*]u8, @ptrCast(vreg(u64, c, m)))[0..read]);
    if (out.reads_d) @memcpy(c.v[16][0..write], @as([*]u8, @ptrCast(vreg(u64, c, d)))[0..write]);
    if (out.std_in) standardize(&c.v[18], read);
    const result = simd.exec(c, out.word | (q << 30) | (18 << 5) | 16);
    if (result != .next) return result;
    if (out.std_out) standardize(&c.v[16], write);
    @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..write], c.v[16][0..write]);
    return result;
}
/// A two-register miscellaneous operation as its A64 form on v16 (d) and v18 (m): the bytes it
/// reads of m (all of the result's by default) and writes of d (D or Q), whether it reads d,
/// and whether its float inputs or results are standardized (ARM32 NEON flushes denormals and
/// returns the default NaN)
const NeonOp = struct { word: u32, read: ?usize = null, write: ?usize = null, reads_d: bool = false, std_in: bool = false, std_out: bool = false };
fn standardize(v: *align(16) [16]u8, n: usize) void {
    const lanes: *[4]f32 = @ptrCast(v);
    for (lanes[0 .. n / 4]) |*lane| lane.* = fp.standard32(lane.*);
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

pub fn neonLong(c: *Cpu, w: u32, pc: u32) Status {
    const scalar = w & 0x40 != 0;
    const op = neonLongOp(w);
    const size = bits(w, 20, 2);
    const d = (bits(w, 22, 1) << 4) | bits(w, 12, 4);
    const n = (bits(w, 7, 1) << 4) | bits(w, 16, 4);
    const m = (bits(w, 5, 1) << 4) | bits(w, 0, 4);
    const narrow = op == 4 or op == 6;
    const wide = op == 1 or op == 3;
    const q_operands = if (narrow) n | m else if (wide) d | n else d;
    const polynomial_undefined = op == 14 and (size == 1 or bits(w, 24, 1) != 0);
    if (size == 3 or (scalar and size == 0) or q_operands & 1 != 0 or op == 15 or polynomial_undefined) return fault(c, .undefined, w, pc);
    if (op == 14 and size == 2) return fault(c, .unimplemented, w, pc);
    const count: usize = if (narrow) 8 else 16;
    @memcpy(c.v[16][0..count], @as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count]);
    @memcpy(c.v[17][0..(if (narrow or wide) @as(usize, 16) else 8)], @as([*]u8, @ptrCast(vreg(u64, c, n))));
    if (scalar) splatScalar(c, w, size) else @memcpy(c.v[18][0..(if (narrow) @as(usize, 16) else 8)], @as([*]u8, @ptrCast(vreg(u64, c, m))));
    const result = simd.exec(c, 0x0e200000 | (bits(w, 24, 1) << 29) | (size << 22) | (op << 12) | (18 << 16) | (17 << 5) | 16);
    if (result == .next) @memcpy(@as([*]u8, @ptrCast(vreg(u64, c, d)))[0..count], c.v[16][0..count]);
    return result;
}

pub fn neonSame(c: *Cpu, w: u32, pc: u32) Status {
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
    if (scalar and (size == 0 or (op & 1 != 0 and op < 12 and size != 2))) return fault(c, .undefined, w, pc);
    if (scalar and op & 0xe != 0 and op & 0xe != 4 and op & 0xe != 8 and op & 0xe != 12) return fault(c, .unimplemented, w, pc);
    const variable_shift = !scalar and !extract and (op == 4 or op == 5);
    const accumulate = if (scalar) op == 1 or op == 5 else op == 13 and b == 1 and u == 0 and size & 1 == 0;
    const translated: u32 = if (scalar and op >= 12)
        // VQDMULH and VQRDMULH (bit 8): SQDMULH and SQRDMULH
        0x0e20b400 | (size << 22) | ((op & 1) << 29)
    else if (scalar and op & 1 == 0)
        0x0e209400 | (size << 22) | (if (op == 8) @as(u32, 1 << 11) else if (op == 4) @as(u32, 1 << 29) else 0)
    else if (scalar)
        (if (op == 9) @as(u32, 0x2e20dc00) else 0x0e20d400 | (if (op == 5) @as(u32, 1 << 23) else 0))
    else if (extract)
        0x2e000000 | (op << 11)
    else if (op <= 11) integer: {
        // the integer ops are A64's three-same opcodes (op << 1 | B); only saturating, shifting,
        // logical and plain add/subtract take 64-bit lanes
        const wide = (b == 1 and op <= 2) or op == 4 or op == 5 or (op == 8 and b == 0);
        const pairwise = op == 10 or (op == 11 and b == 1);
        if ((size == 3 and !wide) or (pairwise and q != 0) or (op == 11 and b == 1 and u == 1)) return fault(c, .undefined, w, pc);
        break :integer 0x0e200400 | (u << 29) | (size << 22) | (((op << 1) | b) << 11);
    } else if (op == 13 and size & 1 == 0 and b == 0)
        0x0e20d400 | (u << 29) | (bits(w, 21, 1) << 23)
    else if (op == 13 and size == 0 and b == 1 and u == 1)
        0x2e20dc00
    else if (op == 14 and size & 1 == 0 and (u == 1 or (b == 0 and size == 0)))
        0x0e20e400 | (u << 29) | (bits(w, 21, 1) << 23) | (b << 11)
    else if (op == 15 and b == 0 and size & 1 == 0)
        0x0e20f400 | (u << 29) | (bits(w, 21, 1) << 23)
    else if (op == 12 and b == 1 and u == 0 and size & 1 == 0)
        // VFMA and VFMS (bit 21): FMLA and FMLS
        0x0e20cc00 | (bits(w, 21, 1) << 23)
    else if (op == 15 and b == 1 and u == 1 and size & 1 == 0)
        // VMAXNM and VMINNM (bit 21): FMAXNM and FMINNM
        0x0e20c400 | (bits(w, 21, 1) << 23)
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
