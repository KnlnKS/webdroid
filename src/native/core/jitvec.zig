const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const simd = @import("simd.zig");
const wasm = @import("wasm.zig");
const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
const Emit = jit.Emit(true);
const O = wasm.Op;
const S = wasm.Simd;
const get = wasm.get;
const set = wasm.set;
const tee = wasm.tee;
const c32 = wasm.c32;
const c64 = wasm.c64;
const mo = wasm.mo;
const sv = wasm.simd;
const vm = wasm.vm;
const L_CPU = jit.L_CPU;
const L_A = jit.L_A;
const L_B = jit.L_B;
const OFF_FPSR = @offsetOf(cpu.Cpu, "fpsr");
const vreg = @import("jitreg.zig");
const voff = vreg.voff;
const zeroTop = vreg.zeroTop;
const vget = vreg.vget;
const vput = vreg.vput;
const maskLowHalf = vreg.maskLowHalf;

fn setQIf(e: *Emit) void {
    const b = e.b;
    b.blockStart(O.if_, wasm.VOID);
    b.emit(.{ get(L_CPU), get(L_CPU), mo(O.i32_load, OFF_FPSR), c32(1 << 27), O.i32_or, mo(O.i32_store, OFF_FPSR), O.end });
}
fn vectorConst(e: *Emit, esz: u32, value: u64) void {
    var bytes: [16]u8 = [_]u8{0} ** 16;
    const width: usize = @as(usize, 1) << @intCast(esz);
    for (0..16 / width) |i| {
        for (0..width) |j| bytes[i * width + j] = @truncate(value >> @intCast(8 * j));
    }
    e.b.emit(.{sv(S.const_)});
    e.b.bytes(&bytes);
}
fn saturatedBinop(e: *Emit, rn: u8, rm: u8, size: u32, q: bool, op: u8, wrapping: u8) void {
    vget(e, rn);
    vget(e, rm);
    e.b.emit(.{sv(op)});
    vget(e, rn);
    vget(e, rm);
    e.b.emit(.{ sv(wrapping), sv(S.ne[size]) });
    if (!q) maskLowHalf(e);
    e.b.emit(.{sv(S.any_true)});
    setQIf(e);
}
fn saturatedBinop32(e: *Emit, rd: u8, rn: u8, rm: u8, q: bool, unsigned: bool, subtract: bool) void {
    const b = e.b;
    vget(e, rn);
    vget(e, rm);
    b.emit(.{ sv(if (subtract) S.sub[2] else S.add[2]), set(jit.L_VA) });
    if (unsigned) {
        vget(e, if (subtract) rm else rn);
        if (subtract) vget(e, rn) else b.get(jit.L_VA);
        b.emit(.{sv(S.gt_u[2])});
    } else {
        vget(e, rn);
        if (subtract) vget(e, rm) else b.get(jit.L_VA);
        b.emit(.{sv(S.xor)});
        vget(e, if (subtract) rn else rm);
        b.get(jit.L_VA);
        b.emit(.{ sv(S.xor), sv(S.and_), c32(31), sv(S.shr_s[2]) });
    }
    b.set(jit.L_VB);
    b.get(jit.L_VB);
    if (!q) maskLowHalf(e);
    b.emit(.{sv(S.any_true)});
    setQIf(e);
    b.get(L_CPU);
    if (unsigned) vectorConst(e, 2, if (subtract) 0 else 0xffff_ffff) else {
        vget(e, rn);
        b.emit(.{ c32(31), sv(S.shr_s[2]) });
        vectorConst(e, 2, 0x7fff_ffff);
        b.emit(.{sv(S.xor)});
    }
    b.emit(.{ get(jit.L_VA), get(jit.L_VB), sv(S.bitselect) });
    vput(e, rd, q);
}
const NarrowKind = enum { signed, unsigned, signed_to_unsigned };
fn narrowMax(size: u32) u64 {
    const target_bits: u6 = @intCast(@as(u32, 8) << @intCast(size));
    return (@as(u64, 1) << target_bits) - 1;
}
fn emitSaturatedNarrow(e: *Emit, rn: u8, size: u32, kind: NarrowKind) void {
    vget(e, rn);
    if (kind == .signed_to_unsigned) {
        vectorConst(e, size + 1, 0);
        e.b.emit(.{sv(S.max_s[size + 1])});
    } else if (kind == .unsigned) {
        vectorConst(e, size + 1, narrowMax(size));
        e.b.emit(.{sv(S.min_u[size + 1])});
    }
    vectorConst(e, size + 1, 0);
    e.b.emit(.{sv(if (kind == .signed) S.narrow_s[size] else S.narrow_u[size])});
}
fn writeNarrow(e: *Emit, rd: u8, q: bool) void {
    const b = e.b;
    b.get(L_CPU);
    b.get(jit.L_VA);
    if (q) b.emit(.{ vm(S.store64_lane, voff(rd) + 8), 0 }) else vput(e, rd, false);
}
fn putNarrow(e: *Emit, rd: u8, rn: u8, size: u32, q: bool, kind: NarrowKind) void {
    emitSaturatedNarrow(e, rn, size, kind);
    e.b.set(jit.L_VA);
    e.b.emit(.{ get(jit.L_VA), sv(S.extend_low_s[size] + @as(u8, if (kind == .signed) 0 else 2)) });
    vget(e, rn);
    e.b.emit(.{ sv(S.ne[size + 1]), sv(S.any_true) });
    setQIf(e);
    writeNarrow(e, rd, q);
}
fn emitRoundedShift(e: *Emit, rn: u8, size: u32, amount: u32, round: bool, unsigned: bool) void {
    const shift = if (unsigned) S.shr_u[size] else S.shr_s[size];
    vget(e, rn);
    e.b.emit(.{ c32(@intCast(amount)), sv(shift) });
    if (!round) return;
    vget(e, rn);
    e.b.emit(.{ c32(@intCast(amount - 1)), sv(shift) });
    vectorConst(e, size, 1);
    e.b.emit(.{ sv(S.and_), sv(S.add[size]) });
}
fn narrowShifted(e: *Emit, size: u32, kind: NarrowKind) void {
    if (kind == .signed_to_unsigned) {
        vectorConst(e, size + 1, 0);
        e.b.emit(.{sv(S.max_s[size + 1])});
    }
    if (kind != .signed) {
        vectorConst(e, size + 1, narrowMax(size));
        e.b.emit(.{sv(S.min_u[size + 1])});
    }
    vectorConst(e, size + 1, 0);
    e.b.emit(.{sv(if (kind == .signed) S.narrow_s[size] else S.narrow_u[size])});
}
fn putShiftNarrow(e: *Emit, rd: u8, rn: u8, size: u32, amount: u32, round: bool, kind: NarrowKind, q: bool) void {
    const b = e.b;
    emitRoundedShift(e, rn, size + 1, amount, round, kind == .unsigned);
    b.emit(.{tee(jit.L_VB)});
    narrowShifted(e, size, kind);
    b.set(jit.L_VA);
    b.emit(.{ get(jit.L_VA), sv(S.extend_low_s[size] + @as(u8, if (kind == .signed) 0 else 2)), get(jit.L_VB),
        sv(S.ne[size + 1]), sv(S.any_true) });
    setQIf(e);
    writeNarrow(e, rd, q);
}
fn shuffle(e: *Emit, rn: u8, rm: u8, lanes: *const [16]u8) void {
    e.b.get(L_CPU);
    vget(e, rn);
    vget(e, rm);
    e.b.emit(.{sv(S.shuffle)});
    e.b.bytes(lanes);
}
inline fn narrowByte(k: usize, es: usize) usize {
    return (k / es) * 2 * es + k % es;
}
fn lane(tab: [4]u8, esz: u32) ?u8 {
    return if (tab[esz] == 0) null else tab[esz];
}
fn emitVariableShift16(e: *Emit, rd: u8, rn: u8, rm: u8, q: bool, unsigned: bool, round: bool) void {
    const b = e.b;
    for (0..(if (q) @as(usize, 8) else 4)) |i| {
        vget(e, rm);
        b.emit(.{ sv(S.extract_s[0]), @as(u8, @intCast(i * 2)), set(L_A) });
        vget(e, rn);
        b.emit(.{ sv(if (unsigned) S.extract_u[1] else S.extract_s[1]), @as(u8, @intCast(i)), set(L_B) });
        b.emit(.{ get(L_CPU), get(L_CPU), vm(S.load, voff(rd)), get(L_B), get(L_A), O.i32_shl, get(L_B) });
        if (round) b.emit(.{ c32(1), c32(0), get(L_A), O.i32_sub, c32(1), O.i32_sub, O.i32_shl, O.i32_add });
        b.emit(.{ c32(0), get(L_A), O.i32_sub, if (unsigned) O.i32_shr_u else O.i32_shr_s,
            get(L_A), c32(0), O.i32_ge_s, O.select,
            c32(0), get(L_A), c32(-16), if (round) O.i32_ge_s else O.i32_gt_s,
            get(L_A), c32(16), O.i32_lt_s, O.i32_and, O.select,
            sv(S.replace[1]), @as(u8, @intCast(i)), vm(S.store, voff(rd)) });
    }
    if (!q) zeroTop(e, rd, true);
}
fn emitSqrshl32(e: *Emit, rd: u8, rn: u8, rm: u8, q: bool) void {
    const b = e.b;
    vectorConst(e, 2, 0);
    b.set(jit.L_VB);
    for (0..(if (q) @as(usize, 4) else 2)) |i| {
        b.get(jit.L_VB);
        vget(e, rm);
        b.emit(.{ sv(S.extract_s[0]), @as(u8, @intCast(i * 4)), set(L_A) });
        vget(e, rn);
        b.emit(.{ sv(S.extract_s[2]), @as(u8, @intCast(i)), set(L_B) });
        b.emit(.{ get(L_A), c32(0), O.i32_ge_s });
        b.blockStart(O.if_, wasm.I32);
        b.emit(.{ get(L_B), O.i64_extend_i32_s,
            get(L_A), c32(32), get(L_A), c32(32), O.i32_lt_s, O.select, O.i64_extend_i32_u,
            O.i64_shl, tee(jit.L_T0), O.i32_wrap_i64, tee(jit.L_R), O.i64_extend_i32_s,
            get(jit.L_T0), O.i64_ne, tee(jit.L_NEXT) });
        setQIf(e);
        b.emit(.{ c32(-2147483648), c32(2147483647), get(L_B), c32(0), O.i32_lt_s, O.select,
            get(jit.L_R), get(jit.L_NEXT), O.select, O.else_,
            get(L_A), c32(-32), O.i32_lt_s });
        b.blockStart(O.if_, wasm.I32);
        b.i32c(0);
        b.byte(O.else_);
        b.emit(.{ get(L_B), O.i64_extend_i32_s, c64(1),
            c32(0), get(L_A), O.i32_sub, c32(1), O.i32_sub, O.i64_extend_i32_u, O.i64_shl,
            O.i64_add, c32(0), get(L_A), O.i32_sub, O.i64_extend_i32_u, O.i64_shr_s, O.i32_wrap_i64, O.end, O.end,
            sv(S.replace[2]), @as(u8, @intCast(i)), set(jit.L_VB) });
    }
    b.emit(.{ get(L_CPU), get(jit.L_VB) });
    vput(e, rd, q);
}
fn halvingOperand(e: *Emit, rm: u8, subtract: bool) void {
    vget(e, rm);
    if (subtract) e.b.emit(.{sv(S.not)});
}
fn emitHalving(e: *Emit, rd: u8, rn: u8, rm: u8, size: u32, q: bool, unsigned: bool, round: bool, subtract: bool) void {
    const b = e.b;
    b.get(L_CPU);
    if (unsigned and round and !subtract and size < 2) {
        vget(e, rn);
        vget(e, rm);
        b.emit(.{sv(S.avgr_u[size])});
    } else {
        vget(e, rn);
        halvingOperand(e, rm, subtract);
        b.emit(.{sv(S.and_)});
        vget(e, rn);
        halvingOperand(e, rm, subtract);
        b.emit(.{ sv(S.xor), c32(1), sv(if (unsigned) S.shr_u[size] else S.shr_s[size]), sv(S.add[size]) });
        if (round) {
            vget(e, rn);
            halvingOperand(e, rm, subtract);
            b.emit(.{sv(S.xor)});
            vectorConst(e, size, 1);
            b.emit(.{ sv(S.and_), sv(S.add[size]) });
        }
    }
    vput(e, rd, q);
}
fn promoteF32Half(e: *Emit, reg: u8, high: bool) void {
    vget(e, reg);
    if (high) e.b.emit(.{ sv(S.extract_u[3]), @as(u8, 1), sv(S.splat[3]) });
    e.b.emit(.{sv(S.f64x2_promote_low_f32x4)});
}
fn emitFma32Half(e: *Emit, rd: u8, rn: u8, rm: u8, high: bool, subtract: bool, element: ?u8) void {
    const b = e.b;
    promoteF32Half(e, rn, high);
    if (subtract) b.emit(.{sv(S.fneg[1])});
    if (element) |idx| {
        vget(e, rm);
        b.emit(.{ sv(S.fextract[0]), idx, sv(S.fsplat[0]), sv(S.f64x2_promote_low_f32x4) });
    } else promoteF32Half(e, rm, high);
    b.emit(.{sv(S.fmul[1])});
    promoteF32Half(e, rd, high);
    b.emit(.{ sv(S.fadd[1]), sv(S.f32x4_demote_f64x2_zero) });
}
fn emitFma32(e: *Emit, rd: u8, rn: u8, rm: u8, q: bool, subtract: bool, element: ?u8) void {
    const b = e.b;
    b.get(L_CPU);
    emitFma32Half(e, rd, rn, rm, false, subtract, element);
    if (q) {
        emitFma32Half(e, rd, rn, rm, true, subtract, element);
        b.emit(.{sv(S.shuffle)});
        b.bytes(&[_]u8{ 0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23 });
    }
    vput(e, rd, q);
}
inline fn emitThreeSame(e: *Emit, w: u32) bool {
    const b = e.b;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const q = bits(w, 30, 1) != 0;
    const U = bits(w, 29, 1) != 0;
    const size = bits(w, 22, 2);
    const opcode = bits(w, 11, 5);
    if ((opcode == 1 or opcode == 5) and size == 2) {
        saturatedBinop32(e, rd, rn, rm, q, U, opcode == 5);
        return true;
    }
    if (size == 1 and ((opcode == 8 and U) or opcode == 10)) {
        emitVariableShift16(e, rd, rn, rm, q, U, opcode == 10);
        return true;
    }
    if (size == 2 and !U and opcode == 11) {
        emitSqrshl32(e, rd, rn, rm, q);
        return true;
    }
    if ((opcode == 0 or opcode == 2 or (opcode == 4 and !U)) and size < 3) {
        // Signed halving subtraction is ceil((n + ~m) / 2).
        emitHalving(e, rd, rn, rm, size, q, U, opcode != 0, opcode == 4);
        return true;
    }
    if (((opcode == 20 or opcode == 21) and size < 3) or (opcode == 23 and !U and (size < 3 or q))) {
        const es: usize = @as(usize, 1) << @intCast(size);
        const count: usize = (if (q) @as(usize, 16) else 8) / es;
        var even: [16]u8 = [_]u8{0} ** 16;
        var odd: [16]u8 = [_]u8{0} ** 16;
        for (0..count) |i| {
            const source = if (i < count / 2) @as(usize, 0) else 16;
            const pair = (i % (count / 2)) * 2;
            for (0..es) |j| {
                even[i * es + j] = @intCast(source + pair * es + j);
                odd[i * es + j] = @intCast(source + (pair + 1) * es + j);
            }
        }
        b.get(L_CPU);
        vget(e, rn);
        vget(e, rm);
        b.emit(.{sv(S.shuffle)});
        b.bytes(&even);
        vget(e, rn);
        vget(e, rm);
        b.emit(.{sv(S.shuffle)});
        b.bytes(&odd);
        const pairOp = switch (opcode) {
            20 => if (U) S.max_u[size] else S.max_s[size],
            21 => if (U) S.min_u[size] else S.min_s[size],
            else => S.add[size],
        };
        b.emit(.{sv(pairOp)});
        vput(e, rd, q);
        return true;
    }
    if (opcode == 14 and size < 3) {
        b.get(L_CPU);
        vget(e, rn);
        vget(e, rm);
        b.emit(.{sv(S.sub[size])});
        vget(e, rm);
        vget(e, rn);
        b.emit(.{sv(S.sub[size])});
        vget(e, rn);
        vget(e, rm);
        b.emit(.{ sv(if (U) S.gt_u[size] else S.gt_s[size]), sv(S.bitselect) });
        vput(e, rd, q);
        return true;
    }
    if (opcode >= 24) {
        const dp = size & 1 != 0;
        const fv = size & 2 != 0;
        const f: u32 = @intFromBool(dp);
        if (opcode == 25 and !U and !dp) {
            emitFma32(e, rd, rn, rm, q, fv, null);
            return true;
        }
        if (opcode == 27 and !U) {
            fmulx(e, rn, rm, dp);
            vput(e, rd, q);
            return true;
        }
        const op: u8 = switch (opcode) {
            26 => if (!U) (if (fv) S.fsub[f] else S.fadd[f]) else if (fv) S.fsub[f] else return false,
            27 => S.fmul[f],
            31 => if (U) S.fdiv[f] else return false,
            28 => if (!U) S.feq[f] else if (fv) S.fgt[f] else S.fge[f],
            30 => if (!U) (if (fv) S.fmin[f] else S.fmax[f]) else return false,
            else => return false,
        };
        b.get(L_CPU);
        vget(e, rn);
        vget(e, rm);
        b.emit(.{sv(op)});
        if (opcode == 26 and U) b.emit(.{sv(S.fabs[f])});
        vput(e, rd, q);
        return true;
    }
    const op: ?u8 = switch (opcode) {
        1 => if (size < 2) (if (U) S.add_sat_u[size] else S.add_sat_s[size]) else null,
        5 => if (size < 2) (if (U) S.sub_sat_u[size] else S.sub_sat_s[size]) else null,
        16 => lane(if (U) S.sub else S.add, size),
        17 => if (U) lane(S.eq, size) else lane(S.ne, size),
        6 => lane(if (U) S.gt_u else S.gt_s, size),
        7 => lane(if (U) S.ge_u else S.ge_s, size),
        19 => if (U) null else lane(S.mul, size),
        18 => lane(S.mul, size),
        12 => lane(if (U) S.max_u else S.max_s, size),
        13 => lane(if (U) S.min_u else S.min_s, size),
        else => null,
    };
    const o = op orelse return false;
    b.get(L_CPU);
    if (opcode == 1 or opcode == 5) {
        saturatedBinop(e, rn, rm, size, q, o, if (opcode == 1) S.add[size] else S.sub[size]);
        vget(e, rn);
        vget(e, rm);
        b.emit(.{sv(o)});
        vput(e, rd, q);
        return true;
    }
    if (opcode == 18) vget(e, rd);
    vget(e, rn);
    vget(e, rm);
    if (opcode == 17 and !U) {
        b.emit(.{ sv(S.and_), sv(S.const_) });
        b.bytes(&[_]u8{0} ** 16);
    }
    b.emit(.{sv(o)});
    if (opcode == 18) b.emit(.{sv(lane(if (U) S.sub else S.add, size).?)});
    vput(e, rd, q);
    return true;

}

inline fn emitTwoRegister(e: *Emit, w: u32) bool {
    const b = e.b;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const q = bits(w, 30, 1) != 0;
    const U = bits(w, 29, 1) != 0;
    const size = bits(w, 22, 2);
    const opcode = bits(w, 12, 5);
    const fv = size & 2 != 0;
    const dp = size & 1 != 0;
    const f: u32 = @intFromBool(dp);
    if ((opcode == 2 or opcode == 6) and size < 3) {
        const es: usize = @as(usize, 1) << @intCast(size);
        const pairs = (if (q) @as(usize, 16) else 8) / (2 * es);
        b.get(L_CPU);
        if (opcode == 6) vget(e, rd);
        for (0..2) |odd| {
            var lanes: [16]u8 = [_]u8{16} ** 16;
            for (0..pairs) |i| {
                for (0..es) |j| lanes[i * es + j] = @intCast((2 * i + odd) * es + j);
            }
            vget(e, rn);
            vectorConst(e, 0, 0);
            b.emit(.{sv(S.shuffle)});
            b.bytes(&lanes);
            b.emit(.{sv(S.extend_low_s[size] + @as(u8, if (U) 2 else 0))});
        }
        b.emit(.{sv(S.add[size + 1])});
        if (opcode == 6) b.emit(.{sv(S.add[size + 1])});
        vput(e, rd, q);
        return true;
    }
    if (opcode == 22 and !U and size == 1) {
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{sv(S.f32x4_demote_f64x2_zero)});
        if (q) {
            var lanes: [16]u8 = undefined;
            for (0..16) |i| lanes[i] = @intCast(if (i < 8) 16 + i else i - 8);
            vget(e, rd);
            b.emit(.{sv(S.shuffle)});
            b.bytes(&lanes);
        }
        vput(e, rd, q);
        return true;
    }
    // FCMGT/FCMGE, FCMEQ/FCMLE and FCMLT against zero
    if (opcode >= 12 and opcode <= 14 and fv and !(opcode == 14 and U) and (q or !dp)) {
        const zero_first = opcode == 14 or (opcode == 13 and U);
        b.get(L_CPU);
        if (zero_first) vectorConst(e, 0, 0);
        vget(e, rn);
        if (!zero_first) vectorConst(e, 0, 0);
        b.emit(.{sv(if (opcode == 13 and !U) S.feq[f] else if (opcode == 14 or !U) S.fgt[f] else S.fge[f])});
        vput(e, rd, q);
        return true;
    }
    // SCVTF/UCVTF on 64-bit lanes, which wasm only converts a lane at a time
    if (opcode == 29 and !fv and dp and q) {
        const cvt: u8 = if (U) O.f64_convert_i64_u else O.f64_convert_i64_s;
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{ sv(S.extract_s[3]), @as(u8, 0), cvt, sv(S.fsplat[1]) });
        vget(e, rn);
        b.emit(.{ sv(S.extract_s[3]), @as(u8, 1), cvt, sv(S.freplace[1]), @as(u8, 1) });
        vput(e, rd, true);
        return true;
    }
    if (opcode >= 22 or (opcode >= 12 and opcode <= 15 and fv)) {
        const op: u8 = switch (opcode) {
            15 => if (fv) (if (U) S.fneg[f] else S.fabs[f]) else return false,
            31 => if (U) S.fsqrt[f] else return false,
            24 => if (U) return false else if (fv) S.fceil[f] else S.fnearest[f],
            25 => if (U) return false else if (fv) S.ftrunc[f] else S.ffloor[f],
            29 => if (fv or dp) return false else if (U) S.f32x4_convert_i32x4_u else S.f32x4_convert_i32x4_s,
            27 => if (!fv or dp) return false else if (U) S.i32x4_trunc_sat_f32x4_u else S.i32x4_trunc_sat_f32x4_s,
            else => return false,
        };
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{sv(op)});
        vput(e, rd, q);
        return true;
    }
    if (opcode == 11 or (opcode == 5 and !U and size == 0)) {
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{sv(if (opcode == 5) S.popcnt else if (U) S.neg[size] else S.neg[size] - 1)});
        vput(e, rd, q);
        return true;
    }
    if (opcode == 19 and U and size < 3) {
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{ sv(S.extend_low_s[size] + @as(u8, if (q) 3 else 2)), c32(@intCast(@as(u32, 8) << @intCast(size))), sv(S.shl[size + 1]) });
        vput(e, rd, true);
        return true;
    }
    const es: usize = @as(usize, 1) << @intCast(size);
    var lanes: [16]u8 = undefined;
    if (opcode <= 1) {
        const group: usize = if (opcode == 1) 2 else if (U) 4 else 8;
        if (es >= group) return false;
        const per = group / es;
        for (0..16) |i| {
            const el = i / es;
            const r = el % per;
            lanes[i] = @intCast((el - r + (per - 1 - r)) * es + i % es);
        }
        shuffle(e, rn, rn, &lanes);
        vput(e, rd, q);
        return true;
    }
    if ((opcode == 20 or (opcode == 18 and U)) and size < 2) {
        const kind: NarrowKind = if (opcode == 18) .signed_to_unsigned else if (U) .unsigned else .signed;
        putNarrow(e, rd, rn, size, q, kind);
        return true;
    }
    if (opcode == 18 and !U and size != 3) {
        for (0..16) |i| lanes[i] = @intCast(if (i < 8) (if (q) 16 + i else narrowByte(i, es)) else if (q) narrowByte(i - 8, es) else 0);
        shuffle(e, rn, rd, &lanes);
        vput(e, rd, q);
        return true;
    }
    return false;

}

inline fn emitShiftImmediate(e: *Emit, w: u32) bool {
    const b = e.b;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const q = bits(w, 30, 1) != 0;
    const U = bits(w, 29, 1) != 0;
    const immh = bits(w, 19, 4);
    const esz: u32 = if (immh & 8 != 0) 3 else if (immh & 4 != 0) 2 else if (immh & 2 != 0) 1 else 0;
    const bitsT: u32 = @as(u32, 8) << @intCast(esz);
    const opcode = bits(w, 11, 5);
    const amount = (immh << 3) | bits(w, 16, 3);
    const shr = 2 * bitsT - amount;
    if ((opcode == 16 or opcode == 17) and !U and esz < 2 and shr < 2 * bitsT) {
        b.get(L_CPU);
        if (opcode == 16 and shr & 7 == 0) {
            const width: usize = @as(usize, 1) << @intCast(esz);
            var lanes: [16]u8 = [_]u8{16} ** 16;
            for (0..8 / width) |i| {
                for (0..width) |j| lanes[i * width + j] = @intCast(i * 2 * width + shr / 8 + j);
            }
            vget(e, rn);
            vectorConst(e, 0, 0);
            b.emit(.{sv(S.shuffle)});
            b.bytes(&lanes);
            if (q) b.emit(.{ vm(S.store64_lane, voff(rd) + 8), 0 }) else vput(e, rd, false);
            return true;
        }
        emitRoundedShift(e, rn, esz + 1, shr, opcode == 17, true);
        vectorConst(e, esz + 1, narrowMax(esz));
        b.emit(.{sv(S.and_)});
        vectorConst(e, esz + 1, 0);
        b.emit(.{sv(S.narrow_u[esz])});
        if (q) b.emit(.{ vm(S.store64_lane, voff(rd) + 8), 0 }) else vput(e, rd, false);
        return true;
    }
    if (opcode >= 16 and opcode <= 19 and esz < 2) {
        const kind: NarrowKind = if (opcode < 18) (if (U) .signed_to_unsigned else return false) else if (U) .unsigned else .signed;
        putShiftNarrow(e, rd, rn, esz, shr, opcode & 1 != 0, kind, q);
        return true;
    }
    if (opcode == 4 and shr < bitsT) {
        b.get(L_CPU);
        emitRoundedShift(e, rn, esz, shr, true, U);
        vput(e, rd, q);
        return true;
    }
    if ((opcode == 2 or opcode == 6) and shr < bitsT) {
        b.get(L_CPU);
        vget(e, rd);
        emitRoundedShift(e, rn, esz, shr, opcode == 6, U);
        b.emit(.{sv(S.add[esz])});
        vput(e, rd, q);
        return true;
    }
    if (opcode == 14 and U and esz < 3) {
        const shift = amount - bitsT;
        const max = narrowMax(esz) >> @intCast(shift);
        vget(e, rn);
        vectorConst(e, esz, max);
        b.emit(.{ sv(S.gt_u[esz]), set(jit.L_VB), get(jit.L_VB) });
        if (!q) maskLowHalf(e);
        b.emit(.{sv(S.any_true)});
        setQIf(e);
        b.get(L_CPU);
        vget(e, rn);
        vectorConst(e, esz, max);
        b.emit(.{ sv(S.min_u[esz]), c32(@intCast(shift)), sv(S.shl[esz]), get(jit.L_VB), sv(S.or_) });
        vput(e, rd, q);
        return true;
    }
    if (opcode == 20) {
        if (esz == 3) return false;
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{sv(S.extend_low_s[esz] + @as(u8, if (q) 1 else 0) + @as(u8, if (U) 2 else 0))});
        if (amount != bitsT) b.emit(.{ c32(@intCast(amount - bitsT)), sv(S.shl[esz + 1]) });
        b.emit(.{vm(S.store, voff(rd))});
        return true;
    }
    // SRI and SLI: the shifted bits of Vn replace those of Vd
    if (U and ((opcode == 8 and shr < bitsT) or opcode == 10)) {
        const ones: u64 = if (esz == 3) ~@as(u64, 0) else (@as(u64, 1) << @intCast(bitsT)) - 1;
        const left = opcode == 10;
        const shift = if (left) amount - bitsT else shr;
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{ c32(@intCast(shift)), sv(if (left) S.shl[esz] else S.shr_u[esz]) });
        vget(e, rd);
        vectorConst(e, esz, if (left) ones << @intCast(shift) else ones >> @intCast(shift));
        b.emit(.{sv(S.bitselect)});
        vput(e, rd, q);
        return true;
    }
    // FCVTZS/FCVTZU with fbits: scaling by 2^fbits is exact, so it truncates as the interpreter does
    if (opcode == 31 and esz == 2) {
        b.get(L_CPU);
        vget(e, rn);
        vectorConst(e, 2, (127 + shr) << 23);
        b.emit(.{ sv(S.fmul[0]), sv(if (U) S.i32x4_trunc_sat_f32x4_u else S.i32x4_trunc_sat_f32x4_s) });
        vput(e, rd, q);
        return true;
    }
    const op: u8 = switch (opcode) {
        0 => if (U) (if (shr >= bitsT) return false else S.shr_u[esz]) else S.shr_s[esz],
        10 => S.shl[esz],
        else => return false,
    };
    b.get(L_CPU);
    vget(e, rn);
    b.emit(.{ c32(@intCast(if (opcode == 10) amount - bitsT else @min(shr, bitsT - 1))), sv(op) });
    vput(e, rd, q);
    return true;

}

pub fn emitVector(e: *Emit, w: u32) bool {
    const b = e.b;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const q = bits(w, 30, 1) != 0;
    const U = bits(w, 29, 1) != 0;
    const size = bits(w, 22, 2);
    if (w & 0x1000_0000 != 0) return false;
    if (is(w, 0x9ff8_0400, 0x0f00_0400)) {
        const cmode = bits(w, 12, 4);
        const ex = simd.expandImm(bits(w, 29, 1), cmode, bits(w, 11, 1), (bits(w, 16, 3) << 5) | bits(w, 5, 5)) orelse return false;
        if (ex.kind == .fmov and U and !q) return false;
        const v: i64 = @bitCast(ex.v);
        for ([_]u32{ 0, 8 }) |off| {
            b.get(L_CPU);
            if (off == 8 and !q) b.i64c(0) else switch (ex.kind) {
                .orr, .bic => b.emit(.{ get(L_CPU), mo(O.i64_load, voff(rd) + off), c64(if (ex.kind == .orr) v else ~v), if (ex.kind == .orr) O.i64_or else O.i64_and }),
                .mvni => b.i64c(~v),
                else => b.i64c(v),
            }
            b.memop(O.i64_store, voff(rd) + off);
        }
        return true;
    }
    if (is(w, 0x9fe0_8400, 0x0e00_0400)) {
        const imm5 = bits(w, 16, 5);
        const imm4 = bits(w, 11, 4);
        if (imm5 & 15 == 0) return false;
        const esz: u32 = @ctz(imm5);
        const idx: u8 = @intCast(imm5 >> @intCast(esz + 1));
        if (U) {
            b.get(L_CPU);
            vget(e, rd);
            vget(e, rn);
            b.emit(.{ sv(S.extract_u[esz]), @as(u8, @intCast(imm4 >> @intCast(esz))), sv(S.replace[esz]), idx, vm(S.store, voff(rd)) });
            return true;
        }
        switch (imm4) {
            0 => {
                b.get(L_CPU);
                vget(e, rn);
                b.emit(.{ sv(S.extract_u[esz]), idx, sv(S.splat[esz]) });
                vput(e, rd, q);
            },
            1 => {
                b.get(L_CPU);
                e.getX(rn);
                if (esz < 3) b.byte(O.i32_wrap_i64);
                b.emit(.{sv(S.splat[esz])});
                vput(e, rd, q);
            },
            3 => {
                b.get(L_CPU);
                vget(e, rd);
                e.getX(rn);
                if (esz < 3) b.byte(O.i32_wrap_i64);
                b.emit(.{ sv(S.replace[esz]), idx, vm(S.store, voff(rd)) });
            },
            5, 7 => {
                if (esz == 3 and !q) return false;
                vget(e, rn);
                b.emit(.{ sv(if (imm4 == 5) S.extract_s[esz] else S.extract_u[esz]), idx });
                if (esz == 3) {
                    e.setX(rd);
                } else if (q) {
                    b.byte(if (imm4 == 5) O.i64_extend_i32_s else O.i64_extend_i32_u);
                    e.setX(rd);
                } else e.setW(rd);
            },
            else => return false,
        }
        return true;
    }
    if (is(w, 0xbfe0_8400, 0x2e00_0000)) {
        const imm = bits(w, 11, 4);
        if (!q and imm > 7) return false;
        var lanes: [16]u8 = undefined;
        for (0..16) |i| {
            const j = imm + i;
            lanes[i] = @intCast(if (q or j < 8) j else 8 + j);
        }
        shuffle(e, rn, rm, &lanes);
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0xbfe0_8c00, 0x0e00_0000)) {
        const len = bits(w, 13, 2) + 1;
        const tbx = bits(w, 12, 1) != 0;
        if (rn + len > 32) return false;
        b.get(L_CPU);
        for (0..len) |i| {
            vget(e, rn + @as(u8, @intCast(i)));
            vget(e, rm);
            if (i != 0) {
                vectorConst(e, 0, @intCast(16 * i));
                b.emit(.{sv(S.sub[0])});
            }
            b.emit(.{sv(S.swizzle)});
            if (i != 0) b.emit(.{sv(S.or_)});
        }
        if (tbx) {
            vget(e, rd);
            vget(e, rm);
            vectorConst(e, 0, @intCast(16 * len - 1));
            b.emit(.{ sv(S.gt_u[0]), sv(S.and_), sv(S.or_) });
        }
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0xbf20_8c00, 0x0e00_0800)) {
        const opcode = bits(w, 12, 3);
        if (opcode == 0 or opcode == 4 or (size == 3 and !q)) return false;
        const es: usize = @as(usize, 1) << @intCast(size);
        const count: usize = (if (q) @as(usize, 16) else 8) / es;
        var lanes: [16]u8 = [_]u8{0} ** 16;
        for (0..count) |el| {
            const src = simd.permuteIndex(opcode, count, el);
            for (0..es) |k| lanes[el * es + k] = @intCast((if (src.m) @as(usize, 16) else 0) + src.i * es + k);
        }
        shuffle(e, rn, rm, &lanes);
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0x9f20_fc00, 0x0e20_1c00)) {
        b.get(L_CPU);
        if (!U) {
            vget(e, rn);
            vget(e, rm);
            switch (size) {
                0 => b.emit(.{sv(S.and_)}),
                1 => b.emit(.{sv(S.andnot)}),
                2 => b.emit(.{sv(S.or_)}),
                else => b.emit(.{ sv(S.not), sv(S.or_) }),
            }
        } else if (size == 0) {
            vget(e, rn);
            vget(e, rm);
            b.emit(.{sv(S.xor)});
        } else {
            const order: [3]u8 = switch (size) {
                1 => .{ rn, rm, rd },
                2 => .{ rn, rd, rm },
                else => .{ rd, rn, rm },
            };
            for (order) |r| vget(e, r);
            b.emit(.{sv(S.bitselect)});
        }
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0xbfff_fc00, 0x2e20_5800)) {
        b.get(L_CPU);
        vget(e, rn);
        b.emit(.{sv(S.not)});
        vput(e, rd, q);
        return true;
    }
    if (is(w, 0x8f3e_0c00, 0x0e30_0800) and bits(w, 12, 5) == 3 and size < 3) {
        b.get(L_CPU);
        vget(e, rn);
        if (!q) maskLowHalf(e);
        if (size == 0) b.emit(.{sv(S.extadd_pairwise[0][@intFromBool(U)])});
        if (size < 2) b.emit(.{sv(S.extadd_pairwise[1][@intFromBool(U)])});
        b.set(jit.L_VA);
        for (0..4) |i| {
            b.emit(.{ get(jit.L_VA), sv(S.extract_u[2]), @as(u8, @intCast(i)) });
            if (size == 2) b.byte(if (U) O.i64_extend_i32_u else O.i64_extend_i32_s);
            if (i != 0) b.byte(if (size == 2) O.i64_add else O.i32_add);
        }
        if (size == 0) b.emit(.{ c32(0xffff), O.i32_and });
        b.memop(if (size == 2) O.i64_store else O.i32_store, voff(rd));
        zeroTop(e, rd, size == 2);
        return true;
    }
    if (is(w, 0x8f3e_0c00, 0x0e30_0800) and size < 3) {
        if (size == 2 and !q) return false;
        const op: u8 = switch (bits(w, 12, 5)) {
            10 => if (U) S.max_u[size] else S.max_s[size],
            26 => if (U) S.min_u[size] else S.min_s[size],
            27 => if (U) return false else S.add[size],
            else => return false,
        };
        // fold the upper half of the remaining lanes onto the lower until lane 0 holds the result
        b.get(L_CPU);
        vget(e, rn);
        var width: usize = if (q) 8 else 4;
        while (width >= @as(usize, 1) << @intCast(size)) : (width /= 2) {
            var lanes: [16]u8 = undefined;
            for (0..16) |i| lanes[i] = @intCast((i + width) & 15);
            b.emit(.{ tee(jit.L_VA), get(jit.L_VA), get(jit.L_VA), sv(S.shuffle) });
            b.bytes(&lanes);
            b.emit(.{sv(op)});
        }
        b.emit(.{ sv(S.extract_u[size]), @as(u8, 0) });
        b.memop(O.i32_store, voff(rd));
        zeroTop(e, rd, false);
        return true;
    }
    if (is(w, 0x9f20_0c00, 0x0e20_0000) and size < 3) {
        const opcode = bits(w, 12, 4);
        if ((opcode == 5 or opcode == 7) and size < 2) {
            const extend = S.extend_low_s[size] + @as(u8, if (q) 1 else 0) + @as(u8, if (U) 2 else 0);
            vget(e, rn);
            b.emit(.{ sv(extend), set(jit.L_VA) });
            vget(e, rm);
            b.emit(.{ sv(extend), set(jit.L_VB) });
            b.get(L_CPU);
            if (opcode == 5) vget(e, rd);
            b.emit(.{ get(jit.L_VA), get(jit.L_VB), sv(if (U) S.max_u[size + 1] else S.max_s[size + 1]),
                get(jit.L_VA), get(jit.L_VB), sv(if (U) S.min_u[size + 1] else S.min_s[size + 1]), sv(S.sub[size + 1]) });
            if (opcode == 5) b.emit(.{sv(S.add[size + 1])});
            vput(e, rd, true);
            return true;
        }
        if (opcode == 14 and !U and size == 0) {
            const extend = S.extend_low_s[0] + @as(u8, if (q) 3 else 2);
            vget(e, rn);
            b.emit(.{ sv(extend), set(jit.L_VA) });
            vget(e, rm);
            b.emit(.{ sv(extend), set(jit.L_VB) });
            b.get(L_CPU);
            vectorConst(e, 1, 0);
            for (0..8) |i| {
                b.get(jit.L_VA);
                if (i != 0) b.emit(.{ c32(@intCast(i)), sv(S.shl[1]) });
                b.get(jit.L_VB);
                if (i != 0) b.emit(.{ c32(@intCast(i)), sv(S.shr_u[1]) });
                vectorConst(e, 1, 1);
                b.emit(.{ sv(S.and_), sv(S.neg[1]), sv(S.and_), sv(S.xor) });
            }
            vput(e, rd, true);
            return true;
        }
        if (opcode > 3 and opcode != 8 and opcode != 10 and opcode != 12) return false;
        const extend = S.extend_low_s[size] + @as(u8, if (q) 1 else 0) + @as(u8, if (U) 2 else 0);
        const accumulate = opcode == 8 or opcode == 10;
        b.get(L_CPU);
        if (accumulate) vget(e, rd);
        vget(e, rn);
        if (opcode < 8 and opcode != 1 and opcode != 3) b.emit(.{sv(extend)});
        vget(e, rm);
        if (opcode >= 8) {
            b.emit(.{sv(S.extmul_low_s[size] + @as(u8, if (q) 1 else 0) + @as(u8, if (U) 2 else 0))});
        } else {
            b.emit(.{sv(extend)});
            b.emit(.{sv(if (opcode >= 2) S.sub[size + 1] else S.add[size + 1])});
        }
        if (accumulate) b.emit(.{sv(if (opcode == 10) S.sub[size + 1] else S.add[size + 1])});
        vput(e, rd, true);
        return true;
    }
    if (is(w, 0x9f20_0400, 0x0e20_0400)) return emitThreeSame(e, w);
    if (is(w, 0x9f3e_0c00, 0x0e20_0800)) return emitTwoRegister(e, w);
    if (is(w, 0x9f80_0400, 0x0f00_0400) and bits(w, 19, 4) != 0) return emitShiftImmediate(e, w);
    if (is(w, 0x9f00_0400, 0x0f00_0000)) {
        const opcode = bits(w, 12, 4);
        const Lb = bits(w, 21, 1);
        const M = bits(w, 20, 1);
        const H = bits(w, 11, 1);
        const rmLow = bits(w, 16, 4);
        if (opcode == 9 and !U) {
            if (size & 2 == 0) return false;
            const dp = size & 1 != 0;
            if (dp and Lb != 0) return false;
            const idx: u8 = @intCast(if (dp) H else (H << 1) | Lb);
            const f: u32 = @intFromBool(dp);
            b.get(L_CPU);
            vget(e, rn);
            vget(e, @intCast((M << 4) | rmLow));
            b.emit(.{ sv(S.fextract[f]), idx, sv(S.fsplat[f]), sv(S.fmul[f]) });
            vput(e, rd, q);
            return true;
        }
        if ((opcode == 1 or opcode == 5) and size == 2) {
            const idx: u8 = @intCast((H << 1) | Lb);
            const m: u8 = @intCast((M << 4) | rmLow);
            emitFma32(e, rd, rn, m, q, opcode == 5, idx);
            return true;
        }
        if (((opcode == 8 and !U) or ((opcode == 0 or opcode == 4) and U)) and (size == 1 or size == 2)) {
            const idx: u8 = @intCast(if (size == 1) (H << 2) | (Lb << 1) | M else (H << 1) | Lb);
            const m: u8 = @intCast(if (size == 1) rmLow else (M << 4) | rmLow);
            b.get(L_CPU);
            if (opcode != 8) vget(e, rd);
            vget(e, rn);
            vget(e, m);
            b.emit(.{ sv(S.extract_u[size]), idx, sv(S.splat[size]), sv(S.mul[size]) });
            if (opcode != 8) b.emit(.{sv(if (opcode == 4) S.sub[size] else S.add[size])});
            vput(e, rd, q);
            return true;
        }
        if ((opcode == 2 or opcode == 6 or opcode == 10) and (size == 1 or size == 2)) {
            const idx: u8 = @intCast(if (size == 1) (H << 2) | (Lb << 1) | M else (H << 1) | Lb);
            const m: u8 = @intCast(if (size == 1) rmLow else (M << 4) | rmLow);
            b.get(L_CPU);
            if (opcode != 10) vget(e, rd);
            vget(e, rn);
            vget(e, m);
            b.emit(.{ sv(S.extract_u[size]), idx, sv(S.splat[size]), sv(S.extmul_low_s[size] + @as(u8, if (q) 1 else 0) + @as(u8, if (U) 2 else 0)) });
            if (opcode != 10) b.emit(.{sv(if (opcode == 6) S.sub[size + 1] else S.add[size + 1])});
            vput(e, rd, true);
            return true;
        }
        return false;
    }
    return false;
}
fn fmulx(e: *Emit, rn: u8, rm: u8, dp: bool) void {
    const b = e.b;
    const f: u32 = @intFromBool(dp);
    const lanes: u32 = if (dp) 2 else 4;
    const zero = [_]u8{0} ** 16;
    var inf: [16]u8 = undefined;
    var sign: [16]u8 = undefined;
    var two: [16]u8 = undefined;
    for (0..lanes) |i| {
        if (dp) {
            @as(*align(1) u64, @ptrCast(&inf[8 * i])).* = 0x7ff0_0000_0000_0000;
            @as(*align(1) u64, @ptrCast(&sign[8 * i])).* = 0x8000_0000_0000_0000;
            @as(*align(1) u64, @ptrCast(&two[8 * i])).* = 0x4000_0000_0000_0000;
        } else {
            @as(*align(1) u32, @ptrCast(&inf[4 * i])).* = 0x7f80_0000;
            @as(*align(1) u32, @ptrCast(&sign[4 * i])).* = 0x8000_0000;
            @as(*align(1) u32, @ptrCast(&two[4 * i])).* = 0x4000_0000;
        }
    }
    b.get(L_CPU);
    vget(e, rn);
    vget(e, rm);
    b.emit(.{ sv(S.xor), sv(S.const_) });
    b.bytes(&sign);
    b.emit(.{ sv(S.and_), sv(S.const_) });
    b.bytes(&two);
    b.emit(.{sv(S.or_)});
    vget(e, rn);
    vget(e, rm);
    b.emit(.{sv(S.fmul[f])});
    for ([_][2]*const [16]u8{ .{ &zero, &inf }, .{ &inf, &zero } }, 0..) |pair, i| {
        vget(e, rn);
        b.emit(.{ sv(S.fabs[f]), sv(S.const_) });
        b.bytes(pair[0]);
        b.emit(.{sv(S.feq[f])});
        vget(e, rm);
        b.emit(.{ sv(S.fabs[f]), sv(S.const_) });
        b.bytes(pair[1]);
        b.emit(.{ sv(S.feq[f]), sv(S.and_) });
        if (i == 1) b.emit(.{sv(S.or_)});
    }
    b.emit(.{sv(S.bitselect)});
}
