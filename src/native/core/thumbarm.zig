//! Thumb-2 data processing, multiplies, extensions, reversals, LDM/STM and 16-bit IT bodies as
//! the ARM words whose compiled forms compute what arm.zig's Thumb paths compute; arm.zig runs
//! the multiplies as these words. rwThumb reads their flag use from the same words. Forms naming
//! PC as an operand do not translate (ARM reads it as pc + 8), except ADR, whose address is a
//! constant.
const std = @import("std");
const bits = @import("bits.zig").bits;

/// A data-processing immediate and its shifter carry-out; a null carry leaves C unchanged.
pub const Imm = struct { v: u32, carry: ?u32 = null };
/// The ARM word, and the expanded immediate where the Thumb one has no ARM encoding. The word's
/// rotation field is then nonzero exactly when the immediate replaces C, as rwArm reads it.
/// `invert` complements the second operand: ORN as ORR, which ARM lacks.
pub const Arm = struct { w: u32, imm: ?Imm = null, invert: bool = false };

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
    if (h & 0xff00 == 0xfb00) return .{ .w = multiply(h, h2) orelse return null };
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
            2 => 8,
            3 => 12,
            4 => 10,
            5 => 14,
            else => return null,
        }) << 20) | (n << 16) | (d << 12) | (bits(h2, 4, 2) << 10) | m };
        // LSL/LSR/ASR/ROR{S} by register: MOV{S} with a register-shifted operand
        if (h2 & 0xf0 == 0 and n < 15) return .{ .w = 0xe1a0_0010 | (bits(h, 4, 1) << 20) | (d << 12) | (m << 8) | (bits(h, 5, 2) << 5) | n };
        return null;
    }
    if (h2 & 0x8000 != 0) return null;
    if (h & 0xfff0 == 0xeac0 and h2 & 0x10 == 0) {
        // PKHBT/PKHTB
        if (n == 15 or d == 15 or m == 15) return null;
        return .{ .w = 0xe680_0010 | (n << 16) | (d << 12) | (((bits(h2, 12, 3) << 2) | bits(h2, 6, 2)) << 7) | (bits(h2, 5, 1) << 6) | m };
    }
    if (h & 0xff50 == 0xf300 and h2 & 0x20 == 0) {
        // SSAT/USAT; an arithmetic shift by zero is SSAT16/USAT16 instead
        const amount = (bits(h2, 12, 3) << 2) | bits(h2, 6, 2);
        if (n == 15 or d == 15 or (h & 0x20 != 0 and amount == 0)) return null;
        return .{ .w = (if (h & 0x80 != 0) @as(u32, 0xe6e0_0010) else 0xe6a0_0010) | ((h2 & 31) << 16) | (d << 12) | (amount << 7) | (bits(h, 5, 1) << 6) | n };
    }
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

/// The multiplies (0xfb00-0xfbff but SDIV/UDIV), as ARM words with Thumb's d in 19:16, a in
/// 15:12, m in 11:8 and n in 3:0; ARM's Ra = 15 drops the accumulator as Thumb's does. Long
/// forms put RdLo in a, RdHi in d.
pub fn multiply(h: u32, h2: u32) ?u32 {
    const n = h & 15;
    const d = bits(h2, 8, 4);
    const m = h2 & 15;
    const a = h2 >> 12;
    if (n == 15 or m == 15 or d == 15) return null;
    const regs = (d << 16) | (m << 8) | n;
    const acc = a << 12;
    const x = bits(h2, 4, 1);
    // SMLA<x><y> and SMLAL<x><y>: Thumb's N (bit 5) and M (bit 4) are ARM's bits 5 and 6
    const halves = (x << 6) | (bits(h2, 5, 1) << 5);
    const op = bits(h, 4, 4);
    if (op >= 8) {
        // SMULL, UMULL, SMLAL, UMLAL, UMAAL, SMLAL<x><y>, SMLALD and SMLSLD into RdHi:RdLo
        if (a == 15 or a == d) return null;
        return regs | acc | @as(u32, switch (h2 & 0xf0) {
            0 => if (op & 1 == 0) 0xe080_0090 | (if (op & 2 == 0) @as(u32, 1 << 22) else 0) | (if (op & 4 != 0) @as(u32, 1 << 21) else 0) else return null,
            0x60 => if (op == 14) 0xe040_0090 else return null,
            0x80, 0x90, 0xa0, 0xb0 => if (op == 12) 0xe140_0080 | halves else return null,
            0xc0, 0xd0 => if (op == 12 or op == 13) 0xe740_0010 | ((op & 1) << 6) | (x << 5) else return null,
            else => return null,
        });
    }
    if (op == 0) {
        // MUL, MLA and MLS
        if (h2 & 0xe0 != 0 or (x == 1 and a == 15)) return null;
        return regs | @as(u32, if (x == 1) 0xe060_0090 | acc else if (a == 15) 0xe000_0090 else 0xe020_0090 | acc);
    }
    if (h2 & @as(u32, if (op == 1) 0xc0 else if (op == 7) 0xf0 else 0xe0) != 0) return null;
    return regs | @as(u32, switch (op) {
        1 => 0xe100_0080 | halves | (if (a == 15) @as(u32, 0x0060_0000) else acc),
        // SMLAD, SMLSD; SMLAW<y> (SMULW<y> with ARM's bit 5); SMMLA, SMMLS; USADA8
        2, 4 => 0xe700_0010 | ((op & 4) << 4) | (x << 5) | acc,
        3 => 0xe120_0080 | (x << 6) | (if (a == 15) @as(u32, 0x20) else acc),
        5, 6 => if (op == 6 and a == 15) return null else 0xe750_0010 | (if (op == 6) @as(u32, 0xc0) else 0) | (x << 5) | acc,
        else => 0xe780_0010 | acc,
    });
}

/// The data-processing forms with a modified immediate or a shifted register, in arm.zig's
/// thumbData order. n = 15 turns ORR/ORN into MOV/MVN; d = 15 with S turns AND, EOR, ADD and SUB
/// into TST, TEQ, CMN and CMP. ORN is ORR of the inverted operand.
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
        2, 3 => 12,
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
    const invert = op == 3 and !move;
    if (shifted) {
        if (m == 15) return null;
        const shift = (bits(h2, 12, 3) << 2) | bits(h2, 6, 2);
        return .{ .w = base | (shift << 7) | (bits(h2, 4, 2) << 5) | m, .invert = invert };
    }
    const imm = expandImm(h, h2);
    return .{ .w = base | (1 << 25) | (@as(u32, @intFromBool(imm.carry != null)) << 8), .imm = imm, .invert = invert };
}

/// An IT body compiles as itself, or as the ARM word without S for a 16-bit form that sets flags
/// only outside an IT block.
pub const ItBody = union(enum) { thumb, arm: u32 };
/// The 16-bit forms jit32.emitThumb compiles in an IT block without a fallback or a branch.
pub fn itBody16(h: u32) ?ItBody {
    const d = h & 7;
    const m = (h >> 3) & 7;
    switch (h >> 12) {
        0, 1 => {
            const o = (h >> 11) & 3;
            // LSL/LSR/ASR #imm as MOV with a shifted operand; ADD/SUB with a register or imm3
            if (o < 3) return .{ .arm = 0xe1a0_0000 | (d << 12) | (bits(h, 6, 5) << 7) | (o << 5) | m };
            return .{ .arm = (if (h & 0x200 != 0) @as(u32, 0xe040_0000) else 0xe080_0000) | ((h & 0x400) << 15) | (m << 16) | (d << 12) | bits(h, 6, 3) };
        },
        2, 3 => {
            const r8 = bits(h, 8, 3);
            return switch (bits(h, 11, 2)) {
                0 => .{ .arm = 0xe3a0_0000 | (r8 << 12) | (h & 255) },
                1 => .thumb,
                2 => .{ .arm = 0xe280_0000 | (r8 << 16) | (r8 << 12) | (h & 255) },
                else => .{ .arm = 0xe240_0000 | (r8 << 16) | (r8 << 12) | (h & 255) },
            };
        },
        4 => {
            if (h & 0xfc00 == 0x4000) {
                const op = bits(h, 6, 4);
                // Rd op= Rm; the shifts by register as MOV Rd, Rd, <shift> Rm and NEG as RSB #0
                return switch (op) {
                    8, 10, 11 => .thumb,
                    2, 3, 4, 7 => .{ .arm = 0xe1a0_0010 | (d << 12) | (m << 8) | ((if (op == 7) 3 else op - 2) << 5) | d },
                    9 => .{ .arm = 0xe260_0000 | (m << 16) | (d << 12) },
                    13 => .{ .arm = 0xe000_0090 | (d << 16) | (d << 8) | m },
                    15 => .{ .arm = 0xe1e0_0000 | (d << 12) | m },
                    else => .{ .arm = @as(u32, switch (op) {
                        0 => 0xe000_0000,
                        1 => 0xe020_0000,
                        5 => 0xe0a0_0000,
                        6 => 0xe0c0_0000,
                        12 => 0xe180_0000,
                        else => 0xe1c0_0000,
                    }) | (d << 16) | (d << 12) | m },
                };
            }
            // ADD/CMP/MOV with high registers, except those writing PC; LDR literal
            const o = bits(h, 8, 2);
            return if (h & 0xfc00 != 0x4400 or o == 1 or (o != 3 and (d | ((h >> 4) & 8)) != 15)) .thumb else null;
        },
        5, 6, 7, 8, 9, 10, 12 => return .thumb,
        11 => {
            if (h & 0xff00 == 0xb000 or h & 0xfe00 == 0xb400 or h & 0xff00 == 0xbc00) return .thumb;
            return switch (h & 0xffc0) {
                0xb200, 0xb240, 0xb280, 0xb2c0, 0xba00, 0xba40, 0xbac0 => .thumb,
                else => null,
            };
        },
        else => return null,
    }
}
