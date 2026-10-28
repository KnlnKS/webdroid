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
    crc32,
    adler32,
    __memcpy_chk,
    pthread_rwlock_rdlock,
    pthread_rwlock_tryrdlock,
    pthread_rwlock_wrlock,
    pthread_rwlock_trywrlock,
    pthread_rwlock_unlock,
    clock_gettime,
    floorf,
    ceilf,
    roundf,
    truncf,
    floor,
    ceil,
    round,
    trunc,
    bzero,
    __aeabi_memset,
    strcpy,
    strchr,
    strrchr,
    __tls_get_addr,
};
pub const Result = enum(u32) { done, fault, host };
/// The rwlock words src/native/libc32/pthread.ts keeps: state (reader count or RW_WRITER), writer tid, waiters.
/// Anything that must wait, or wake a waiter, goes to the host.
const RW_WRITER: u32 = 0x8000_0000;
const RW_TID = 4;
const RW_WAITERS = 8;
fn rwLock(c: *Cpu, write: bool, try_only: bool) Result {
    const a = ptr(c, 0) orelse return .fault;
    const s = mem.ld(u32, a);
    const busy = if (write) s != 0 else s & RW_WRITER != 0;
    if (busy and !try_only) return .host;
    if (busy) {
        ret(c, 16);
        return .done;
    }
    if (!cpu.st(u32, c, a, if (write) RW_WRITER else s + 1)) return .fault;
    if (write and !cpu.st(u32, c, a + RW_TID, c.tid)) return .fault;
    ret(c, 0);
    return .done;
}
fn rwUnlock(c: *Cpu) Result {
    const a = ptr(c, 0) orelse return .fault;
    const s = mem.ld(u32, a);
    const writer = s & RW_WRITER != 0;
    if (mem.ld(u32, a + RW_WAITERS) != 0 or s == 0 or (writer and mem.ld(u32, a + RW_TID) != c.tid)) return .host;
    if (!cpu.st(u32, c, a, if (writer) 0 else s - 1)) return .fault;
    ret(c, 0);
    return .done;
}
export fn libc_call(cp: u32, id: u32) u32 {
    abi.require(id != 0 and id < @typeInfo(Fn).@"enum".fields.len, "libc_call: unknown id");
    return @intFromEnum(call(@ptrFromInt(cp), @intCast(id)));
}
pub const TLS_KEYS = 256;
/// the TLS modules whose dynamic blocks a thread's table keeps after its keys, as dl.ts tlsAddress makes them
pub const TLS_MODULES = 64;
/// where in the table the module blocks start
pub const TLS_BLOCKS = 8 * TLS_KEYS;
pub const slot_fn: [*]u8 = @ptrFromInt(abi.KERN_SLOT_FN);
comptime {
    assert(@sizeOf(@TypeOf(slot_fn[0])) * abi.TRAMP_SLOTS <= abi.KERN_REFS - abi.KERN_SLOT_FN);
    // An id is stored as one byte per slot, so the table has to stay addressable by that byte.
    assert(@typeInfo(Fn).@"enum".fields.len <= 256);
}
pub var bypass: bool = false;
export fn host_bind(slot: u32, id: u32) void {
    abi.require(slot < abi.TRAMP_SLOTS, "host_bind: trampoline slot out of range");
    abi.require(id < @typeInfo(Fn).@"enum".fields.len, "host_bind: unknown id");
    slot_fn[slot] = @intCast(id);
}
export fn host_bypass(on: u32) void {
    bypass = on != 0;
}

/// an ARM32 register is its low word: a compiled region spills only that
inline fn arg(c: *Cpu, i: u32) u64 {
    return if (c.a64 != 0) c.x[i] else @as(u32, @truncate(c.x[i]));
}
inline fn ptr(c: *Cpu, i: u32) ?u32 {
    return a64.addr(c, arg(c, i));
}
const Miss = error{ Fault, Host };
/// argument i as a pointer a scan reads directly: one in an ARM32 process's window the host's bodies serve
fn scan(c: *Cpu, i: u32) Miss!u32 {
    const p = ptr(c, i) orelse return error.Fault;
    return if (p >= mem.window) error.Host else p;
}
inline fn miss(e: Miss) Result {
    return if (e == error.Host) .host else .fault;
}
/// whether argument i points at n backed bytes, committing a plane's writable pages under them
fn committed(c: *Cpu, i: u32, n: u32) bool {
    if (mem.commit_range(arg(c, i), n) != 0) return true;
    c.fault_addr = arg(c, i) & a64.TBI_MASK;
    return false;
}
inline fn ret(c: *Cpu, v: u64) void {
    c.x[0] = v;
}
fn wrote(d: u32, n: u32) void {
    _ = cpu.code_write(d, n);
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
    if (F == f32) return @bitCast(@as(u32, @truncate(arg(c, i))));
    return @bitCast(arg(c, 2 * i) | arg(c, 2 * i + 1) << 32);
}
inline fn fret(c: *Cpu, comptime F: type, v: F) void {
    if (c.a64 != 0) {
        c.v[0] = @splat(0);
        vreg(c, F, 0).* = v;
    } else if (F == f32) c.x[0] = @as(u32, @bitCast(v)) else {
        const b: u64 = @bitCast(v);
        c.x[0] = @as(u32, @truncate(b));
        c.x[1] = b >> 32;
    }
}
fn fmod(comptime F: type, a: F, b: F) F {
    return if (b == 0) std.math.nan(F) else @rem(a, b);
}
/// the math functions, in single precision for the names ending in f
fn math(c: *Cpu, comptime id: Fn) void {
    const F = if (comptime std.mem.endsWith(u8, @tagName(id), "f")) f32 else f64;
    const x = farg(c, F, 0);
    fret(c, F, switch (id) {
        .sinf, .sin => @sin(x),
        .cosf, .cos => @cos(x),
        .tanf, .tan => @tan(x),
        .expf, .exp => @exp(x),
        .logf, .log => @log(x),
        .sqrtf, .sqrt => @sqrt(x),
        .floorf, .floor => @floor(x),
        .ceilf, .ceil => @ceil(x),
        .roundf, .round => @round(x),
        .truncf, .trunc => @trunc(x),
        .powf, .pow => std.math.pow(F, x, farg(c, F, 1)),
        .atan2f, .atan2 => std.math.atan2(x, farg(c, F, 1)),
        .fmodf, .fmod => fmod(F, x, farg(c, F, 1)),
        else => @compileError(@tagName(id) ++ " has no case in call"),
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

const crc_table = blk: {
    @setEvalBranchQuota(20_000);
    var table: [8][256]u32 = undefined;
    for (0..256) |i| {
        var crc: u32 = @intCast(i);
        for (0..8) |_| crc = (crc >> 1) ^ (if (crc & 1 != 0) @as(u32, 0xedb88320) else 0);
        table[0][i] = crc;
    }
    for (1..8) |slice| for (0..256) |i| {
        const crc = table[slice - 1][i];
        table[slice][i] = table[0][@as(u8, @truncate(crc))] ^ (crc >> 8);
    };
    break :blk table;
};

fn crc32(initial: u32, input: []const u8) u32 {
    var crc = ~initial;
    var i: usize = 0;
    while (i + 8 <= input.len) : (i += 8) {
        crc ^= std.mem.readInt(u32, input[i..][0..4], .little);
        crc = crc_table[7][@as(u8, @truncate(crc))] ^ crc_table[6][@as(u8, @truncate(crc >> 8))] ^
            crc_table[5][@as(u8, @truncate(crc >> 16))] ^ crc_table[4][crc >> 24] ^
            crc_table[3][input[i + 4]] ^ crc_table[2][input[i + 5]] ^ crc_table[1][input[i + 6]] ^ crc_table[0][input[i + 7]];
    }
    while (i < input.len) : (i += 1) crc = crc_table[0][@as(u8, @truncate(crc ^ input[i]))] ^ (crc >> 8);
    return ~crc;
}

fn checksum(c: *Cpu, id: Fn) Result {
    const address = arg(c, 1);
    if (address == 0) {
        ret(c, if (id == .crc32) 0 else 1);
        return .done;
    }
    const p = ptr(c, 1) orelse return .fault;
    const n: u32 = @truncate(arg(c, 2));
    var sum: u32 = @truncate(arg(c, 0));
    if (p < mem.window) {
        ret(c, if (id == .crc32) crc32(sum, mem.bytes(p)[0..n]) else std.hash.Adler32.permute(sum, mem.bytes(p)[0..n]));
        return .done;
    }
    if (!mem.windowAccess(c, p, n, false)) return .fault;
    // the window's bytes come over a chunk at a time, which both sums continue across
    var chunk: [4096]u8 = undefined;
    var at: u32 = 0;
    while (at < n) : (at += chunk.len) {
        const k = @min(n - at, chunk.len);
        mem.shm_copy(@intFromPtr(&chunk), p + at, k);
        sum = if (id == .crc32) crc32(sum, chunk[0..k]) else std.hash.Adler32.permute(sum, chunk[0..k]);
    }
    ret(c, sum);
    return .done;
}
fn fill(c: *Cpu, n: u32, v: u8) Result {
    if (n == 0) return .done;
    if (!committed(c, 0, n)) return .fault;
    const d = ptr(c, 0) orelse return .fault;
    if (d >= mem.window) {
        if (!mem.windowAccess(c, d, n, true)) return .fault;
        mem.shm_fill(d, v, n);
    } else @memset(mem.bytes(d)[0..n], v);
    wrote(d, n);
    return .done;
}
extern "env" fn uptime_ms() f64;
extern "env" fn wall_ms() f64;
/// the clock abi.WALL_CLOCKS picks for the id
pub fn clockGettime(c: *Cpu) Result {
    const id: u32 = @truncate(arg(c, 0));
    const ts = ptr(c, 1) orelse return .fault;
    const ms = if (id < 32 and (abi.WALL_CLOCKS >> @as(u5, @intCast(id))) & 1 != 0) wall_ms() else uptime_ms();
    const sec = @floor(ms / 1000);
    const nsec: u64 = @intFromFloat(@floor((ms - sec * 1000) * 1e6));
    const half: u32 = if (c.a64 != 0) 8 else 4;
    if (!stp(c, ts, @intFromFloat(sec)) or !stp(c, ts + half, nsec)) return .fault;
    ret(c, 0);
    return .done;
}
pub fn call(c: *Cpu, id: u8) Result {
    const f: Fn = @enumFromInt(id);
    switch (f) {
        .none => unreachable,
        .sincosf => return sincos(f32, c),
        .sincos => return sincos(f64, c),
        .crc32, .adler32 => return checksum(c, f),
        .clock_gettime => return clockGettime(c),
        .pthread_mutex_lock, .pthread_mutex_trylock => {
            const a = ptr(c, 0) orelse return .fault;
            const w = mem.ld(u32, a);
            const kind = w & 0xc000;
            const constants = w & 0xe000;
            if (w & 3 == 0) {
                const owner = if (kind == 0) 0 else c.tid << 16;
                if (!cpu.st(u32, c, a, constants | 1 | owner)) return .fault;
            } else if (kind != 0 and w >> 16 == c.tid) {
                if (kind == 0x8000 or w & 0x3ffc == 0x3ffc) return .host;
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
            const kind = w & 0xc000;
            if (w & 3 != 1 or (kind != 0 and w >> 16 != c.tid)) return .host;
            if (!cpu.st(u32, c, a, if (kind != 0 and w & 0x3ffc != 0) w - 4 else w & 0xe000)) return .fault;
            ret(c, 0);
        },
        .pthread_rwlock_rdlock, .pthread_rwlock_tryrdlock => return rwLock(c, false, f == .pthread_rwlock_tryrdlock),
        .pthread_rwlock_wrlock, .pthread_rwlock_trywrlock => return rwLock(c, true, f == .pthread_rwlock_trywrlock),
        .pthread_rwlock_unlock => return rwUnlock(c),
        .memcpy, .memmove, .__memcpy_chk => {
            if (f == .__memcpy_chk and (arg(c, 2) > arg(c, 3) or arg(c, 2) > std.math.maxInt(u32))) return .host;
            const n: u32 = @truncate(arg(c, 2));
            if (n != 0) {
                if (!committed(c, 0, n) or !committed(c, 1, n)) return .fault;
                const d = ptr(c, 0) orelse return .fault;
                const s = ptr(c, 1) orelse return .fault;
                if (d >= mem.window or s >= mem.window) {
                    if (!(d < mem.window or mem.windowAccess(c, d, n, true)) or !(s < mem.window or mem.windowAccess(c, s, n, false))) return .fault;
                    mem.shm_copy(d, s, n);
                } else mem.move(d, s, n);
                wrote(d, n);
            }
        },
        .memset => return fill(c, @truncate(arg(c, 2)), @truncate(arg(c, 1))),
        .bzero => return fill(c, @truncate(arg(c, 1)), 0),
        .__aeabi_memset => return fill(c, @truncate(arg(c, 1)), @truncate(arg(c, 2))),
        .strcpy => {
            const d = scan(c, 0) catch |e| return miss(e);
            const s = scan(c, 1) catch |e| return miss(e);
            const n: u32 = @intCast(std.mem.findSentinel(u8, 0, @as([*:0]const u8, @ptrFromInt(s))) + 1);
            if (!committed(c, 0, n)) return .fault;
            mem.move(d, s, n);
            wrote(d, n);
        },
        .strchr, .strrchr => {
            const p = scan(c, 0) catch |e| return miss(e);
            const ch: u8 = @truncate(arg(c, 1));
            const s = std.mem.span(@as([*:0]const u8, @ptrFromInt(p)));
            const i = if (ch == 0) s.len else if (f == .strchr) std.mem.findScalar(u8, s, ch) else std.mem.findScalarLast(u8, s, ch);
            ret(c, if (i) |k| mem.va(p + @as(u32, @intCast(k))) else 0);
        },
        .__tls_get_addr => {
            const index = ptr(c, 0) orelse return .fault;
            const module = mem.ld(u32, index);
            if (c.tls_tab == 0 or module >= TLS_MODULES) return .host;
            const block = mem.ld(u32, c.tls_tab + TLS_BLOCKS + 4 * module);
            if (block == 0) return .host;
            ret(c, block +% mem.ld(u32, index + 4));
        },
        .memcmp => {
            const n: u32 = @truncate(arg(c, 2));
            var r: i32 = 0;
            if (n != 0) {
                const x = scan(c, 0) catch |e| return miss(e);
                const y = scan(c, 1) catch |e| return miss(e);
                if (std.mem.findDiff(u8, mem.bytes(x)[0..n], mem.bytes(y)[0..n])) |i| r = @as(i32, mem.bytes(x)[i]) - @as(i32, mem.bytes(y)[i]);
            }
            ret(c, @bitCast(@as(i64, r)));
        },
        .memchr => {
            const n: u32 = @truncate(arg(c, 2));
            const ch: u8 = @truncate(arg(c, 1));
            var found: u64 = 0;
            if (n != 0) {
                const p = scan(c, 0) catch |e| return miss(e);
                if (std.mem.findScalar(u8, mem.bytes(p)[0..n], ch)) |i| found = mem.va(p + @as(u32, @intCast(i)));
            }
            ret(c, found);
        },
        .strlen => {
            const p = scan(c, 0) catch |e| return miss(e);
            ret(c, std.mem.findSentinel(u8, 0, @as([*:0]const u8, @ptrFromInt(p))));
        },
        .strnlen => {
            const n: u32 = @truncate(arg(c, 1));
            const p = scan(c, 0) catch |e| return miss(e);
            ret(c, std.mem.findScalar(u8, mem.bytes(p)[0..n], 0) orelse n);
        },
        .strcmp, .strncmp => {
            const n: u32 = if (f == .strncmp) @truncate(arg(c, 2)) else 0x7fff_ffff;
            var r: i32 = 0;
            if (n != 0) {
                const x = scan(c, 0) catch |e| return miss(e);
                const y = scan(c, 1) catch |e| return miss(e);
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
        // bionic keeps the thread's pthread_internal_t* in TLS slot 1
        .pthread_self => {
            const tls: u32 = @truncate(c.tls);
            ret(c, if (c.a64 != 0) mem.ptr(u64, tls + 8).* else mem.ptr(u32, tls + 4).*);
        },
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
        inline else => |g| math(c, g),
    }
    return .done;
}
