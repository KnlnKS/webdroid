pub inline fn is(w: u32, mask: u32, val: u32) bool {
    return (w & mask) == val;
}
pub inline fn bits(w: u32, lo: u5, n: u6) u32 {
    return (w >> lo) & (@as(u32, 0xffff_ffff) >> @intCast(32 - @as(u32, n)));
}
pub inline fn sx(comptime T: type, v: u32, n: u5) T {
    const sh: u5 = @intCast(32 - @as(u32, n));
    return @as(i32, @bitCast(v << sh)) >> sh;
}
pub inline fn sxw(m: u64) u64 {
    return @bitCast(@as(i64, @as(i32, @bitCast(@as(u32, @truncate(m))))));
}
pub inline fn ones(k: u32) u64 {
    return if (k >= 64) ~@as(u64, 0) else (@as(u64, 1) << @intCast(k)) - 1;
}
pub inline fn bit(n: u8) u32 {
    return @as(u32, 1) << @intCast(n & 31);
}
pub inline fn extend(m: u64, option: u32) u64 {
    return switch (option & 7) {
        0 => m & 255,
        1 => m & 65535,
        2 => m & 0xffff_ffff,
        4 => @bitCast(@as(i64, @as(i8, @bitCast(@as(u8, @truncate(m)))))),
        5 => @bitCast(@as(i64, @as(i16, @bitCast(@as(u16, @truncate(m)))))),
        6 => sxw(m),
        else => m,
    };
}
