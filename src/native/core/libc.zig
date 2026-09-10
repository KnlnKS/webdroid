const std = @import("std");
const abi = @import("abi.zig");
const assert = std.debug.assert;
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
    pthread_mutex_lock,
    pthread_mutex_trylock,
    pthread_mutex_unlock,
    sinf,
    cosf,
    tanf,
    expf,
    logf,
    sqrtf,
    sin,
    cos,
    tan,
    exp,
    log,
    sqrt,
    powf,
    atan2f,
    fmodf,
    pow,
    atan2,
    fmod,
    sincosf,
    sincos,
};
pub const Result = enum(u32) { done, fault, host };
export fn libc_call(cp: u32, id: u32) u32 {
    return @intFromEnum(call(@ptrFromInt(cp), @intCast(id)));
}
pub const TLS_KEYS = 256;
pub const slot_fn: [*]u8 = @ptrFromInt(abi.KERN_SLOT_FN);
comptime {
    assert(@sizeOf(@TypeOf(slot_fn[0])) * abi.TRAMP_SLOTS <= abi.KERN_DEAD - abi.KERN_SLOT_FN);
    // An id is stored as one byte per slot, so the table has to stay addressable by that byte.
    assert(@typeInfo(Fn).@"enum".fields.len <= 256);
}
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
inline fn va(p: u32) u64 {
    return mem.va(p);
}
fn wrote(d: u32, n: u32) void {
    assert(n != 0);
    assert(@as(u64, d) + n <= 0x1_0000_0000);
    // Every page the write covers, not just its ends: a copy of three pages or more can land on
    // executed code in the middle of its range and leave the ends untouched. One byte read per
    // 4 KiB written is nothing against the copy itself.
    const first = d >> abi.PAGE_SHIFT;
    const last = (d + n - 1) >> abi.PAGE_SHIFT;
    for (mem.page_flags[first .. last + 1]) |f| if (f != 0) return cpu.invalidate_range(d, n);
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
inline fn vreg(c: *Cpu, comptime T: type, i: u32) *align(16) T {
    return @ptrCast(&c.v[i]);
}
inline fn farg(c: *Cpu, comptime F: type, i: u32) F {
    if (c.a64 != 0) return vreg(c, F, i).*;
    if (F == f32) return @bitCast(@as(u32, @truncate(c.x[i])));
    return @bitCast(@as(u64, @truncate(c.x[2 * i])) | (@as(u64, @truncate(c.x[2 * i + 1])) << 32));
}
inline fn fret(c: *Cpu, comptime F: type, v: F) void {
    if (c.a64 != 0) {
        c.v[0] = @splat(0);
        vreg(c, F, 0).* = v;
    } else if (F == f32) c.x[0] = @as(u32, @bitCast(v)) else {
        const b: u64 = @bitCast(v);
        c.x[0] = @truncate(b);
        c.x[1] = b >> 32;
    }
}
fn fmod(comptime F: type, a: F, b: F) F {
    return if (b == 0) std.math.nan(F) else @rem(a, b);
}
fn one(comptime F: type, c: *Cpu, id: Fn) void {
    const x = farg(c, F, 0);
    fret(c, F, switch (id) {
        .sinf, .sin => @sin(x),
        .cosf, .cos => @cos(x),
        .tanf, .tan => @tan(x),
        .expf, .exp => @exp(x),
        .logf, .log => @log(x),
        else => @sqrt(x),
    });
}
fn two(comptime F: type, c: *Cpu, id: Fn) void {
    const x = farg(c, F, 0);
    const y = farg(c, F, 1);
    fret(c, F, switch (id) {
        .powf, .pow => std.math.pow(F, x, y),
        .atan2f, .atan2 => std.math.atan2(x, y),
        else => fmod(F, x, y),
    });
}
fn sincos(comptime F: type, c: *Cpu) Result {
    const x = farg(c, F, 0);
    const skip: u32 = if (c.a64 != 0) 0 else if (F == f32) 1 else 2;
    const s = ptr(c, skip) orelse return .fault;
    const k = ptr(c, skip + 1) orelse return .fault;
    if (!cpu.st(F, c, s, @sin(x)) or !cpu.st(F, c, k, @cos(x))) return .fault;
    return .done;
}

pub fn call(c: *Cpu, id: u8) Result {
    const f: Fn = @enumFromInt(id);
    switch (f) {
        .none => unreachable,
        .sinf, .cosf, .tanf, .expf, .logf, .sqrtf => one(f32, c, f),
        .sin, .cos, .tan, .exp, .log, .sqrt => one(f64, c, f),
        .powf, .atan2f, .fmodf => two(f32, c, f),
        .pow, .atan2, .fmod => two(f64, c, f),
        .sincosf => return sincos(f32, c),
        .sincos => return sincos(f64, c),
        .pthread_mutex_lock, .pthread_mutex_trylock => {
            const a = ptr(c, 0) orelse return .fault;
            const w = mem.ld(u32, a);
            if (w & 3 == 0) {
                if (!cpu.st(u32, c, a, (w & 0xc000) | 1 | (c.tid << 16))) return .fault;
            } else if (w >> 16 == c.tid and w & 0x3ffc != 0x3ffc) {
                if (!cpu.st(u32, c, a, w + 4)) return .fault;
            } else if (f == .pthread_mutex_trylock) {
                ret(c, 16);
                return .done;
            } else return .host;
            ret(c, 0);
        },
        .pthread_mutex_unlock => {
            const a = ptr(c, 0) orelse return .fault;
            const w = mem.ld(u32, a);
            if (w & 3 != 1 or w >> 16 != c.tid) return .host;
            if (!cpu.st(u32, c, a, if (w & 0x3ffc != 0) w - 4 else w & 0xc000)) return .fault;
            ret(c, 0);
        },
        .memcpy, .memmove => {
            const n: u32 = @truncate(arg(c, 2));
            if (n != 0) {
                const d = ptr(c, 0) orelse return .fault;
                const s = ptr(c, 1) orelse return .fault;
                mem.move(d, s, n);
                wrote(d, n);
            }
        },
        .memset => {
            const n: u32 = @truncate(arg(c, 2));
            if (n != 0) {
                const d = ptr(c, 0) orelse return .fault;
                @memset(mem.bytes(d)[0..n], @truncate(arg(c, 1)));
                wrote(d, n);
            }
        },
        .memcmp => {
            const n: u32 = @truncate(arg(c, 2));
            var r: i32 = 0;
            if (n != 0) {
                const x = ptr(c, 0) orelse return .fault;
                const y = ptr(c, 1) orelse return .fault;
                if (std.mem.findDiff(u8, mem.bytes(x)[0..n], mem.bytes(y)[0..n])) |i| r = @as(i32, mem.bytes(x)[i]) - @as(i32, mem.bytes(y)[i]);
            }
            ret(c, @bitCast(@as(i64, r)));
        },
        .memchr => {
            const n: u32 = @truncate(arg(c, 2));
            const ch: u8 = @truncate(arg(c, 1));
            var found: u64 = 0;
            if (n != 0) {
                const p = ptr(c, 0) orelse return .fault;
                if (std.mem.findScalar(u8, mem.bytes(p)[0..n], ch)) |i| found = va(p + @as(u32, @intCast(i)));
            }
            ret(c, found);
        },
        .strlen => {
            const p = ptr(c, 0) orelse return .fault;
            ret(c, std.mem.findSentinel(u8, 0, @as([*:0]const u8, @ptrFromInt(p))));
        },
        .strnlen => {
            const n: u32 = @truncate(arg(c, 1));
            const p = ptr(c, 0) orelse return .fault;
            ret(c, std.mem.findScalar(u8, mem.bytes(p)[0..n], 0) orelse n);
        },
        .strcmp, .strncmp => {
            const n: u32 = if (id == @intFromEnum(Fn.strncmp)) @truncate(arg(c, 2)) else 0x7fff_ffff;
            var r: i32 = 0;
            if (n != 0) {
                const x = ptr(c, 0) orelse return .fault;
                const y = ptr(c, 1) orelse return .fault;
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
                const q = ptr(c, 0) orelse return .fault;
                if (mem.free(q) == 0) {
                    c.fault_addr = q;
                    return .fault;
                }
            }
        },
        .calloc => ret(c, mem.calloc(@truncate(arg(c, 0)), @truncate(arg(c, 1)))),
        .realloc => {
            const p: u32 = if (arg(c, 0) == 0) 0 else (ptr(c, 0) orelse return .fault);
            ret(c, mem.realloc(p, @truncate(arg(c, 1))));
        },
        .memalign => {
            const al = arg(c, 0);
            const n = arg(c, 1);
            const alignment: u64 = if (al <= 1) 1 else @as(u64, 1) << @intCast(64 - @clz(al - 1));
            const p = if (alignment < size() and n < size()) mem.memalign(@intCast(alignment), @intCast(@max(n, 1))) else 0;
            if (p == 0) setErrno(c, 12);
            ret(c, p);
        },
        .posix_memalign => {
            const out = ptr(c, 0) orelse return .fault;
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
                    if (!stp(c, out, p)) return .fault;
                    ret(c, 0);
                }
            }
        },
        .malloc_usable_size => {
            const p: u32 = if (arg(c, 0) == 0) 0 else (ptr(c, 0) orelse return .fault);
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
    return .done;
}
