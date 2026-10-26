const std = @import("std");

pub inline fn isNan(x: anytype) bool {
    return x != x;
}
pub fn standard32(x: f32) f32 {
    const b: u32 = @bitCast(x);
    if (b & 0x7f800000 == 0) return @bitCast(b & 0x80000000);
    return if (isNan(x)) @bitCast(@as(u32, 0x7fc00000)) else x;
}
pub fn recipStep32(a: f32, b: f32, sqrt: bool) f32 {
    const n = standard32(a);
    const m = standard32(b);
    const product = if ((std.math.isInf(n) and m == 0) or (n == 0 and std.math.isInf(m))) 0 else standard32(n * m);
    return standard32(if (sqrt) (3.0 - product) / 2 else 2.0 - product);
}
pub fn rne(comptime F: type, x: F) F {
    const t = @trunc(x);
    if (@abs(x - t) == 0.5) return if (@mod(t, 2) == 0) t else t + (if (x < 0) @as(F, -1) else 1);
    return @round(x);
}
pub fn rint(comptime F: type, fpcr: u32, x: F) F {
    return switch ((fpcr >> 22) & 3) {
        1 => @ceil(x),
        2 => @floor(x),
        3 => @trunc(x),
        else => rne(F, x),
    };
}
pub fn toInt(comptime I: type, x: anytype) I {
    if (isNan(x)) return 0;
    const F = @TypeOf(x);
    const max: F = @floatFromInt(std.math.maxInt(I));
    const min: F = @floatFromInt(std.math.minInt(I));
    if (x >= max) return std.math.maxInt(I);
    if (x <= min) return std.math.minInt(I);
    return @intFromFloat(x);
}
pub fn fma(comptime F: type, a: F, b: F, c: F) F {
    if (F == f32) return @floatCast(@as(f64, a) * @as(f64, b) + @as(f64, c));
    const p = a * b;
    if (!std.math.isFinite(p) or !std.math.isFinite(c) or @abs(a) > 1e290 or @abs(b) > 1e290 or @abs(p) < 1e-290) return p + c;
    const ah = a * 134217729 - (a * 134217729 - a);
    const al = a - ah;
    const bh = b * 134217729 - (b * 134217729 - b);
    const bl = b - bh;
    const pe = al * bl - (p - ah * bh - al * bh - ah * bl);
    const s = p + c;
    const bb = s - p;
    const se = (p - (s - bb)) + (c - bb);
    return s + (se + pe);
}
pub fn fmulx(comptime F: type, a: F, b: F) F {
    const za = a == 0;
    const zb = b == 0;
    const ia = std.math.isInf(a);
    const ib = std.math.isInf(b);
    if ((za and ib) or (zb and ia)) return if (std.math.signbit(a) != std.math.signbit(b)) -2 else 2;
    return a * b;
}
pub fn fmax(comptime F: type, a: F, b: F) F {
    if (isNan(a)) return a;
    if (isNan(b)) return b;
    if (a == b) return if (std.math.signbit(a) and std.math.signbit(b)) a else @abs(a);
    return if (a > b) a else b;
}
pub fn fmin(comptime F: type, a: F, b: F) F {
    if (isNan(a)) return a;
    if (isNan(b)) return b;
    if (a == b) return if (std.math.signbit(a) or std.math.signbit(b)) -@abs(a) else a;
    return if (a < b) a else b;
}
pub fn fnm(comptime F: type, a: F, b: F, max: bool) F {
    const U = std.meta.Int(.unsigned, @bitSizeOf(F));
    const ab: U = @bitCast(a);
    const bb: U = @bitCast(b);
    const expMask: U = if (F == f32) 0x7f80_0000 else 0x7ff0_0000_0000_0000;
    const quiet: U = if (F == f32) 0x40_0000 else 0x8_0000_0000_0000;
    const abs: U = std.math.maxInt(U) >> 1;
    const na = (ab & abs) > expMask;
    const nb = (bb & abs) > expMask;
    if (na or nb) {
        if (na and (ab & quiet) == 0) return @bitCast(ab | quiet);
        if (nb and (bb & quiet) == 0) return @bitCast(bb | quiet);
        if (na and nb) return a;
        return if (na) b else a;
    }
    return if (max) fmax(F, a, b) else fmin(F, a, b);
}
pub fn recpx(comptime F: type, x: F) F {
    if (isNan(x)) return x;
    const U = std.meta.Int(.unsigned, @bitSizeOf(F));
    const eshift: u6 = if (F == f32) 23 else 52;
    const emask: U = if (F == f32) 0xff else 0x7ff;
    const b: U = @bitCast(x);
    const exp = (b >> eshift) & emask;
    const ne: U = if (exp == 0) emask - 1 else ~exp & emask;
    const sign: U = b & (@as(U, 1) << (@bitSizeOf(F) - 1));
    return @bitCast(sign | (ne << eshift));
}
fn pack(comptime F: type, neg: bool, exp: i32, frac52: u64) F {
    if (F == f64) return @bitCast((@as(u64, @intFromBool(neg)) << 63) | (@as(u64, @intCast(exp)) << 52) | frac52);
    return @bitCast((@as(u32, @intFromBool(neg)) << 31) | (@as(u32, @intCast(exp)) << 23) | @as(u32, @intCast(frac52 >> 29)));
}
const Parts = struct { neg: bool, exp: i32, frac: u64 };
fn parts(comptime F: type, x: F) Parts {
    if (F == f64) {
        const b: u64 = @bitCast(x);
        return .{ .neg = b >> 63 != 0, .exp = @intCast((b >> 52) & 0x7ff), .frac = b & 0xf_ffff_ffff_ffff };
    }
    const b: u32 = @bitCast(x);
    return .{ .neg = b >> 31 != 0, .exp = @intCast((b >> 23) & 0xff), .frac = @as(u64, b & 0x7f_ffff) << 29 };
}
pub fn recpe(comptime F: type, x: F) F {
    if (isNan(x)) return x;
    const p = parts(F, x);
    if (std.math.isInf(x)) return if (p.neg) -0.0 else 0.0;
    if (x == 0) return if (p.neg) -std.math.inf(F) else std.math.inf(F);
    if (F == f32 and (@as(u32, @bitCast(x)) & 0x7fff_ffff) < (1 << 21)) return if (p.neg) -std.math.inf(F) else std.math.inf(F);
    if (F == f64 and p.exp == 0 and p.frac < (1 << 42)) return if (p.neg) -std.math.inf(F) else std.math.inf(F);
    var exp = p.exp;
    var frac = p.frac;
    if (exp == 0) {
        if (frac < (1 << 51)) {
            exp = -1;
            frac *= 4;
        } else frac *= 2;
    }
    const scaled: u64 = 256 + (frac >> 44) % 256;
    const est: u64 = (((@as(u64, 1) << 19) / (scaled * 2 + 1) + 1) >> 1) & 0xff;
    var rexp: i32 = (if (F == f64) 2045 else 253) - exp;
    var rfrac: u64 = est << 44;
    if (rexp == 0) rfrac = rfrac / 2 + (1 << 51) else if (rexp == -1) {
        rfrac = rfrac / 4 + (1 << 50);
        rexp = 0;
    }
    return pack(F, p.neg, rexp, rfrac);
}
pub fn rsqrte(comptime F: type, x: F) F {
    if (isNan(x)) return x;
    const p = parts(F, x);
    if (x == 0) return if (p.neg) -std.math.inf(F) else std.math.inf(F);
    if (x < 0) return std.math.nan(F);
    if (std.math.isInf(x)) return 0;
    var exp = p.exp;
    var frac = p.frac;
    if (exp == 0) {
        // Normalise the subnormal in one step rather than doubling until bit 51 is set. frac is
        // non-zero here (x == 0 returned above) and under 2^52, so the count is 12..51.
        const shift: u6 = @intCast(@clz(frac) - 12);
        frac <<= shift;
        exp -= @as(i32, shift);
        frac = (frac % (1 << 51)) * 2;
    }
    const scaled: u64 = if (exp & 1 != 0) 128 + (frac >> 45) % 128 else 256 + (frac >> 44) % 256;
    const a: u64 = if (scaled < 256) scaled * 2 + 1 else (((scaled >> 1) << 1) + 1) << 1;
    // The reference walks b up from 512 while a * (b+1)^2 < 2^28, which is up to five hundred
    // 64-bit multiplies for one lane -- and jitfp does not emit frsqrte, so a compiled region pays
    // it too. The predicate is monotonic in b, so bisect for the same answer in nine steps.
    // `scaled` puts `a` in [257, 1022], so 1024 always satisfies it and 513 is where b starts.
    var lo: u64 = 513;
    var hi: u64 = 1024;
    while (lo < hi) {
        const mid = (lo + hi) / 2;
        if (a * mid * mid >= (1 << 28)) hi = mid else lo = mid + 1;
    }
    const est: u64 = (lo >> 1) & 0xff;
    return pack(F, false, @divTrunc((if (F == f64) @as(i32, 3068) else 380) - exp, 2), est << 44);
}
pub fn h2f(h: u16) f64 {
    const s: f64 = if (h & 0x8000 != 0) -1 else 1;
    const e: i32 = (h >> 10) & 0x1f;
    const m: f64 = @floatFromInt(h & 0x3ff);
    if (e == 0) return s * m * 0x1p-24;
    if (e == 31) return if (m != 0) std.math.nan(f64) else s * std.math.inf(f64);
    return std.math.ldexp(s * (1 + m / 1024), e - 15);
}
pub fn f2h(x0: f64) u16 {
    if (isNan(x0)) return 0x7e00;
    const s: u16 = if (std.math.signbit(x0)) 0x8000 else 0;
    const x = @abs(x0);
    if (std.math.isInf(x)) return s | 0x7c00;
    if (x == 0) return s;
    var e: i32 = @as(i32, @intCast((@as(u64, @bitCast(x)) >> 52) & 0x7ff)) - 1023;
    if (e < -14) {
        const m = rne(f64, x * 0x1p24);
        return if (m >= 1024) s | 0x0400 else s | @as(u16, @intFromFloat(m));
    }
    var m = rne(f64, (std.math.ldexp(x, -e) - 1) * 1024);
    if (m == 1024) {
        m = 0;
        e += 1;
    }
    if (e > 15) return s | 0x7c00;
    return s | (@as(u16, @intCast(e + 15)) << 10) | @as(u16, @intFromFloat(m));
}
pub fn f2hb(comptime F: type, b: std.meta.Int(.unsigned, @bitSizeOf(F))) u16 {
    const x: F = @bitCast(b);
    if (!isNan(x)) return f2h(x);
    const hi: u32 = @intCast(b >> (@bitSizeOf(F) - 32));
    return @intCast(((hi >> 16) & 0x8000) | 0x7e00 | ((hi >> (if (F == f32) 13 else 10)) & 0x1ff));
}
pub fn fcmp(a: anytype, b: @TypeOf(a)) u32 {
    if (isNan(a) or isNan(b)) return 0x3000_0000;
    if (a < b) return 0x8000_0000;
    if (a == b) return 0x6000_0000;
    return 0x2000_0000;
}
/// the carry-less product of two unsigned values, twice their width
pub fn pmul(comptime T: type, a: T, b: T) std.meta.Int(.unsigned, 2 * @bitSizeOf(T)) {
    const R = std.meta.Int(.unsigned, 2 * @bitSizeOf(T));
    var r: R = 0;
    for (0..@bitSizeOf(T)) |i| r ^= (@as(R, a) << @intCast(i)) & (@as(R, 0) -% ((b >> @intCast(i)) & 1));
    return r;
}
