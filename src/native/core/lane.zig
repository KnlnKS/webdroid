//! Lanes: the instances of a process's core that run its threads at once over the one memory
//! (src/native/lanes.ts). The process Worker's own instance is lane 0. What the lanes share outside
//! a thread's registers (the allocators, planes, decoded pages and the JIT's queue) changes under
//! one lock, which a lane may take again while it holds it. A decoded page dropped while a lane is
//! in a slice may still be read by it, so the page's block is reused only once every lane has left
//! the slice it was in (cpu.zig's retired blocks).
const std = @import("std");

pub const MAX = 16;
/// this instance's lane
pub threadlocal var id: u32 = 0;
/// the lane holding the lock, plus one; 0 when it is free
var owner: u32 = 0;
/// how many times the owner holds it; only the owner touches it
var depth: u32 = 0;
/// the generation each lane entered its slice in, 0 while it runs none
var active = [_]u32{0} ** MAX;
/// advanced as each decoded page is retired
var gen: u32 = 1;

export fn lane_init(lane: u32) void {
    id = lane;
}
/// this lane left its slice, or trapped in it, and holds nothing any more
pub fn reset() void {
    if (@atomicLoad(u32, &owner, .seq_cst) == id + 1) {
        depth = 0;
        @atomicStore(u32, &owner, 0, .seq_cst);
    }
    @atomicStore(u32, &active[id], 0, .seq_cst);
}

pub fn lock() void {
    const me = id + 1;
    if (@atomicLoad(u32, &owner, .monotonic) == me) {
        depth += 1;
        return;
    }
    while (@cmpxchgWeak(u32, &owner, 0, me, .acquire, .monotonic) != null) std.atomic.spinLoopHint();
    depth = 1;
}
pub fn unlock() void {
    depth -= 1;
    if (depth == 0) @atomicStore(u32, &owner, 0, .release);
}

/// A lane enters under the lock, so it never starts reading planes lane 0 is moving (quiesce).
pub fn enter() void {
    lock();
    defer unlock();
    @atomicStore(u32, &active[id], @atomicLoad(u32, &gen, .seq_cst), .seq_cst);
}
pub fn leave() void {
    @atomicStore(u32, &active[id], 0, .seq_cst);
}
/// the generation what is retired now belongs to (under the lock)
pub fn retire() u32 {
    const g = gen;
    @atomicStore(u32, &gen, g + 1, .seq_cst);
    return g;
}
/// the oldest generation a lane may still be reading: what was retired before it is free
pub fn floor() u32 {
    var f: u32 = std.math.maxInt(u32);
    for (&active) |*a| {
        const g = @atomicLoad(u32, a, .seq_cst);
        if (g != 0) f = @min(f, g);
    }
    return f;
}
/// Lane 0's wait (under the lock) until no other lane is in a slice that may hold a translation into
/// a plane it is about to move. It lets go of the lock meanwhile: true when it did, after which the
/// caller reads again whatever it relies on.
pub fn quiesce() bool {
    std.debug.assert(id == 0);
    if (!busy()) return false;
    const d = depth;
    depth = 0;
    @atomicStore(u32, &owner, 0, .release);
    while (busy()) std.atomic.spinLoopHint();
    lock();
    depth = d;
    return true;
}
fn busy() bool {
    for (active[1..]) |*a| if (@atomicLoad(u32, a, .seq_cst) != 0) return true;
    return false;
}

// Guest memory's atomics at a (aligned to T): Zig's builtins stop at 32 bits on wasm32, so the
// 64-bit forms are written out.
pub inline fn load(comptime T: type, a: u32) T {
    if (T == u64) return asm volatile ("local.get %[a]\ni64.atomic.load 0\nlocal.set %[r]"
        : [r] "=r" (-> u64),
        : [a] "r" (a),
        : .{ .memory = true });
    return @atomicLoad(T, @as(*T, @ptrFromInt(a)), .seq_cst);
}
pub inline fn store(comptime T: type, a: u32, v: T) void {
    if (T == u64) return asm volatile ("local.get %[a]\nlocal.get %[v]\ni64.atomic.store 0"
        :
        : [a] "r" (a), [v] "r" (v),
        : .{ .memory = true });
    @atomicStore(T, @as(*T, @ptrFromInt(a)), v, .seq_cst);
}
/// compare and swap: what a held
pub inline fn cas(comptime T: type, a: u32, expected: T, new: T) T {
    if (T == u64) return asm volatile ("local.get %[a]\nlocal.get %[e]\nlocal.get %[n]\ni64.atomic.rmw.cmpxchg 0\nlocal.set %[r]"
        : [r] "=r" (-> u64),
        : [a] "r" (a), [e] "r" (expected), [n] "r" (new),
        : .{ .memory = true });
    return @cmpxchgStrong(T, @as(*T, @ptrFromInt(a)), expected, new, .seq_cst, .seq_cst) orelse expected;
}
pub inline fn rmw(comptime T: type, comptime op: std.builtin.AtomicRmwOp, a: u32, v: T) T {
    if (T == u64) {
        const name = switch (op) {
            .Add => "add",
            .And => "and",
            .Or => "or",
            .Xor => "xor",
            .Xchg => "xchg",
            else => @compileError("rmw: no i64 form"),
        };
        return asm volatile ("local.get %[a]\nlocal.get %[v]\ni64.atomic.rmw." ++ name ++ " 0\nlocal.set %[r]"
            : [r] "=r" (-> u64),
            : [a] "r" (a), [v] "r" (v),
            : .{ .memory = true });
    }
    return @atomicRmw(T, @as(*T, @ptrFromInt(a)), op, v, .seq_cst);
}
pub inline fn fence() void {
    asm volatile ("atomic.fence" ::: .{ .memory = true });
}
