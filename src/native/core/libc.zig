// The libc calls a guest makes most: served here when their trampoline slot is bound to one of
// these, so memcpy and malloc never leave the core. Semantics are libc.ts's; the host keeps the
// rest, and switching the tracer on routes every call back to it.

const std = @import("std");
const abi = @import("abi.zig");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const a64 = @import("a64.zig");
const Cpu = cpu.Cpu;

pub const Fn = enum(u8) {
    none = 0,
    memcpy,
    memmove,
    memset,
    memcmp,
    memchr,
    strlen,
    strnlen,
    strcmp,
    strncmp,
    malloc,
    free,
    calloc,
    realloc,
    memalign,
    posix_memalign,
    malloc_usable_size,
    pthread_self,
    pthread_getspecific,
    pthread_setspecific,
};
/// pthread keys per thread: the table in Cpu.tls_tab (cpu.ts sizes it, pthread.ts caps the keys)
pub const TLS_KEYS = 256;
/// trampoline slot → Fn
pub const slot_fn: [*]u8 = @ptrFromInt(abi.KERN_BASE + 0xa0_0000);
pub var bypass: bool = false;
export fn host_bind(slot: u32, id: u32) void {
    slot_fn[slot] = @intCast(id);
}
export fn host_bypass(on: u32) void {
    bypass = on != 0;
}

inline fn arg(c: *Cpu, i: u32) u64 {
    return if (c.a64 != 0) c.x[i] else @as(u32, @truncate(c.x[i]));
}
inline fn ptr(c: *Cpu, i: u32) ?u32 {
    return a64.addr(c, arg(c, i));
}
inline fn ret(c: *Cpu, v: u64) void {
    c.x[0] = v;
}
/// the guest's address for a buffer offset
inline fn va(p: u32) u64 {
    return mem.va(p);
}
fn wrote(d: u32, n: u32) void {
    if (mem.page_flags[d >> abi.PAGE_SHIFT] | mem.page_flags[(d + n - 1) >> abi.PAGE_SHIFT] != 0) cpu.invalidate_range(d, n);
}
fn stp(c: *Cpu, a: u32, v: u64) bool {
    return if (c.a64 != 0) cpu.st(u64, c, a, v) else cpu.st(u32, c, a, @truncate(v));
}
fn setErrno(c: *Cpu, e: u32) void {
    mem.ptr(u32, c.errno_addr).* = e;
}
inline fn size() u64 {
    return @as(u64, @wasmMemorySize(0)) * 65536;
}

/// run the bound call; false for a bad address (the fault is set), leaving x0 as the result
pub fn call(c: *Cpu, id: u8) bool {
    switch (@as(Fn, @enumFromInt(id))) {
        .none => unreachable,
        .memcpy, .memmove => {
            const n: u32 = @truncate(arg(c, 2));
            if (n != 0) {
                const d = ptr(c, 0) orelse return false;
                const s = ptr(c, 1) orelse return false;
                mem.move(d, s, n);
                wrote(d, n);
            }
        },
        .memset => {
            const n: u32 = @truncate(arg(c, 2));
            if (n != 0) {
                const d = ptr(c, 0) orelse return false;
                @memset(mem.bytes(d)[0..n], @truncate(arg(c, 1)));
                wrote(d, n);
            }
        },
        .memcmp => {
            const n: u32 = @truncate(arg(c, 2));
            var r: i32 = 0;
            if (n != 0) {
                const x = ptr(c, 0) orelse return false;
                const y = ptr(c, 1) orelse return false;
                if (std.mem.findDiff(u8, mem.bytes(x)[0..n], mem.bytes(y)[0..n])) |i| r = @as(i32, mem.bytes(x)[i]) - @as(i32, mem.bytes(y)[i]);
            }
            ret(c, @bitCast(@as(i64, r)));
        },
        .memchr => {
            const n: u32 = @truncate(arg(c, 2));
            const ch: u8 = @truncate(arg(c, 1));
            var found: u64 = 0;
            if (n != 0) {
                const p = ptr(c, 0) orelse return false;
                if (std.mem.findScalar(u8, mem.bytes(p)[0..n], ch)) |i| found = va(p + @as(u32, @intCast(i)));
            }
            ret(c, found);
        },
        .strlen => {
            const p = ptr(c, 0) orelse return false;
            ret(c, std.mem.findSentinel(u8, 0, @as([*:0]const u8, @ptrFromInt(p))));
        },
        .strnlen => {
            const n: u32 = @truncate(arg(c, 1));
            const p = ptr(c, 0) orelse return false;
            ret(c, std.mem.findScalar(u8, mem.bytes(p)[0..n], 0) orelse n);
        },
        .strcmp, .strncmp => {
            const n: u32 = if (id == @intFromEnum(Fn.strncmp)) @truncate(arg(c, 2)) else 0x7fff_ffff;
            var r: i32 = 0;
            if (n != 0) {
                const x = ptr(c, 0) orelse return false;
                const y = ptr(c, 1) orelse return false;
                var i: u32 = 0;
                while (i < n) : (i += 1) {
                    const p = mem.bytes(x)[i];
                    const q = mem.bytes(y)[i];
                    if (p != q) {
                        r = @as(i32, p) - @as(i32, q);
                        break;
                    }
                    if (p == 0) break;
                }
            }
            ret(c, @bitCast(@as(i64, r)));
        },
        .malloc => ret(c, mem.malloc(@truncate(arg(c, 0)))),
        .free => {
            const p: u32 = @truncate(arg(c, 0));
            if (p != 0) {
                const q = ptr(c, 0) orelse return false;
                if (mem.free(q) == 0) {
                    c.fault_addr = q;
                    return false;
                }
            }
        },
        .calloc => ret(c, mem.calloc(@truncate(arg(c, 0)), @truncate(arg(c, 1)))),
        .realloc => {
            const p: u32 = if (arg(c, 0) == 0) 0 else (ptr(c, 0) orelse return false);
            ret(c, mem.realloc(p, @truncate(arg(c, 1))));
        },
        .memalign => {
            const al = arg(c, 0);
            const n = arg(c, 1);
            // the nearest power of two at or above the request, as bionic rounds it
            const alignment: u64 = if (al <= 1) 1 else @as(u64, 1) << @intCast(64 - @clz(al - 1));
            const p = if (alignment < size() and n < size()) mem.memalign(@intCast(alignment), @intCast(@max(n, 1))) else 0;
            if (p == 0) setErrno(c, 12);
            ret(c, p);
        },
        .posix_memalign => {
            const out = ptr(c, 0) orelse return false;
            const al = arg(c, 1);
            const n = arg(c, 2);
            const width: u64 = if (c.a64 != 0) 8 else 4;
            if (al < width or (al & (al - 1)) != 0) {
                ret(c, 22);
            } else if (al >= size() or n >= size()) {
                ret(c, 12);
            } else {
                const p = mem.memalign(@intCast(al), @intCast(@max(n, 1)));
                if (p == 0) ret(c, 12) else {
                    if (!stp(c, out, p)) return false;
                    ret(c, 0);
                }
            }
        },
        .malloc_usable_size => {
            const p: u32 = if (arg(c, 0) == 0) 0 else (ptr(c, 0) orelse return false);
            ret(c, mem.usable_size(p));
        },
        .pthread_self => ret(c, c.tid),
        .pthread_getspecific => {
            const k: u32 = @truncate(arg(c, 0));
            ret(c, if (k < TLS_KEYS) mem.ptr(u64, c.tls_tab + 8 * k).* else 0);
        },
        .pthread_setspecific => {
            const k: u32 = @truncate(arg(c, 0));
            if (k < TLS_KEYS) {
                mem.ptr(u64, c.tls_tab + 8 * k).* = arg(c, 1);
                ret(c, 0);
            } else ret(c, 22);
        },
    }
    return true;
}
