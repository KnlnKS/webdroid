const std = @import("std");
pub const mem = @import("mem.zig");
pub const plane = @import("plane.zig");
pub const cpu = @import("cpu.zig");
pub const libc = @import("libc.zig");
pub const jit = @import("jit.zig");
pub const lane = @import("lane.zig");

extern "env" fn js_panic(ptr: [*]const u8, len: usize) noreturn;
pub const panic = std.debug.FullPanic(struct {
    fn f(msg: []const u8, _: ?usize) noreturn {
        js_panic(msg.ptr, msg.len);
    }
}.f);

comptime {
    _ = mem;
    _ = plane;
    _ = cpu;
    _ = libc;
    _ = jit;
    _ = lane;
}
