// The native core: guest memory and the CPU tier, compiled to wasm32 with the guest's memory
// imported so a guest address is a linear-memory offset. Built by scripts/build-core.ts.

const std = @import("std");
pub const abi = @import("abi.zig");
pub const mem = @import("mem.zig");

extern "env" fn js_panic(ptr: [*]const u8, len: usize) noreturn;
pub const panic = std.debug.FullPanic(struct {
    fn f(msg: []const u8, _: ?usize) noreturn {
        js_panic(msg.ptr, msg.len);
    }
}.f);

comptime {
    _ = abi;
    _ = mem;
}
