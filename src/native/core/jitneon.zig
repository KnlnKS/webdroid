//! ARM32 Advanced SIMD data processing in compiled regions, lane for lane as arm.zig's neonSame,
//! neonMisc, neonShift, neonLong and neonImmediate compute it. D registers are the 8-byte halves
//! of cpu.v: an operation may read the lanes past a D operand, but a D result stores only its own
//! 8 bytes. Anything else falls back to the interpreter.
const arm = @import("arm.zig");
const cpu = @import("cpu.zig");
const jit = @import("jit.zig");
const simd = @import("simd.zig");
const wasm = @import("wasm.zig");
const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
const Emit = jit.Emit(false);
const Buf = wasm.Buf;
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
const VA = jit.L_VA;
const VB = jit.L_VB;
const VC = jit.L_VC;
const OFF_V = @offsetOf(cpu.Cpu, "v");
const F32_NE: u8 = 0x42;

/// The instruction in ARM encoding (Thumb's 0xef/0xff forms converted as arm.zig converts them),
/// decoded in execArm's order.
pub fn emit(e: *Emit, w: u32) bool {
    const b = e.b;
    if (is(w, 0xfe800010, 0xf2800010) and w & 0x00380080 != 0) return shift(b, w);
    if (is(w, 0xffb00010, 0xf3b00000)) return misc(b, w);
    if (is(w, 0xfe800000, 0xf2000000) or is(w, 0xffb00010, 0xf2b00000) or is(w, 0xfe800050, 0xf2800040)) return same(b, w);
    if (is(w, 0xfe800050, 0xf2800000)) return long(b, w);
    if (is(w, 0xfeb00010, 0xf2800010)) return immediate(b, w);
    return false;
}

fn reg(w: u32, hi: u5, lo: u5) u32 {
    return (bits(w, hi, 1) << 4) | bits(w, lo, 4);
}
fn load(b: *Buf, d: u32) void {
    b.emit(.{ get(L_CPU), vm(S.load, OFF_V + d * 8) });
}
/// Stores the value on the stack to D register `d` (and `d + 1` for a Q register); the caller
/// pushed L_CPU before computing it.
fn store(b: *Buf, d: u32, q: bool) void {
    if (q) b.emit(.{vm(S.store, OFF_V + d * 8)}) else b.emit(.{ vm(S.store64_lane, OFF_V + d * 8), 0 });
}
fn binary(b: *Buf, d: u32, n: u32, m: u32, q: bool, op: u8) void {
    b.get(L_CPU);
    load(b, n);
    load(b, m);
    b.emit(.{sv(op)});
    store(b, d, q);
}
/// d + n * m or d - n * m, the product rounded (or wrapped) on its own as neonSame computes it.
fn accumulate(b: *Buf, d: u32, n: u32, q: bool, mul: u8, add: u8, m: anytype) void {
    b.get(L_CPU);
    load(b, d);
    load(b, n);
    m.push(b);
    b.emit(.{ sv(mul), sv(add) });
    store(b, d, q);
}
const Reg = struct {
    d: u32,
    fn push(r: Reg, b: *Buf) void {
        load(b, r.d);
    }
};
/// One lane of a D register, splatted: the scalar operand of the by-element forms.
const Lane = struct {
    off: u32,
    esz: u32,
    fn push(l: Lane, b: *Buf) void {
        b.emit(.{ get(L_CPU), mo(if (l.esz == 0) O.i32_load8_u else if (l.esz == 1) O.i32_load16_u else O.i32_load, l.off), sv(S.splat[l.esz]) });
    }
};
fn vconst(b: *Buf, v: [16]u8) void {
    b.emit(.{sv(S.const_)});
    b.bytes(&v);
}
fn splat32(b: *Buf, v: u32) void {
    vconst(b, @bitCast([_]u32{v} ** 4));
}
fn shuffle(b: *Buf, mask: [16]u8) void {
    b.emit(.{sv(S.shuffle)});
    b.bytes(&mask);
}

fn same(b: *Buf, w: u32) bool {
    const size = bits(w, 20, 2);
    const scalar = is(w, 0xfe800050, 0xf2800040) and size != 3;
    const op = bits(w, 8, 4);
    if (scalar and op & 2 != 0 and op < 12) return long(b, w);
    const d = reg(w, 22, 12);
    const n = reg(w, 7, 16);
    const m = if (scalar) bits(w, 0, if (size == 1) 3 else 4) else reg(w, 5, 0);
    const q = (if (scalar) bits(w, 24, 1) else bits(w, 6, 1)) != 0;
    if (q and (d | n | (if (scalar) 0 else m)) & 1 != 0) return false;
    const b4 = w & 0x10 != 0;
    const u = w & (1 << 24) != 0;
    const f_sub = w & (1 << 21) != 0;
    if (is(w, 0xffb00010, 0xf2b00000)) {
        if (!q and op >= 8) return false;
        // VEXT: bytes op.. of n:m, indices 16 and up naming m in the shuffle
        var mask: [16]u8 = @splat(0);
        const nb: u32 = if (q) 16 else 8;
        for (0..nb) |i| {
            const p = op + @as(u32, @intCast(i));
            mask[i] = @intCast(if (p < nb) p else 16 + p - nb);
        }
        b.get(L_CPU);
        load(b, n);
        load(b, m);
        shuffle(b, mask);
        store(b, d, q);
        return true;
    }
    if (scalar) {
        if (size == 0 or (op & 1 != 0 and size != 2) or (op & 0xe != 0 and op & 0xe != 4 and op & 0xe != 8)) return false;
        const float = op & 1 != 0;
        const lane = scalarLane(w, size);
        const mul = if (float) S.fmul[0] else S.mul[size];
        if (op & 0xe == 8) {
            b.get(L_CPU);
            load(b, n);
            lane.push(b);
            b.emit(.{sv(mul)});
            store(b, d, q);
        } else {
            const sub = op & 0xe == 4;
            accumulate(b, d, n, q, mul, if (float) (if (sub) S.fsub[0] else S.fadd[0]) else if (sub) S.sub[size] else S.add[size], lane);
        }
        return true;
    }
    if (op == 15 and b4 and !u and size & 1 == 0) {
        recipStep(b, d, n, m, q, size == 2);
        return true;
    }
    if (op == 8 and !b4) {
        binary(b, d, n, m, q, if (u) S.sub[size] else S.add[size]);
    } else if (op == 3 and size != 3) {
        binary(b, d, n, m, q, if (b4) (if (u) S.ge_u[size] else S.ge_s[size]) else if (u) S.gt_u[size] else S.gt_s[size]);
    } else if (op == 6 and size != 3) {
        binary(b, d, n, m, q, if (b4) (if (u) S.min_u[size] else S.min_s[size]) else if (u) S.max_u[size] else S.max_s[size]);
    } else if (op == 8 and b4) {
        if (u) binary(b, d, n, m, q, S.eq[size]) else {
            b.get(L_CPU);
            load(b, n);
            load(b, m);
            b.emit(.{sv(S.and_)});
            splat32(b, 0);
            b.emit(.{sv(S.ne[size])});
            store(b, d, q);
        }
    } else if (op == 9 and size != 3 and (!b4 or !u)) {
        if (size == 0) return false;
        if (b4) binary(b, d, n, m, q, S.mul[size]) else accumulate(b, d, n, q, S.mul[size], if (u) S.sub[size] else S.add[size], Reg{ .d = m });
    } else if (op == 10 and size != 3 and !q) {
        pairs(b, n, m, size);
        b.emit(.{sv(if (b4) (if (u) S.min_u[size] else S.min_s[size]) else if (u) S.max_u[size] else S.max_s[size])});
        store(b, d, false);
    } else if (op == 11 and b4 and !u and size != 3 and !q) {
        pairs(b, n, m, size);
        b.emit(.{sv(S.add[size])});
        store(b, d, false);
    } else if (op == 1 and b4) {
        logical(b, d, n, m, q, u, size);
    } else if (op == 4 and !b4) {
        variableShift(b, d, n, m, q, size, u);
    } else if (op == 13 and size & 1 == 0 and !b4) {
        if (!u) binary(b, d, n, m, q, if (f_sub) S.fsub[0] else S.fadd[0]) else if (f_sub) {
            b.get(L_CPU);
            load(b, n);
            load(b, m);
            b.emit(.{ sv(S.fsub[0]), sv(S.fabs[0]) });
            store(b, d, q);
        } else if (!q) {
            pairs(b, n, m, 2);
            b.emit(.{sv(S.fadd[0])});
            store(b, d, false);
        } else return false;
    } else if (op == 13 and size == 0 and b4 and u) {
        binary(b, d, n, m, q, S.fmul[0]);
    } else if (op == 14 and size & 1 == 0 and (u or (!b4 and size == 0))) {
        const cmp = if (!u) S.feq[0] else if (f_sub) S.fgt[0] else S.fge[0];
        if (!b4) binary(b, d, n, m, q, cmp) else {
            b.get(L_CPU);
            load(b, n);
            b.emit(.{sv(S.fabs[0])});
            load(b, m);
            b.emit(.{ sv(S.fabs[0]), sv(cmp) });
            store(b, d, q);
        }
    } else if (op == 13 and b4 and !u and size & 1 == 0) {
        accumulate(b, d, n, q, S.fmul[0], if (f_sub) S.fsub[0] else S.fadd[0], Reg{ .d = m });
    } else if (op == 15 and !b4 and size & 1 == 0 and !(u and q)) {
        if (u) {
            pairs(b, n, m, 2);
            b.emit(.{ set(VB), set(VA) });
        } else {
            load(b, n);
            b.set(VA);
            load(b, m);
            b.set(VB);
            b.get(L_CPU);
        }
        extremum(b, f_sub);
        store(b, d, q);
    } else return false;
    return true;
}

/// Pushes L_CPU and the D operands' pairwise halves: the first lane of each adjacent pair of n
/// then of m, and the second lanes, as simd.pair orders them.
fn pairs(b: *Buf, n: u32, m: u32, size: u32) void {
    const es = @as(u32, 1) << @intCast(size);
    const lanes = 8 / es;
    var first: [16]u8 = @splat(0);
    var second: [16]u8 = @splat(0);
    for (0..lanes) |i| {
        const lane: u32 = @intCast(if (i < lanes / 2) 2 * i else 16 / es + 2 * (i - lanes / 2));
        for (0..es) |j| {
            first[i * es + j] = @intCast(lane * es + j);
            second[i * es + j] = @intCast((lane + 1) * es + j);
        }
    }
    b.get(L_CPU);
    for ([_][16]u8{ first, second }) |mask| {
        load(b, n);
        load(b, m);
        shuffle(b, mask);
    }
}

/// VMAX/VMIN.F32 of VA and VB: wasm's lanes where neither operand is NaN, else the first NaN
/// operand's bits unchanged, as fp.fmax/fmin return it (wasm's own NaN result is unspecified).
fn extremum(b: *Buf, min: bool) void {
    b.emit(.{ get(VA), get(VB), get(VA), get(VB), sv(if (min) S.fmin[0] else S.fmax[0]), get(VB), get(VB), sv(F32_NE), sv(S.bitselect) });
    b.emit(.{ get(VA), get(VA), sv(F32_NE), sv(S.bitselect) });
}

/// VRECPS (2 - n * m) and VRSQRTS ((3 - n * m) / 2) as fp.recipStep32: standardized operands and
/// product, where infinity times zero is zero, and a standardized result.
fn recipStep(b: *Buf, d: u32, n: u32, m: u32, q: bool, sqrt: bool) void {
    load(b, n);
    standardize(b);
    b.set(VB);
    load(b, m);
    standardize(b);
    b.set(VC);
    b.emit(.{ get(L_CPU), get(VB), get(VC), sv(S.fmul[0]) });
    standardize(b);
    for ([_]u32{ VB, VC }, [_]u32{ VC, VB }, 0..) |inf, zero, i| {
        b.emit(.{ get(inf), sv(S.fabs[0]) });
        splat32(b, 0x7f80_0000);
        b.emit(.{ sv(S.feq[0]), get(zero) });
        splat32(b, 0);
        b.emit(.{ sv(S.feq[0]), sv(S.and_) });
        if (i == 1) b.emit(.{sv(S.or_)});
    }
    b.emit(.{ sv(S.andnot), set(VA) });
    splat32(b, if (sqrt) 0x4040_0000 else 0x4000_0000);
    b.emit(.{ get(VA), sv(S.fsub[0]) });
    if (sqrt) {
        splat32(b, 0x3f00_0000);
        b.emit(.{sv(S.fmul[0])});
    }
    standardize(b);
    store(b, d, q);
}

/// VAND/VBIC/VORR/VORN and VEOR/VBSL/VBIT/VBIF, as simd.exec's logical group.
fn logical(b: *Buf, d: u32, n: u32, m: u32, q: bool, u: bool, size: u32) void {
    b.get(L_CPU);
    if (!u) {
        load(b, n);
        load(b, m);
        switch (size) {
            0 => b.emit(.{sv(S.and_)}),
            1 => b.emit(.{sv(S.andnot)}),
            2 => b.emit(.{sv(S.or_)}),
            else => b.emit(.{ sv(S.not), sv(S.or_) }),
        }
    } else {
        const operands: [3]u32 = switch (size) {
            0 => .{ n, m, 0 },
            1 => .{ n, m, d },
            2 => .{ n, d, m },
            else => .{ d, n, m },
        };
        load(b, operands[0]);
        load(b, operands[1]);
        if (size == 0) b.emit(.{sv(S.xor)}) else {
            load(b, operands[2]);
            b.emit(.{sv(S.bitselect)});
        }
    }
    store(b, d, q);
}

/// VSHL by register: each lane of m shifted by the signed low byte of n's lane, left when
/// positive; a shift past the lane width leaves zero or the sign. Wasm SIMD shifts by one amount
/// for every lane, so each lane is shifted on its own.
fn variableShift(b: *Buf, d: u32, n: u32, m: u32, q: bool, size: u32, unsigned: bool) void {
    load(b, m);
    b.set(VA);
    load(b, n);
    b.set(VB);
    b.emit(.{ get(L_CPU), get(VA) });
    const es: u32 = @as(u32, 1) << @intCast(size);
    const lanes = (if (q) @as(u32, 16) else 8) / es;
    for (0..lanes) |li| {
        const i: u8 = @intCast(li);
        b.emit(.{ get(VB), sv(S.extract_s[0]), @as(u8, @intCast(i * es)), set(jit.L_B) });
        if (size == 3) {
            b.emit(.{ get(VA), sv(S.extract_s[3]), i, set(jit.L_T0) });
            b.emit(.{ get(jit.L_T0), get(jit.L_B), O.i64_extend_i32_s, O.i64_shl, c64(0), get(jit.L_B), c32(64), O.i32_lt_s, O.select });
            b.emit(.{ get(jit.L_T0), c32(0), get(jit.L_B), O.i32_sub, tee(jit.L_R) });
            if (unsigned) b.emit(.{ O.i64_extend_i32_s, O.i64_shr_u, c64(0), get(jit.L_R), c32(64), O.i32_lt_u, O.select }) else b.emit(.{ c32(63), get(jit.L_R), c32(64), O.i32_lt_u, O.select, O.i64_extend_i32_u, O.i64_shr_s });
        } else {
            b.emit(.{ get(VA), sv(if (unsigned) S.extract_u[size] else S.extract_s[size]), i, set(jit.L_A) });
            b.emit(.{ get(jit.L_A), get(jit.L_B), O.i32_shl, c32(0), get(jit.L_B), c32(32), O.i32_lt_s, O.select });
            b.emit(.{ get(jit.L_A), c32(0), get(jit.L_B), O.i32_sub, tee(jit.L_R) });
            if (unsigned) b.emit(.{ O.i32_shr_u, c32(0), get(jit.L_R), c32(32), O.i32_lt_u, O.select }) else b.emit(.{ c32(31), get(jit.L_R), c32(32), O.i32_lt_u, O.select, O.i32_shr_s });
        }
        b.emit(.{ get(jit.L_B), c32(0), O.i32_ge_s, O.select, sv(S.replace[size]), i });
    }
    store(b, d, q);
}

fn misc(b: *Buf, w: u32) bool {
    if (is(w, 0xffb30e10, 0xf3b20000)) return permute(b, w);
    const d = reg(w, 22, 12);
    const m = reg(w, 5, 0);
    const q = w & 0x40 != 0;
    const duplicate = is(w, 0xffb00f90, 0xf3b00c00);
    if (is(w, 0xffb00c10, 0xf3b00800)) return false;
    if (q and (d | (if (duplicate) 0 else m)) & 1 != 0) return false;
    const size = bits(w, 18, 2);
    const op = bits(w, 7, 3);
    if (duplicate) {
        const imm = bits(w, 16, 4);
        if (imm & 7 == 0) return false;
        const esz: u32 = @ctz(imm);
        b.get(L_CPU);
        const lane = Lane{ .off = OFF_V + m * 8 + (imm >> @intCast(esz + 1)) * (@as(u32, 1) << @intCast(esz)), .esz = esz };
        lane.push(b);
    } else if (is(w, 0xffbf0f90, 0xf3b00580)) {
        b.get(L_CPU);
        load(b, m);
        b.emit(.{sv(S.not)});
    } else if (is(w, 0xffbf0f10, 0xf3bb0500)) {
        // VRECPE/VRSQRTE.F32: each lane through the core's fp.recpe/rsqrte
        load(b, m);
        b.emit(.{ set(VA), get(L_CPU), get(VA) });
        for (0..(if (q) @as(u8, 4) else 2)) |li| {
            const i: u8 = @intCast(li);
            b.emit(.{ get(VA), sv(S.extract_s[2]), i, c32(@intCast(bits(w, 7, 1))) });
            b.call(jit.F_ESTIMATE32);
            b.emit(.{ sv(S.replace[2]), i });
        }
    } else if (is(w, 0xffb30810, 0xf3b10000)) {
        const float = w & 0x400 != 0;
        if (size == 3 or op == 5 or (float and size != 2)) return false;
        b.get(L_CPU);
        unary(b, m, size, op, float);
    } else if (is(w, 0xffb30e10, 0xf3b00000)) {
        const rev = op & 3;
        if (rev > 2 or size + rev >= 3) return false;
        // VREV64/32/16: elements reversed within each 8 >> rev byte group
        const group = @as(u32, 8) >> @intCast(rev);
        const es = @as(u32, 1) << @intCast(size);
        var mask: [16]u8 = undefined;
        for (&mask, 0..) |*x, j| {
            const within = @as(u32, @intCast(j)) % group;
            x.* = @intCast(@as(u32, @intCast(j)) - within + (group / es - 1 - within / es) * es + within % es);
        }
        b.get(L_CPU);
        load(b, m);
        b.emit(.{ tee(VA), get(VA) });
        shuffle(b, mask);
    } else return false;
    store(b, d, q);
    return true;
}

/// Compares against zero, VABS and VNEG. The float forms see their inputs as fp.standard32 leaves
/// them, and VABS/VNEG.F32 standardize their result too.
fn unary(b: *Buf, m: u32, size: u32, op: u32, float: bool) void {
    if (op == 3 or op == 4) splat32(b, 0);
    load(b, m);
    if (float) standardize(b);
    if (op <= 2) splat32(b, 0);
    if (float) {
        b.emit(.{sv(switch (op) {
            0, 4 => S.fgt[0],
            1, 3 => S.fge[0],
            2 => S.feq[0],
            6 => S.fabs[0],
            else => S.fneg[0],
        })});
        if (op >= 6) standardize(b);
    } else b.emit(.{sv(switch (op) {
        0, 4 => S.gt_s[size],
        1, 3 => S.ge_s[size],
        2 => S.eq[size],
        6 => S.neg[size] - 1,
        else => S.neg[size],
    })});
}
/// fp.standard32 on each lane: a denormal becomes its signed zero and a NaN the default NaN.
fn standardize(b: *Buf) void {
    b.emit(.{ set(VA), get(VA) });
    splat32(b, 0x8000_0000);
    b.emit(.{ sv(S.and_), get(VA), get(VA) });
    splat32(b, 0x7f80_0000);
    b.emit(.{sv(S.and_)});
    splat32(b, 0);
    b.emit(.{ sv(S.eq[2]), sv(S.bitselect), set(VA) });
    splat32(b, 0x7fc0_0000);
    b.emit(.{ get(VA), get(VA), get(VA), sv(F32_NE), sv(S.bitselect) });
}

/// VSWP, VTRN, VUZP and VZIP: both registers rewritten from their original lanes, with the lane
/// orders simd.permuteIndex gives the A64 permutes neonPermute runs.
fn permute(b: *Buf, w: u32) bool {
    const d = reg(w, 22, 12);
    const m = reg(w, 5, 0);
    const q = w & 0x40 != 0;
    const size = bits(w, 18, 2);
    const op = bits(w, 7, 2);
    if (size == 3 or (q and (d | m) & 1 != 0) or (op == 0 and size != 0)) return false;
    load(b, d);
    b.set(VA);
    load(b, m);
    b.set(VB);
    const nb: u32 = if (q) 16 else 8;
    const es = @as(u32, 1) << @intCast(size);
    const first: u32 = if (op == 1) 2 else if (op == 2) 1 else 3;
    for ([_]u32{ d, m }, 0..) |dst, half| {
        b.get(L_CPU);
        if (op == 0) b.get(if (half == 0) VB else VA) else {
            var mask: [16]u8 = @splat(0);
            for (0..nb / es) |el| {
                const s = simd.permuteIndex(first + @as(u32, @intCast(half)) * 4, nb / es, el);
                for (0..es) |j| mask[el * es + j] = @intCast((if (s.m) @as(usize, 16) else 0) + s.i * es + j);
            }
            b.emit(.{ get(VA), get(VB) });
            shuffle(b, mask);
        }
        store(b, dst, q);
    }
    return true;
}

/// VSHR, VSRA and VSHL by immediate.
fn shift(b: *Buf, w: u32) bool {
    const d = reg(w, 22, 12);
    const m = reg(w, 5, 0);
    const q = w & 0x40 != 0;
    const op = bits(w, 8, 4);
    const u = w & (1 << 24) != 0;
    if ((op != 0 and op != 1 and !(op == 5 and !u)) or (q and (d | m) & 1 != 0)) return false;
    const imm = (bits(w, 7, 1) << 6) | bits(w, 16, 6);
    const immh = imm >> 3;
    const esz: u32 = if (immh & 8 != 0) 3 else if (immh & 4 != 0) 2 else if (immh & 2 != 0) 1 else 0;
    const width = @as(u32, 8) << @intCast(esz);
    b.get(L_CPU);
    if (op == 5) {
        load(b, m);
        b.emit(.{ c32(@intCast(imm - width)), sv(S.shl[esz]) });
    } else {
        if (op == 1) load(b, d);
        const amount = 2 * width - imm;
        // a shift by the whole lane, which Wasm would take modulo the width, leaves zero or the sign
        if (amount >= width and u) splat32(b, 0) else {
            load(b, m);
            b.emit(.{ c32(@intCast(@min(amount, width - 1))), sv(if (u) S.shr_u[esz] else S.shr_s[esz]) });
        }
        if (op == 1) b.emit(.{sv(S.add[esz])});
    }
    store(b, d, q);
    return true;
}

/// A by-scalar form's Dm[x].
fn scalarLane(w: u32, size: u32) Lane {
    return if (size == 1)
        .{ .off = OFF_V + bits(w, 0, 3) * 8 + ((bits(w, 5, 1) << 1) | bits(w, 3, 1)) * 2, .esz = 1 }
    else
        .{ .off = OFF_V + bits(w, 0, 4) * 8 + bits(w, 5, 1) * 4, .esz = 2 };
}

/// VMLAL, VMLSL and VMULL, by vector or by scalar: widening products of the D operands' lanes.
fn long(b: *Buf, w: u32) bool {
    const scalar = w & 0x40 != 0;
    const op = arm.neonLongOp(w);
    const size = bits(w, 20, 2);
    const d = reg(w, 22, 12);
    if (size == 3 or (scalar and size == 0) or d & 1 != 0 or (op != 8 and op != 10 and op != 12)) return false;
    b.get(L_CPU);
    if (op != 12) load(b, d);
    load(b, reg(w, 7, 16));
    if (scalar) scalarLane(w, size).push(b) else load(b, reg(w, 5, 0));
    b.emit(.{sv(S.extmul_low_s[size] + @as(u8, if (w & (1 << 24) != 0) 2 else 0))});
    if (op != 12) b.emit(.{sv(if (op == 8) S.add[size + 1] else S.sub[size + 1])});
    store(b, d, true);
    return true;
}

/// VMOV/VMVN/VORR/VBIC with a modified immediate, one D register at a time as neonImmediate.
fn immediate(b: *Buf, w: u32) bool {
    const d = reg(w, 22, 12);
    const q = w & 0x40 != 0;
    if (q and d & 1 != 0) return false;
    const imm8 = (bits(w, 24, 1) << 7) | (bits(w, 16, 3) << 4) | bits(w, 0, 4);
    const ex = simd.expandImm(bits(w, 5, 1), bits(w, 8, 4), 0, imm8) orelse return false;
    for (0..(if (q) @as(u32, 2) else 1)) |i| {
        const off = OFF_V + (d + @as(u32, @intCast(i))) * 8;
        b.get(L_CPU);
        switch (ex.kind) {
            .movi, .fmov => b.i64c(@bitCast(ex.v)),
            .mvni => b.i64c(@bitCast(~ex.v)),
            .orr => b.emit(.{ get(L_CPU), mo(O.i64_load, off), c64(@bitCast(ex.v)), O.i64_or }),
            .bic => b.emit(.{ get(L_CPU), mo(O.i64_load, off), c64(@bitCast(~ex.v)), O.i64_and }),
        }
        b.memop(O.i64_store, off);
    }
    return true;
}
