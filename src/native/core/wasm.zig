const std = @import("std");
pub const Op = struct {
    pub const block: u8 = 0x02;
    pub const loop: u8 = 0x03;
    pub const if_: u8 = 0x04;
    pub const else_: u8 = 0x05;
    pub const end: u8 = 0x0b;
    pub const br: u8 = 0x0c;
    pub const br_if: u8 = 0x0d;
    pub const br_table: u8 = 0x0e;
    pub const return_: u8 = 0x0f;
    pub const memory_size: u8 = 0x3f;
    pub const call: u8 = 0x10;
    pub const call_indirect: u8 = 0x11;
    pub const return_call_indirect: u8 = 0x13;
    pub const drop: u8 = 0x1a;
    pub const select: u8 = 0x1b;
    pub const local_get: u8 = 0x20;
    pub const local_set: u8 = 0x21;
    pub const local_tee: u8 = 0x22;
    pub const i32_load: u8 = 0x28;
    pub const i64_load: u8 = 0x29;
    pub const f32_load: u8 = 0x2a;
    pub const f64_load: u8 = 0x2b;
    pub const i32_load8_s: u8 = 0x2c;
    pub const i32_load8_u: u8 = 0x2d;
    pub const i32_load16_s: u8 = 0x2e;
    pub const i32_load16_u: u8 = 0x2f;
    pub const i64_load8_s: u8 = 0x30;
    pub const i64_load8_u: u8 = 0x31;
    pub const i64_load16_s: u8 = 0x32;
    pub const i64_load16_u: u8 = 0x33;
    pub const i64_load32_s: u8 = 0x34;
    pub const i64_load32_u: u8 = 0x35;
    pub const i32_store: u8 = 0x36;
    pub const i64_store: u8 = 0x37;
    pub const f32_store: u8 = 0x38;
    pub const f64_store: u8 = 0x39;
    pub const i32_store8: u8 = 0x3a;
    pub const i32_store16: u8 = 0x3b;
    pub const i64_store8: u8 = 0x3c;
    pub const i64_store16: u8 = 0x3d;
    pub const i64_store32: u8 = 0x3e;
    pub const i32_const: u8 = 0x41;
    pub const i64_const: u8 = 0x42;
    pub const f64_const: u8 = 0x44;
    pub const i32_eqz: u8 = 0x45;
    pub const i32_eq: u8 = 0x46;
    pub const i32_ne: u8 = 0x47;
    pub const i32_lt_s: u8 = 0x48;
    pub const i32_lt_u: u8 = 0x49;
    pub const i32_gt_s: u8 = 0x4a;
    pub const i32_gt_u: u8 = 0x4b;
    pub const i32_le_u: u8 = 0x4d;
    pub const i32_ge_s: u8 = 0x4e;
    pub const i32_ge_u: u8 = 0x4f;
    pub const i64_eqz: u8 = 0x50;
    pub const i64_eq: u8 = 0x51;
    pub const i64_ne: u8 = 0x52;
    pub const i64_ge_s: u8 = 0x59;
    pub const f64_eq: u8 = 0x61;
    pub const f64_ne: u8 = 0x62;
    pub const f64_lt: u8 = 0x63;
    pub const f64_gt: u8 = 0x64;
    pub const i32_clz: u8 = 0x67;
    pub const i32_add: u8 = 0x6a;
    pub const i32_sub: u8 = 0x6b;
    pub const i32_mul: u8 = 0x6c;
    pub const i32_div_s: u8 = 0x6d;
    pub const i32_div_u: u8 = 0x6e;
    pub const i32_and: u8 = 0x71;
    pub const i32_or: u8 = 0x72;
    pub const i32_xor: u8 = 0x73;
    pub const i32_shl: u8 = 0x74;
    pub const i32_shr_s: u8 = 0x75;
    pub const i32_shr_u: u8 = 0x76;
    pub const i32_rotr: u8 = 0x78;
    pub const i64_add: u8 = 0x7c;
    pub const i64_sub: u8 = 0x7d;
    pub const i64_mul: u8 = 0x7e;
    pub const i64_and: u8 = 0x83;
    pub const i64_or: u8 = 0x84;
    pub const i64_xor: u8 = 0x85;
    pub const i64_shl: u8 = 0x86;
    pub const i64_shr_s: u8 = 0x87;
    pub const i64_shr_u: u8 = 0x88;
    pub const i64_rotr: u8 = 0x8a;
    pub const f32_abs: u8 = 0x8b;
    pub const f32_neg: u8 = 0x8c;
    pub const f32_ceil: u8 = 0x8d;
    pub const f32_sqrt: u8 = 0x91;
    pub const f32_add: u8 = 0x92;
    pub const f32_sub: u8 = 0x93;
    pub const f32_mul: u8 = 0x94;
    pub const f32_div: u8 = 0x95;
    pub const f64_abs: u8 = 0x99;
    pub const f64_neg: u8 = 0x9a;
    pub const f64_ceil: u8 = 0x9b;
    pub const f64_sqrt: u8 = 0x9f;
    pub const f64_add: u8 = 0xa0;
    pub const f64_sub: u8 = 0xa1;
    pub const f64_mul: u8 = 0xa2;
    pub const f64_div: u8 = 0xa3;
    pub const i32_wrap_i64: u8 = 0xa7;
    pub const i64_extend_i32_s: u8 = 0xac;
    pub const i64_extend_i32_u: u8 = 0xad;
    pub const f32_convert_i32_s: u8 = 0xb2;
    pub const f32_demote_f64: u8 = 0xb6;
    pub const f64_convert_i64_s: u8 = 0xb9;
    pub const f64_convert_i64_u: u8 = 0xba;
    pub const f64_convert_i32_s: u8 = 0xb7;
    pub const f64_promote_f32: u8 = 0xbb;
    pub const fc_prefix: u8 = 0xfc;
    pub const i32_extend8_s: u8 = 0xc0;
    pub const i32_extend16_s: u8 = 0xc1;
    pub const i64_extend8_s: u8 = 0xc2;
    pub const i64_extend16_s: u8 = 0xc3;
    pub const i64_extend32_s: u8 = 0xc4;
};
pub inline fn W(comptime wide: bool, comptime op32: u8) u8 {
    if (!wide) return op32;
    return switch (op32) {
        Op.i32_eqz...Op.i32_ge_u => op32 + 0x0b,
        Op.i32_clz...Op.i32_rotr => op32 + 0x12,
        Op.i32_load, Op.i32_store, Op.i32_const => op32 + 1,
        Op.i32_load8_s...Op.i32_load16_u => op32 + 4,
        Op.i32_store8, Op.i32_store16, Op.i32_extend8_s, Op.i32_extend16_s => op32 + 2,
        else => @compileError("no i64 twin"),
    };
}
pub const F = struct {
    pub const load = [2]u8{ Op.f32_load, Op.f64_load };
    pub const store = [2]u8{ Op.f32_store, Op.f64_store };
    pub const abs = [2]u8{ Op.f32_abs, Op.f64_abs };
    pub const neg = [2]u8{ Op.f32_neg, Op.f64_neg };
    pub const sqrt = [2]u8{ Op.f32_sqrt, Op.f64_sqrt };
    pub const add = [2]u8{ Op.f32_add, Op.f64_add };
    pub const sub = [2]u8{ Op.f32_sub, Op.f64_sub };
    pub const mul = [2]u8{ Op.f32_mul, Op.f64_mul };
    pub const div = [2]u8{ Op.f32_div, Op.f64_div };
    pub const ceil = [2]u8{ Op.f32_ceil, Op.f64_ceil };
    pub const convert_i32_s = [2]u8{ Op.f32_convert_i32_s, Op.f64_convert_i32_s };
    pub const cvt = [2]u8{ Op.f64_promote_f32, Op.f32_demote_f64 };
    pub const iload = [2]u8{ Op.i32_load, Op.i64_load };
    pub const istore = [2]u8{ Op.i32_store, Op.i64_store };
};
/// the threads proposal's i64 forms, by access size (1 << index bytes)
pub const Atomic = struct {
    pub const prefix: u8 = 0xfe;
    pub const fence: u8 = 0x03;
    pub const load = [4]u8{ 0x14, 0x15, 0x16, 0x11 };
    pub const store = [4]u8{ 0x1b, 0x1c, 0x1d, 0x18 };
    pub const cmpxchg = [4]u8{ 0x4c, 0x4d, 0x4e, 0x49 };
};
pub const Simd = struct {
    pub const prefix: u8 = 0xfd;
    pub const load: u8 = 0x00;
    pub const store: u8 = 0x0b;
    pub const const_: u8 = 0x0c;
    pub const shuffle: u8 = 0x0d;
    pub const swizzle: u8 = 0x0e;
    pub const load8_splat: u8 = 0x07;
    pub const load32_zero: u8 = 0x5c;
    pub const load64_zero: u8 = 0x5d;
    pub const store8_lane: u8 = 0x58;
    pub const store64_lane: u8 = 0x5b;
    pub const splat = [_]u8{ 0x0f, 0x10, 0x11, 0x12 };
    pub const fsplat = [_]u8{ 0x13, 0x14 };
    pub const extract_s = [_]u8{ 0x15, 0x18, 0x1b, 0x1d };
    pub const extract_u = [_]u8{ 0x16, 0x19, 0x1b, 0x1d };
    pub const fextract = [_]u8{ 0x1f, 0x21 };
    pub const replace = [_]u8{ 0x17, 0x1a, 0x1c, 0x1e };
    pub const freplace = [_]u8{ 0x20, 0x22 };
    pub const eq = [_]u8{ 0x23, 0x2d, 0x37, 0xd6 };
    pub const ne = [_]u8{ 0x24, 0x2e, 0x38, 0xd7 };
    pub const gt_s = [_]u8{ 0x27, 0x31, 0x3b, 0xd9 };
    pub const gt_u = [_]u8{ 0x28, 0x32, 0x3c, 0 };
    pub const ge_s = [_]u8{ 0x2b, 0x35, 0x3f, 0xdb };
    pub const ge_u = [_]u8{ 0x2c, 0x36, 0x40, 0 };
    pub const feq = [_]u8{ 0x41, 0x47 };
    pub const fgt = [_]u8{ 0x44, 0x4a };
    pub const fge = [_]u8{ 0x46, 0x4c };
    pub const not: u8 = 0x4d;
    pub const and_: u8 = 0x4e;
    pub const andnot: u8 = 0x4f;
    pub const or_: u8 = 0x50;
    pub const xor: u8 = 0x51;
    pub const bitselect: u8 = 0x52;
    pub const any_true: u8 = 0x53;
    pub const popcnt: u8 = 0x62;
    pub const narrow_s = [_]u8{ 0x65, 0x85 };
    pub const narrow_u = [_]u8{ 0x66, 0x86 };
    pub const f32x4_demote_f64x2_zero: u8 = 0x5e;
    pub const f64x2_promote_low_f32x4: u8 = 0x5f;
    pub const neg = [_]u8{ 0x61, 0x81, 0xa1, 0xc1 };
    pub const extend_low_s = [_]u8{ 0x87, 0xa7, 0xc7 };
    pub const extmul_low_s = [_]u8{ 0x9c, 0xbc, 0xdc };
    pub const shl = [_]u8{ 0x6b, 0x8b, 0xab, 0xcb };
    pub const shr_s = [_]u8{ 0x6c, 0x8c, 0xac, 0xcc };
    pub const shr_u = [_]u8{ 0x6d, 0x8d, 0xad, 0xcd };
    pub const add = [_]u8{ 0x6e, 0x8e, 0xae, 0xce };
    pub const add_sat_s = [_]u8{ 0x6f, 0x8f };
    pub const add_sat_u = [_]u8{ 0x70, 0x90 };
    pub const sub = [_]u8{ 0x71, 0x91, 0xb1, 0xd1 };
    pub const sub_sat_s = [_]u8{ 0x72, 0x92 };
    pub const sub_sat_u = [_]u8{ 0x73, 0x93 };
    pub const avgr_u = [_]u8{ 0x7b, 0x9b };
    pub const extadd_pairwise = [_][2]u8{ .{ 0x7c, 0x7d }, .{ 0x7e, 0x7f } };
    pub const mul = [_]u8{ 0, 0x95, 0xb5, 0xd5 };
    pub const min_s = [_]u8{ 0x76, 0x96, 0xb6, 0 };
    pub const min_u = [_]u8{ 0x77, 0x97, 0xb7, 0 };
    pub const max_s = [_]u8{ 0x78, 0x98, 0xb8, 0 };
    pub const max_u = [_]u8{ 0x79, 0x99, 0xb9, 0 };
    pub const fabs = [_]u8{ 0xe0, 0xec };
    pub const fneg = [_]u8{ 0xe1, 0xed };
    pub const fsqrt = [_]u8{ 0xe3, 0xef };
    pub const fadd = [_]u8{ 0xe4, 0xf0 };
    pub const fsub = [_]u8{ 0xe5, 0xf1 };
    pub const fmul = [_]u8{ 0xe6, 0xf2 };
    pub const fdiv = [_]u8{ 0xe7, 0xf3 };
    pub const fmin = [_]u8{ 0xe8, 0xf4 };
    pub const fmax = [_]u8{ 0xe9, 0xf5 };
    pub const fceil = [_]u8{ 0x67, 0x74 };
    pub const ffloor = [_]u8{ 0x68, 0x75 };
    pub const ftrunc = [_]u8{ 0x69, 0x7a };
    pub const fnearest = [_]u8{ 0x6a, 0x94 };
    pub const i32x4_trunc_sat_f32x4_s: u8 = 0xf8;
    pub const i32x4_trunc_sat_f32x4_u: u8 = 0xf9;
    pub const f32x4_convert_i32x4_s: u8 = 0xfa;
    pub const f32x4_convert_i32x4_u: u8 = 0xfb;
};
pub const I32: u8 = 0x7f;
pub const I64: u8 = 0x7e;
pub const F32: u8 = 0x7d;
pub const F64: u8 = 0x7c;
pub const V128: u8 = 0x7b;
pub const VOID: u8 = 0x40;

pub const Get = struct { l: u32 };
pub const Set = struct { l: u32 };
pub const Tee = struct { l: u32 };
pub const C32 = struct { v: i32 };
pub const C64 = struct { v: i64 };
/// a memory access at off in memory `mem` (the pool, 1, being an ARM32 module's second)
pub const Mo = struct { op: u8, off: u32, mem: u8 = 0 };
pub const Call = struct { f: u32 };
pub const Br = struct { depth: u32 };
pub const BrIf = struct { depth: u32 };
pub const Vop = struct { op: u8 };
pub const Vm = struct { op: u8, off: u32 };
/// an atomic access of 1 << size bytes, whose memarg must state that natural alignment
pub const Am = struct { op: u8, size: u2, off: u32 };
pub fn get(l: u32) Get {
    return .{ .l = l };
}
pub fn set(l: u32) Set {
    return .{ .l = l };
}
pub fn tee(l: u32) Tee {
    return .{ .l = l };
}
pub fn c32(v: i32) C32 {
    return .{ .v = v };
}
pub fn c64(v: i64) C64 {
    return .{ .v = v };
}
pub fn mo(op: u8, off: u32) Mo {
    return .{ .op = op, .off = off };
}
pub fn call(f: u32) Call {
    return .{ .f = f };
}
pub fn brIf(depth: u32) BrIf {
    return .{ .depth = depth };
}
pub fn simd(op: u8) Vop {
    return .{ .op = op };
}
pub fn vm(op: u8, off: u32) Vm {
    return .{ .op = op, .off = off };
}
pub fn am(op: [4]u8, size: u2, off: u32) Am {
    return .{ .op = op[size], .size = size, .off = off };
}

pub const Buf = struct {
    p: [*]u8,
    len: u32,
    cap: u32,
    overflow: bool = false,
    /// local.get, set and tee of locals [watch, watch + nwatch) are recorded as bits of reads and writes
    watch: u32 = 0,
    nwatch: u32 = 0,
    reads: u32 = 0,
    writes: u32 = 0,
    /// the watched locals' sets and tees so far
    nwrites: u32 = 0,
    /// where the `if`s and `br_if`s that rarely branch were written, for a branch hint section
    cold: []u32 = &.{},
    ncold: u32 = 0,

    pub fn init(base: u32, cap: u32) Buf {
        return .{ .p = @ptrFromInt(base), .len = 0, .cap = cap };
    }
    pub noinline fn byte(b: *Buf, x: u8) void {
        if (b.len >= b.cap) {
            b.overflow = true;
            return;
        }
        b.p[b.len] = x;
        b.len += 1;
    }
    pub fn bytes(b: *Buf, str: []const u8) void {
        for (str) |x| b.byte(x);
    }
    pub noinline fn u(b: *Buf, v_in: u64) void {
        var x = v_in;
        while (true) {
            const seven: u8 = @truncate(x & 0x7f);
            x >>= 7;
            if (x == 0) {
                b.byte(seven);
                return;
            }
            b.byte(seven | 0x80);
        }
    }
    pub noinline fn s(b: *Buf, v_in: i64) void {
        var x = v_in;
        while (true) {
            const seven: u8 = @truncate(@as(u64, @bitCast(x)) & 0x7f);
            x >>= 7;
            const done = (x == 0 and seven & 0x40 == 0) or (x == -1 and seven & 0x40 != 0);
            b.byte(if (done) seven else seven | 0x80);
            if (done) return;
        }
    }
    noinline fn local(b: *Buf, op: u8, l: u32) void {
        const k = l -% b.watch;
        if (k < b.nwatch) {
            const m = @as(u32, 1) << @intCast(k);
            if (op == Op.local_get) b.reads |= m else {
                b.writes |= m;
                b.nwrites += 1;
            }
        }
        b.byte(op);
        b.u(l);
    }
    pub fn emit(b: *Buf, ops: anytype) void {
        inline for (ops) |x| switch (@TypeOf(x)) {
            comptime_int, u8 => b.byte(x),
            Get => b.local(Op.local_get, x.l),
            Set => b.local(Op.local_set, x.l),
            Tee => b.local(Op.local_tee, x.l),
            C32 => {
                b.byte(Op.i32_const);
                b.s(x.v);
            },
            C64 => {
                b.byte(Op.i64_const);
                b.s(x.v);
            },
            Mo => {
                b.byte(x.op);
                if (x.mem != 0) {
                    b.u(0x40);
                    b.u(x.mem);
                } else b.u(0);
                b.u(x.off);
            },
            Call => {
                b.byte(Op.call);
                b.u(x.f);
            },
            Br => {
                b.byte(Op.br);
                b.u(x.depth);
            },
            BrIf => {
                b.byte(Op.br_if);
                b.u(x.depth);
            },
            Vop => {
                b.byte(Simd.prefix);
                b.u(x.op);
            },
            Vm => {
                b.byte(Simd.prefix);
                b.u(x.op);
                b.u(0);
                b.u(x.off);
            },
            Am => {
                b.byte(Atomic.prefix);
                b.u(x.op);
                b.u(x.size);
                b.u(x.off);
            },
            else => @compileError("emit: " ++ @typeName(@TypeOf(x))),
        };
    }
    pub fn i32c(b: *Buf, x: i32) void {
        b.emit(.{c32(x)});
    }
    pub fn i64c(b: *Buf, x: i64) void {
        b.emit(.{c64(x)});
    }
    pub fn f64c(b: *Buf, x: f64) void {
        b.byte(Op.f64_const);
        b.bytes(&@as([8]u8, @bitCast(x)));
    }
    pub fn get(b: *Buf, l: u32) void {
        b.emit(.{Get{ .l = l }});
    }
    pub fn set(b: *Buf, l: u32) void {
        b.emit(.{Set{ .l = l }});
    }
    pub fn tee(b: *Buf, l: u32) void {
        b.emit(.{Tee{ .l = l }});
    }
    pub fn memop(b: *Buf, o: u8, off: u32) void {
        b.emit(.{mo(o, off)});
    }
    pub fn call(b: *Buf, f: u32) void {
        b.emit(.{Call{ .f = f }});
    }
    pub fn br(b: *Buf, depth: u32) void {
        b.emit(.{Br{ .depth = depth }});
    }
    /// the `if` or `br_if` written next rarely takes its branch
    pub fn unlikely(b: *Buf) void {
        if (b.ncold >= b.cold.len) return;
        b.cold[b.ncold] = b.len;
        b.ncold += 1;
    }
    /// The branch hint section for the code section at `code`, whose function bodies (indices from
    /// `first_fn`) start at `bodies`, in front of it: the `unlikely` branches, each unlikely taken.
    pub fn branchHints(b: *Buf, code: u32, bodies: []const u32, first_fn: u32) void {
        if (b.ncold == 0 or b.overflow) return;
        const hints = b.len;
        b.byte(0);
        const len = b.reserve();
        const start = b.len;
        const name = "metadata.code.branch_hint";
        b.u(name.len);
        b.bytes(name);
        const cold = b.cold[0..b.ncold];
        var nfn: u32 = 0;
        var k: u32 = 0;
        for (bodies, 0..) |_, i| {
            const first = k;
            while (k < cold.len and cold[k] < bodyEnd(bodies, i, hints)) k += 1;
            nfn += @intFromBool(k != first);
        }
        b.u(nfn);
        k = 0;
        for (bodies, 0..) |body, i| {
            const first = k;
            while (k < cold.len and cold[k] < bodyEnd(bodies, i, hints)) k += 1;
            if (k == first) continue;
            b.u(first_fn + i);
            b.u(k - first);
            // the branch's offset in its body, counted from the locals, a size of 1, and 0 (unlikely)
            for (cold[first..k]) |at| {
                b.u(at - body);
                b.bytes(&[_]u8{ 1, 0 });
            }
        }
        b.patch(len, b.len - start);
        if (!b.overflow) std.mem.rotate(u8, b.p[code..b.len], hints - code);
    }
    fn bodyEnd(bodies: []const u32, i: usize, end: u32) u32 {
        return if (i + 1 < bodies.len) bodies[i + 1] else end;
    }
    pub fn blockStart(b: *Buf, kind: u8, ty: u8) void {
        b.emit(.{ kind, ty });
    }
    pub fn reserve(b: *Buf) u32 {
        const at = b.len;
        b.bytes(&[_]u8{ 0x80, 0x80, 0x80, 0x80, 0 });
        return at;
    }
    pub fn patch(b: *Buf, at: u32, v_in: u32) void {
        if (at + 5 > b.cap) return;
        var x = v_in;
        for (0..5) |i| {
            const seven: u8 = @truncate(x & 0x7f);
            x >>= 7;
            b.p[at + i] = if (i == 4) seven else seven | 0x80;
        }
    }
};
