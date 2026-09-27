//! Thumb-2 data processing, multiplies, extensions, reversals and LDM/STM as the ARM words
//! whose compiled forms compute what arm.zig's Thumb paths compute. rwThumb reads their flag use
//! from the same words. Forms naming PC as an operand do not translate (ARM reads it as pc + 8),
//! except ADR, whose address is a constant.
const std = @import("std");
const bits = @import("bits.zig").bits;

/// A data-processing immediate and its shifter carry-out; a null carry leaves C unchanged.
pub const Imm = struct { v: u32, carry: ?u32 = null };
/// The ARM word, and the expanded immediate where the Thumb one has no ARM encoding. The word's
/// rotation field is then nonzero exactly when the immediate replaces C, as rwArm reads it.
pub const Arm = struct { w: u32, imm: ?Imm = null };

/// ThumbExpandImm_C, as arm.thumbExpandImm computes it.
fn expandImm(h: u32, h2: u32) Imm {
    const imm12 = (bits(h, 10, 1) << 11) | (bits(h2, 12, 3) << 8) | (h2 & 255);
    const imm8 = imm12 & 255;
    if (imm12 >> 10 == 0) return .{ .v = imm8 * @as(u32, switch ((imm12 >> 8) & 3) {
        0 => 1,
        1 => 0x0001_0001,
        2 => 0x0100_0100,
        else => 0x0101_0101,
    }) };
    const v = std.math.rotr(u32, 0x80 | (imm12 & 0x7f), (imm12 >> 7) & 31);
    return .{ .v = v, .carry = v >> 31 };
}

pub fn asArm(pc: u32, h: u32, h2: u32) ?Arm {
    const n = h & 15;
    const d = bits(h2, 8, 4);
    const m = h2 & 15;
    // LDM/STM IA/DB (so PUSH.W/POP.W) share ARM's block-transfer layout. The compiled ARM form
    // writes back before loading, so a loaded base (where arm.zig's writeback wins) stays out.
    if (h & 0xffc0 == 0xe880 or h & 0xffc0 == 0xe900) {
        const ld = h & 0x10 != 0;
        if (n == 15 or h2 == 0 or h2 & 0x2000 != 0 or (!ld and h2 & 0x8000 != 0) or (ld and h & 0x20 != 0 and h2 & (@as(u32, 1) << @intCast(n)) != 0)) return null;
        return .{ .w = (h << 16) | h2 };
    }
    if (h & 0xfff0 == 0xfb00 and bits(h2, 4, 4) < 2) {
        // MUL, MLA and MLS: ARM's Rd is Thumb's d, its Ra Thumb's accumulator
        const a = h2 >> 12;
        const mls = h2 & 0x10 != 0;
        if (n == 15 or m == 15 or d == 15 or (mls and a == 15)) return null;
        const base: u32 = if (mls) 0xe060_0090 else if (a == 15) 0xe000_0090 else 0xe020_0090;
        return .{ .w = base | (d << 16) | (if (a == 15) 0 else a << 12) | (m << 8) | n };
    }
    if (h & 0xff80 == 0xfb80) {
        const op = bits(h, 4, 3);
        const dual = op == 6 and h2 & 0xf0 == 0x60;
        const lo = h2 >> 12;
        const hi = d;
        if (op & 1 != 0 or (h2 & 0xf0 != 0 and !dual) or lo == 15 or hi == 15 or lo == hi or n == 15 or m == 15) return null;
        const base: u32 = if (dual) 0xe040_0090 else 0xe080_0090 | (if (op & 2 == 0) @as(u32, 1 << 22) else 0) | (if (op & 4 != 0) @as(u32, 1 << 21) else 0);
        return .{ .w = base | (hi << 16) | (lo << 12) | (m << 8) | n };
    }
    if (h & 0xffd0 == 0xfa90 and h2 & 0xf0c0 == 0xf080 and n == m and n < 15 and d < 15) {
        // CLZ, or REV/REV16/RBIT/REVSH as ARM's media reversal
        if (h & 0x20 != 0) return if (h2 & 0x30 == 0) .{ .w = 0xe16f_0f10 | (d << 12) | m } else null;
        const kind = bits(h2, 4, 2);
        return .{ .w = 0xe6bf_0f30 | ((kind >> 1) << 22) | ((kind & 1) << 7) | (d << 12) | m };
    }
    if (h & 0xff80 == 0xfa00 and h2 & 0xf000 == 0xf000 and m < 15 and d < 15) {
        // SXTAH/UXTAH/SXTAB/UXTAB with rotation (n = 15 extends alone), as ARM's media op1
        if (h2 & 0xc0 == 0x80) return .{ .w = 0xe600_0070 | (@as(u32, switch (bits(h, 4, 3)) {
            0 => 11,
            1 => 15,
            4 => 10,
            5 => 14,
            else => return null,
        }) << 20) | (n << 16) | (d << 12) | (bits(h2, 4, 2) << 10) | m };
        // LSL/LSR/ASR/ROR{S} by register: MOV{S} with a register-shifted operand
        if (h2 & 0xf0 == 0 and n < 15) return .{ .w = 0xe1a0_0010 | (bits(h, 4, 1) << 20) | (d << 12) | (m << 8) | (bits(h, 5, 2) << 5) | n };
        return null;
    }
    if (h2 & 0x8000 != 0) return null;
    if (h & 0xfbe0 == 0xf200 or h & 0xfbe0 == 0xf2a0) {
        // ADDW/SUBW, and ADR as a move of its address
        const imm = (bits(h, 10, 1) << 11) | (bits(h2, 12, 3) << 8) | (h2 & 255);
        const sub = h & 0xfbe0 == 0xf2a0;
        if (d == 15) return null;
        if (n == 15) {
            const base = (pc +% 4) & ~@as(u32, 3);
            return .{ .w = 0xe3a0_0000 | (d << 12), .imm = .{ .v = if (sub) base -% imm else base +% imm } };
        }
        return .{ .w = (if (sub) @as(u32, 0xe240_0000) else 0xe280_0000) | (n << 16) | (d << 12), .imm = .{ .v = imm } };
    }
    if (h & 0xff70 == 0xf340) {
        // SBFX/UBFX as ARM's media field extraction
        const lsb = (bits(h2, 12, 3) << 2) | bits(h2, 6, 2);
        const width = (h2 & 31) + 1;
        if (n == 15 or d == 15 or h2 & 0x20 != 0 or lsb + width > 32) return null;
        return .{ .w = 0xe7a0_0050 | (if (h & 0x80 != 0) @as(u32, 1 << 22) else 0) | ((width - 1) << 16) | (d << 12) | (lsb << 7) | n };
    }
    if (h & 0xfff0 == 0xf360) {
        // BFI, and BFC for n = 15
        const lsb = (bits(h2, 12, 3) << 2) | bits(h2, 6, 2);
        const msb = h2 & 31;
        if (d == 15 or h2 & 0x20 != 0 or msb < lsb) return null;
        return .{ .w = 0xe7c0_0010 | (msb << 16) | (d << 12) | (lsb << 7) | n };
    }
    return dataProcessing(h, h2);
}

/// The data-processing forms with a modified immediate or a shifted register, in arm.zig's
/// thumbData order. n = 15 turns ORR/ORN into MOV/MVN; d = 15 with S turns AND, EOR, ADD and SUB
/// into TST, TEQ, CMN and CMP.
fn dataProcessing(h: u32, h2: u32) ?Arm {
    const shifted = h & 0xfe00 == 0xea00;
    if (!shifted and h & 0xfa00 != 0xf000) return null;
    const op = bits(h, 5, 4);
    const flags = h & 0x10 != 0;
    const d = bits(h2, 8, 4);
    const m = h2 & 15;
    const move = h & 15 == 15 and (op == 2 or op == 3);
    const n = if (move) 0 else h & 15;
    var o: u32 = if (move) (if (op == 2) 13 else 15) else switch (op) {
        0 => 0,
        1 => 14,
        2 => 12,
        4 => 1,
        8 => 4,
        10 => 5,
        11 => 6,
        13 => 2,
        14 => 3,
        else => return null,
    };
    if (n == 15) return null;
    if (d == 15) o = if (flags) switch (op) {
        0 => 8,
        4 => 9,
        8 => 11,
        13 => 10,
        else => return null,
    } else return null;
    const base = 0xe000_0000 | (o << 21) | (@as(u32, @intFromBool(flags)) << 20) | (n << 16) | (d << 12);
    if (shifted) {
        if (m == 15) return null;
        const shift = (bits(h2, 12, 3) << 2) | bits(h2, 6, 2);
        return .{ .w = base | (shift << 7) | (bits(h2, 4, 2) << 5) | m };
    }
    const imm = expandImm(h, h2);
    return .{ .w = base | (1 << 25) | (@as(u32, @intFromBool(imm.carry != null)) << 8), .imm = imm };
}
