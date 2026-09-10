// A wasm binary emitter: LEB128, sections, and the opcodes the JIT uses, over a byte buffer in
// guest memory that the host reads out to compile.

pub const Op = struct {
    pub const unreachable_ = 0x00;
    pub const block = 0x02;
    pub const loop = 0x03;
    pub const if_ = 0x04;
    pub const else_ = 0x05;
    pub const end = 0x0b;
    pub const br = 0x0c;
    pub const br_if = 0x0d;
    pub const br_table = 0x0e;
    pub const return_ = 0x0f;
    pub const call = 0x10;
    pub const return_call_indirect = 0x13;
    pub const drop = 0x1a;
    pub const select = 0x1b;
    pub const local_get = 0x20;
    pub const local_set = 0x21;
    pub const local_tee = 0x22;
    pub const i32_load = 0x28;
    pub const i64_load = 0x29;
    pub const f32_load = 0x2a;
    pub const f64_load = 0x2b;
    pub const i32_load8_s = 0x2c;
    pub const i32_load8_u = 0x2d;
    pub const i32_load16_s = 0x2e;
    pub const i32_load16_u = 0x2f;
    pub const i64_load8_s = 0x30;
    pub const i64_load8_u = 0x31;
    pub const i64_load16_s = 0x32;
    pub const i64_load16_u = 0x33;
    pub const i64_load32_s = 0x34;
    pub const i64_load32_u = 0x35;
    pub const i32_store = 0x36;
    pub const i64_store = 0x37;
    pub const f32_store = 0x38;
    pub const f64_store = 0x39;
    pub const i32_store8 = 0x3a;
    pub const i32_store16 = 0x3b;
    pub const i64_store8 = 0x3c;
    pub const i64_store16 = 0x3d;
    pub const i64_store32 = 0x3e;
    pub const i32_const = 0x41;
    pub const i64_const = 0x42;
    pub const f32_const = 0x43;
    pub const f64_const = 0x44;
    pub const i32_eqz = 0x45;
    pub const i32_eq = 0x46;
    pub const i32_ne = 0x47;
    pub const i32_lt_s = 0x48;
    pub const i32_lt_u = 0x49;
    pub const i32_gt_s = 0x4a;
    pub const i32_gt_u = 0x4b;
    pub const i32_le_s = 0x4c;
    pub const i32_le_u = 0x4d;
    pub const i32_ge_s = 0x4e;
    pub const i32_ge_u = 0x4f;
    pub const i64_eqz = 0x50;
    pub const i64_eq = 0x51;
    pub const i64_ne = 0x52;
    pub const i64_lt_s = 0x53;
    pub const i64_lt_u = 0x54;
    pub const i64_gt_s = 0x55;
    pub const i64_gt_u = 0x56;
    pub const i64_le_s = 0x57;
    pub const i64_le_u = 0x58;
    pub const i64_ge_s = 0x59;
    pub const i64_ge_u = 0x5a;
    pub const f32_eq = 0x5b;
    pub const f32_ne = 0x5c;
    pub const f32_lt = 0x5d;
    pub const f32_gt = 0x5e;
    pub const f32_le = 0x5f;
    pub const f32_ge = 0x60;
    pub const f64_eq = 0x61;
    pub const f64_ne = 0x62;
    pub const f64_lt = 0x63;
    pub const f64_gt = 0x64;
    pub const f64_le = 0x65;
    pub const f64_ge = 0x66;
    pub const i32_clz = 0x67;
    pub const i32_add = 0x6a;
    pub const i32_sub = 0x6b;
    pub const i32_mul = 0x6c;
    pub const i32_div_s = 0x6d;
    pub const i32_div_u = 0x6e;
    pub const i32_and = 0x71;
    pub const i32_or = 0x72;
    pub const i32_xor = 0x73;
    pub const i32_shl = 0x74;
    pub const i32_shr_s = 0x75;
    pub const i32_shr_u = 0x76;
    pub const i32_rotr = 0x78;
    pub const i64_clz = 0x79;
    pub const i64_add = 0x7c;
    pub const i64_sub = 0x7d;
    pub const i64_mul = 0x7e;
    pub const i64_div_s = 0x7f;
    pub const i64_div_u = 0x80;
    pub const i64_and = 0x83;
    pub const i64_or = 0x84;
    pub const i64_xor = 0x85;
    pub const i64_shl = 0x86;
    pub const i64_shr_s = 0x87;
    pub const i64_shr_u = 0x88;
    pub const i64_rotr = 0x8a;
    pub const f32_abs = 0x8b;
    pub const f32_neg = 0x8c;
    pub const f32_ceil = 0x8d;
    pub const f32_floor = 0x8e;
    pub const f32_trunc = 0x8f;
    pub const f32_nearest = 0x90;
    pub const f32_sqrt = 0x91;
    pub const f32_add = 0x92;
    pub const f32_sub = 0x93;
    pub const f32_mul = 0x94;
    pub const f32_div = 0x95;
    pub const f64_abs = 0x99;
    pub const f64_neg = 0x9a;
    pub const f64_ceil = 0x9b;
    pub const f64_floor = 0x9c;
    pub const f64_trunc = 0x9d;
    pub const f64_nearest = 0x9e;
    pub const f64_sqrt = 0x9f;
    pub const f64_add = 0xa0;
    pub const f64_sub = 0xa1;
    pub const f64_mul = 0xa2;
    pub const f64_div = 0xa3;
    pub const i32_wrap_i64 = 0xa7;
    pub const i64_extend_i32_s = 0xac;
    pub const i64_extend_i32_u = 0xad;
    /// the four conversions from i32 s, i32 u, i64 s, i64 u follow in that order
    pub const f32_convert_i32_s = 0xb2;
    pub const f32_demote_f64 = 0xb6;
    pub const f64_convert_i32_s = 0xb7;
    pub const f64_promote_f32 = 0xbb;
    /// the saturating truncations: i32 from f32 s/u, f64 s/u, then i64 likewise
    pub const fc_prefix = 0xfc;
    pub const i32_extend8_s = 0xc0;
    pub const i32_extend16_s = 0xc1;
    pub const i64_extend8_s = 0xc2;
    pub const i64_extend16_s = 0xc3;
    pub const i64_extend32_s = 0xc4;
};
pub const I32: u8 = 0x7f;
pub const I64: u8 = 0x7e;
pub const F32: u8 = 0x7d;
pub const F64: u8 = 0x7c;
pub const VOID: u8 = 0x40;

pub const Buf = struct {
    p: [*]u8,
    len: u32,
    cap: u32,
    overflow: bool = false,

    pub fn init(base: u32, cap: u32) Buf {
        return .{ .p = @ptrFromInt(base), .len = 0, .cap = cap };
    }
    pub fn byte(b: *Buf, v: u8) void {
        if (b.len >= b.cap) {
            b.overflow = true;
            return;
        }
        b.p[b.len] = v;
        b.len += 1;
    }
    pub fn bytes(b: *Buf, str: []const u8) void {
        for (str) |v| b.byte(v);
    }
    pub fn u(b: *Buf, v_in: u64) void {
        var v = v_in;
        while (true) {
            const seven: u8 = @truncate(v & 0x7f);
            v >>= 7;
            if (v == 0) {
                b.byte(seven);
                return;
            }
            b.byte(seven | 0x80);
        }
    }
    pub fn s(b: *Buf, v_in: i64) void {
        var v = v_in;
        while (true) {
            const seven: u8 = @truncate(@as(u64, @bitCast(v)) & 0x7f);
            v >>= 7;
            const done = (v == 0 and seven & 0x40 == 0) or (v == -1 and seven & 0x40 != 0);
            b.byte(if (done) seven else seven | 0x80);
            if (done) return;
        }
    }
    pub fn op(b: *Buf, o: u8) void {
        b.byte(o);
    }
    pub fn i32c(b: *Buf, v: i32) void {
        b.byte(Op.i32_const);
        b.s(v);
    }
    pub fn i64c(b: *Buf, v: i64) void {
        b.byte(Op.i64_const);
        b.s(v);
    }
    pub fn f64c(b: *Buf, v: f64) void {
        b.byte(Op.f64_const);
        const raw: [8]u8 = @bitCast(v);
        b.bytes(&raw);
    }
    pub fn get(b: *Buf, l: u32) void {
        b.byte(Op.local_get);
        b.u(l);
    }
    pub fn set(b: *Buf, l: u32) void {
        b.byte(Op.local_set);
        b.u(l);
    }
    pub fn tee(b: *Buf, l: u32) void {
        b.byte(Op.local_tee);
        b.u(l);
    }
    /// a load or store with an alignment hint of 1 and the given offset
    pub fn memop(b: *Buf, o: u8, offset: u32) void {
        b.byte(o);
        b.u(0);
        b.u(offset);
    }
    pub fn call(b: *Buf, f: u32) void {
        b.byte(Op.call);
        b.u(f);
    }
    pub fn br(b: *Buf, depth: u32) void {
        b.byte(Op.br);
        b.u(depth);
    }
    pub fn brIf(b: *Buf, depth: u32) void {
        b.byte(Op.br_if);
        b.u(depth);
    }
    pub fn blockStart(b: *Buf, kind: u8, ty: u8) void {
        b.byte(kind);
        b.byte(ty);
    }
    /// reserve a 5-byte LEB for a length filled in later
    pub fn reserve(b: *Buf) u32 {
        const at = b.len;
        var i: u32 = 0;
        while (i < 5) : (i += 1) b.byte(0x80);
        if (b.len > at) b.p[b.len - 1] = 0;
        return at;
    }
    pub fn patch(b: *Buf, at: u32, v_in: u32) void {
        if (at + 5 > b.cap) return;
        var v = v_in;
        var i: u32 = 0;
        while (i < 5) : (i += 1) {
            const seven: u8 = @truncate(v & 0x7f);
            v >>= 7;
            b.p[at + i] = if (i == 4) seven else seven | 0x80;
        }
    }
};
