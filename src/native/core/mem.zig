const std = @import("std");
const abi = @import("abi.zig");
const cpu = @import("cpu.zig");
const assert = std.debug.assert;

const PAGE_SHIFT = abi.PAGE_SHIFT;
const PAGE_SIZE = abi.PAGE_SIZE;
const MAX_PAGES: u32 = abi.MEM_SIZE_A64 >> PAGE_SHIFT;

pub inline fn ptr(comptime T: type, a: u32) *align(1) T {
    return @ptrFromInt(a);
}
pub inline fn bytes(a: u32) [*]u8 {
    return @ptrFromInt(a);
}
pub inline fn ld(comptime T: type, a: u32) T {
    return ptr(T, a).*;
}
fn fill(a: u32, v: u8, n: u32) void {
    @memset(bytes(a)[0..n], v);
}
pub fn move(d: u32, s: u32, n: u32) void {
    @memmove(bytes(d)[0..n], bytes(s)[0..n]);
}

const FREE = 0;
const RESERVED = 1;
const USED = 2;
const IMAGE = 3;
const pages: [*]u8 = @ptrFromInt(abi.KERN_PAGES);
pub const page_flags: [*]u8 = @ptrFromInt(abi.KERN_PAGE_FLAGS);
const big_len: [*]u32 = @ptrFromInt(abi.KERN_BIG_LEN);
comptime {
    assert(@sizeOf(@TypeOf(pages[0])) * abi.PAGE_INDEX_MAX <= abi.KERN_PAGE_FLAGS - abi.KERN_PAGES);
    assert(@sizeOf(@TypeOf(page_flags[0])) * abi.PAGE_INDEX_MAX <= abi.KERN_BIG_LEN - abi.KERN_PAGE_FLAGS);
    assert(@sizeOf(@TypeOf(big_len[0])) * abi.PAGE_INDEX_MAX <= abi.KERN_DECODED - abi.KERN_BIG_LEN);
}
inline fn pageOf(a: u32) u32 {
    return a >> PAGE_SHIFT;
}

const CLASS_STEP = 16;
const SMALL_MAX = 1024;
const PAGE_MAX = 0x40000;
const HDR = 16;
var small_heads = [_]u32{0} ** (SMALL_MAX / CLASS_STEP + 1);
var big_heads = [_]u32{0} ** 32;
comptime {
    // classSize rounds a small request up to a CLASS_STEP multiple and headFor divides by it, so
    // the largest small class has to be the last slot rather than one past it.
    assert(SMALL_MAX % CLASS_STEP == 0);
    assert(SMALL_MAX / CLASS_STEP + 1 == small_heads.len);
    assert(PAGE_MAX > SMALL_MAX);
}
var mem_size: u32 = abi.MEM_SIZE_INITIAL;
var heap_top: u32 = abi.ARENA_BASE;
var heap_peak: u32 = 0;
var blocks: u32 = 0;
var used: u64 = 0;
var module_bot: u32 = abi.MEM_SIZE_INITIAL;
var stack_top: u32 = abi.STACK_BASE;
var host_top: u32 = abi.HOST_DATA;

fn classSize(n: u32) u32 {
    if (n <= SMALL_MAX) return @max(CLASS_STEP, (n + CLASS_STEP - 1) & ~@as(u32, CLASS_STEP - 1));
    const k: u5 = @intCast(31 - @clz(n - 1));
    const q = @as(u32, 1) << (k - 2);
    return ((n + q - 1) / q) * q;
}
fn bigIdx(cs: u32) usize {
    assert(cs > SMALL_MAX);
    assert(cs <= PAGE_MAX);
    const k: u5 = @intCast(31 - @clz(cs - 1));
    const i = (@as(usize, k) - 10) * 4 + (cs >> (k - 2)) - 5;
    assert(i < big_heads.len);
    return i;
}

fn findRun(n: u32, allow: u8, alignment: u32, phantom_in: bool) u32 {
    const end = pageOf(if (pool_base != 0) pool_base else module_bot);
    const top: u32 = abi.PAGE_INDEX_MAX;
    const phantom = phantom_in and pool_base == 0;
    var s = (pageOf(abi.ARENA_BASE) + alignment - 1) & ~(alignment - 1);
    while (s < end and s + n <= top) : (s = (s + alignment) & ~(alignment - 1)) {
        var j = s;
        while (j < s + n and j < end and pages[j] <= allow) j += 1;
        if (j == s + n or (j == end and phantom)) return s * PAGE_SIZE;
        if (j < end) s = j;
    }
    return 0;
}
fn bump(n: u32) u32 {
    var p = heap_top;
    while (true) {
        const a = pageOf(p);
        const b = pageOf(p + n + PAGE_SIZE - 1);
        if (b > pageOf(if (pool_base != 0) pool_base else module_bot)) return 0;
        var j = a + @as(u32, if (p & (PAGE_SIZE - 1) != 0) 1 else 0);
        while (j < b and pages[j] == FREE) j += 1;
        if (j == b) {
            heap_top = p + n;
            if (heap_top > heap_peak) heap_peak = heap_top;
            @memset(pages[a..b], USED);
            return p;
        }
        p = (j + 1) * PAGE_SIZE;
    }
}

inline fn isBig(p: u32) ?u32 {
    const n = big_len[pageOf(p)];
    return if (p & (PAGE_SIZE - 1) == 0 and n != 0) n else null;
}
fn mapBig(n: u32, alignment: u32) u32 {
    const p = map_pages(n, 0, alignment);
    if (p != 0) {
        big_len[pageOf(p)] = n;
        blocks += 1;
        used += n;
    }
    return p;
}
inline fn headFor(cs: u32) *u32 {
    return if (cs <= SMALL_MAX) &small_heads[cs / CLASS_STEP] else &big_heads[bigIdx(cs)];
}

pub export fn malloc(n: u32) u32 {
    if (n > PAGE_MAX) return mapBig(n, PAGE_SIZE);
    const cs = classSize(n);
    const head = headFor(cs);
    var p = head.*;
    if (p != 0) head.* = ld(u32, p) else {
        p = bump(cs + HDR);
        if (p == 0) return 0;
        p += HDR;
    }
    _ = cpu.code_write(p - HDR, cs + HDR);
    ptr(u32, p - 8).* = 0;
    ptr(u32, p - 4).* = cs;
    blocks += 1;
    used += cs;
    return p;
}
pub export fn free(p_in: u32) u32 {
    if (p_in == 0) return 1;
    var p = p_in;
    if (isBig(p)) |n| {
        big_len[pageOf(p)] = 0;
        blocks -= 1;
        used -= n;
        _ = unmap_pages(p, n);
        return 1;
    }
    const own = ld(u32, p - 8);
    if (own != 0) p = own;
    const cs = ld(u32, p - 4);
    if (cs == 0 or cs > PAGE_MAX or (cs & 15) != 0) return 0;
    blocks -= 1;
    used -= cs;
    const head = headFor(cs);
    _ = cpu.code_write(p, 4);
    ptr(u32, p).* = head.*;
    head.* = p;
    return 1;
}
pub fn usable_size(p: u32) u32 {
    if (p == 0) return 0;
    return isBig(p) orelse ld(u32, p - 4);
}
pub export fn realloc(p: u32, n: u32) u32 {
    if (p == 0) return malloc(n);
    if (n == 0) {
        _ = free(p);
        return 0;
    }
    const cur = usable_size(p);
    if (n <= cur and n >= cur >> 2 and isBig(p) == null) return p;
    const q = malloc(n);
    if (q == 0) return 0;
    move(q, p, @min(n, cur));
    _ = free(p);
    return q;
}
pub export fn calloc(n: u32, m: u32) u32 {
    const total = @as(u64, n) * m;
    if (total > 0xffff_ffff) return 0;
    const p = malloc(@intCast(total));
    if (p != 0) fill(p, 0, @intCast(total));
    return p;
}
pub export fn memalign(alignment: u32, n: u32) u32 {
    if (alignment <= 16) return malloc(n);
    if (alignment >= PAGE_SIZE and (alignment & (alignment - 1)) == 0) return mapBig(n, alignment);
    const raw = malloc(n + alignment + HDR);
    if (raw == 0 or isBig(raw) != null) return raw;
    const p = (raw + HDR + alignment - 1) & ~(alignment - 1);
    ptr(u32, p - 8).* = raw;
    ptr(u32, p - 4).* = n;
    return p;
}

pub export fn map_pages(n_in: u32, rsv: u32, alignment: u32) u32 {
    const n = (n_in +% (PAGE_SIZE - 1)) & ~(PAGE_SIZE - 1);
    if (n == 0) return 0;
    const np = n >> PAGE_SHIFT;
    var al = alignment / PAGE_SIZE;
    if (rsv != 0 and np >= 256) al = @max(al, @as(u32, 1) << @intCast(31 - @clz((np + 1) >> 1)));
    al = @max(al, 1);
    const p = findRun(np, FREE, al, rsv != 0);
    if (p == 0) return 0;
    const a = pageOf(p);
    const b = @min(a + np, pageOf(module_bot));
    cpu.invalidate_range(p, (b - a) * PAGE_SIZE);
    @memset(pages[a..b], if (rsv != 0) RESERVED else USED);
    if (rsv == 0) fill(p, 0, n);
    return p;
}
pub export fn unmap_pages(addr: u32, n_in: u32) u32 {
    const n = (n_in +% (PAGE_SIZE - 1)) & ~(PAGE_SIZE - 1);
    if (addr & (PAGE_SIZE - 1) != 0 or n == 0 or addr < abi.ARENA_BASE) return 0;
    const a = pageOf(addr);
    const b = @min(a + (n >> PAGE_SHIFT), pageOf(module_bot));
    if (b > a) {
        cpu.invalidate_range(addr, (b - a) * PAGE_SIZE);
        @memset(pages[a..b], FREE);
    }
    return 1;
}
export fn commit_pages(addr: u32, n: u32) u32 {
    if (addr < abi.ARENA_BASE) return 0;
    const a = pageOf(addr);
    const end = @as(u64, addr) + n;
    if (end > mem_size) return 0;
    const b: u32 = @intCast((end + PAGE_SIZE - 1) >> PAGE_SHIFT);
    for (a..b) |i| if (pages[i] == FREE) return 0;
    for (a..b) |i| if (pages[i] == RESERVED) {
        cpu.invalidate_range(@intCast(i * PAGE_SIZE), PAGE_SIZE);
        pages[i] = USED;
        fill(@intCast(i * PAGE_SIZE), 0, PAGE_SIZE);
    };
    return 1;
}
export fn decommit_pages(addr: u32, n: u32) void {
    const a = @max(pageOf(addr), pageOf(abi.ARENA_BASE));
    const b = @min(pageOf(addr +% n +% (PAGE_SIZE - 1)), pageOf(module_bot));
    var i = a;
    while (i < b) : (i += 1) if (pages[i] == USED) {
        cpu.invalidate_range(@intCast(i * PAGE_SIZE), PAGE_SIZE);
        pages[i] = RESERVED;
    };
}

/// Above 4 GiB the address space is planes: 4 GiB slices map_va hands out, each holding one
/// mapping's addresses (R bytes from L). Their memory is the pool's 2 MiB units, mapped unit by
/// unit as a page table would, so a mapping can be backed sparsely (an allocator's regions at a
/// stride inside one huge reservation). An entry of `units` is a unit's buffer offset | 1 when
/// backed, DEMAND when accessible but untouched (Linux backs private anonymous memory on first
/// touch), 0 when not accessible. The JIT reads entries inline (jit.zig address).
pub const UNIT: u32 = 1 << 21;
const UNIT_SHIFT = 21;
const PLANES = 256;
const PLANE_LO: u32 = 0x1000_0000;
/// the first unit above plane 0, and how many units the planes span
pub const UNIT_FIRST: u32 = 1 << (32 - UNIT_SHIFT);
pub const UNITS: u32 = PLANES * UNIT_FIRST - UNIT_FIRST;
pub const units: [*]u32 = @ptrFromInt(abi.KERN_UNITS);
const DEMAND: u32 = 2;
comptime {
    assert(abi.KERN_UNITS + UNITS * 4 <= abi.JIT_BUF);
}
var pool_base: u32 = 0;
/// for each pool unit, the unit it backs plus one; 0 when free
var backs = [_]u32{0} ** ((abi.MEM_SIZE_A64 - abi.POOL_BASE) / UNIT);
var pool_len: u32 = 0;
var R = [_]u64{0} ** PLANES;
var L = [_]u32{PLANE_LO} ** PLANES;
var moves: u32 = 0;

inline fn hi(v: u64) u32 {
    return @intCast(v >> 32);
}
inline fn lo(v: u64) u32 {
    return @truncate(v);
}
/// the unit of an address in a plane (1 <= hi(v) < PLANES)
inline fn unitOf(v: u64) u32 {
    return @intCast((v >> UNIT_SHIFT) - UNIT_FIRST);
}
fn poolUnits() u32 {
    return @min(pool_len, (module_bot - pool_base) / UNIT);
}
inline fn poolIdx(p: u32) u32 {
    return (p - pool_base) / UNIT;
}
/// the bottom of the widest free run of pool units below `top`, so what follows can stay contiguous
fn widestFree(top: u32) ?u32 {
    var best: ?u32 = null;
    var best_len: u32 = 0;
    var i: u32 = 0;
    while (i < top) : (i += 1) {
        if (backs[i] != 0) continue;
        var j = i;
        while (j < top and backs[j] == 0) j += 1;
        if (j - i > best_len) {
            best = i;
            best_len = j - i;
        }
        i = j;
    }
    return best;
}
/// back unit u with a zeroed pool unit, the one beside a neighbour's when free
fn backUnit(u: u32) bool {
    const top = poolUnits();
    var dst: ?u32 = null;
    if (u > 0 and units[u - 1] & 1 != 0) {
        const n = poolIdx(units[u - 1] & ~@as(u32, 1)) + 1;
        if (n < top and backs[n] == 0) dst = n;
    }
    if (dst == null and u + 1 < UNITS and units[u + 1] & 1 != 0) {
        const n = poolIdx(units[u + 1] & ~@as(u32, 1));
        if (n > 0 and backs[n - 1] == 0) dst = n - 1;
    }
    const d = dst orelse widestFree(top) orelse return false;
    backs[d] = u + 1;
    const p = pool_base + d * UNIT;
    fill(p, 0, UNIT);
    units[u] = p | 1;
    return true;
}
fn setUnit(u: u32, state: u32) void {
    const e = units[u];
    if (e & 1 != 0) {
        if (state == DEMAND) return;
        backs[poolIdx(e & ~@as(u32, 1))] = 0;
    }
    units[u] = state;
}
/// every unit [v, v + n) touches becomes `state`; an accessible unit stays as it is when made accessible
fn setUnits(v: u64, n: u64, state: u32) void {
    if (n == 0) return;
    var u = unitOf(v);
    const last = unitOf(v + n - 1);
    while (u <= last) : (u += 1) setUnit(u, state);
}
/// the units wholly inside [v, v + n): what a partial-unit protection change or discard leaves alone
fn wholeUnits(v: u64, n: u64) ?[2]u32 {
    const a = (v + UNIT - 1) & ~@as(u64, UNIT - 1);
    const b = (v + n) & ~@as(u64, UNIT - 1);
    return if (b > a) .{ unitOf(a), unitOf(b - 1) } else null;
}
/// a plane address → buffer offset, backing its unit on first touch; 0 when not accessible
pub export fn tx(h_in: u32, l: u32) u32 {
    const h = h_in & 0x00ff_ffff; // a pointer's top-byte tag is not address
    if (h == 0 or h >= PLANES) return 0;
    const u = unitOf((@as(u64, h) << 32) | l);
    if (units[u] == DEMAND and !backUnit(u)) return 0;
    const e = units[u];
    return if (e & 1 != 0) (e - 1) + (l & (UNIT - 1)) else 0;
}
/// whether [v, v + n) is accessible and contiguous in the buffer, backing it as needed
pub fn commit_range(v_in: u64, n: u32) u32 {
    const v = v_in & 0x00ff_ffff_ffff_ffff;
    const h = hi(v);
    if (h == 0) return 1;
    const first = tx(h, lo(v));
    if (first == 0) return 0;
    var a = (v | (UNIT - 1)) + 1;
    while (a < v + n) : (a += UNIT) if (tx(hi(a), lo(a)) != first + (a - v)) return 0;
    return 1;
}
/// a host access of n bytes at buffer offset p: what plane memory it lands in must be backed and
/// contiguous through its end
export fn commit_phys(p: u32, n: u32) u32 {
    if (pool_base == 0 or p < pool_base) return 1;
    const d = poolIdx(p);
    if (d >= pool_len or backs[d] == 0) return 1;
    return commit_range(((@as(u64, backs[d] - 1) + UNIT_FIRST) << UNIT_SHIFT) | (p & (UNIT - 1)), n);
}
export fn plane_reserved(h: u32) u32 {
    return @intFromBool(R[h & 255] != 0);
}
pub export fn va(phys: u32) u64 {
    if (pool_base == 0 or phys < pool_base) return phys;
    const d = poolIdx(phys);
    if (d >= pool_len or backs[d] == 0) return phys;
    return ((@as(u64, backs[d] - 1) + UNIT_FIRST) << UNIT_SHIFT) | (phys & (UNIT - 1));
}
/// `low` asks for plane 0, the only space the core executes from, whenever the mapping fits there
export fn map_va(n: u64, rsv: u32, low: u32) u64 {
    if (n == 0) return 0;
    if (n > @as(u64, 0x1_0000_0000) - PLANE_LO) {
        if (pool_base == 0) return 0;
        const count: usize = @intCast((n + 0xffff_ffff) / 0x1_0000_0000);
        var h: usize = 1;
        outer: while (h + count <= PLANES) : (h += 1) {
            for (h..h + count) |i| if (R[i] != 0) continue :outer;
            for (0..count) |i| {
                L[h + i] = 0;
                R[h + i] = @min(@as(u64, 0x1_0000_0000), n - @as(u64, i) * 0x1_0000_0000);
            }
            if (rsv == 0) setUnits(@as(u64, h) << 32, n, DEMAND);
            return @as(u64, h) << 32;
        }
        return 0;
    }
    // Large transient mappings strand the monotonic malloc bump when they share plane 0, and a
    // plane backs whole pool units: keep sub-stack-sized mappings, reserved or not, in plane 0
    // where they cost pages only.
    if (pool_base == 0 or n < abi.STACK_SIZE or low != 0) {
        const p = map_pages(@intCast(n), rsv, PAGE_SIZE);
        if (p != 0 or pool_base == 0) return p;
    }
    var h: usize = 1;
    while (h < PLANES and R[h] != 0) h += 1;
    if (h == PLANES) return 0;
    L[h] = PLANE_LO;
    R[h] = n;
    const v = (@as(u64, h) << 32) | L[h];
    if (rsv == 0) setUnits(v, n, DEMAND);
    return v;
}
export fn unmap_va(va_in: u64, n_in: u64) u32 {
    if (va_in & (PAGE_SIZE - 1) != 0 or n_in == 0) return 0;
    var v = va_in;
    var n = n_in;
    while (n > 0) {
        const h = hi(v);
        const l = lo(v);
        const size: u64 = @min(n, 0x1_0000_0000 - @as(u64, l));
        if (h == 0) {
            if (unmap_pages(l, @intCast(@min(size, 0xffff_ffff))) == 0) return 0;
        } else if (h < PLANES and R[h] != 0) {
            const off: i64 = @as(i64, l) - L[h];
            if (off <= 0 and size >= R[h]) {
                setUnits(@as(u64, h) << 32 | L[h], R[h], 0);
                R[h] = 0;
            } else {
                decommit_va(v, size);
                if (off > 0 and off + @as(i64, @intCast(size)) >= @as(i64, @intCast(R[h]))) R[h] = @intCast(off);
            }
        }
        n -= size;
        v += size;
    }
    return 1;
}
export fn check_reserve(h: u32, l: u32, size: u32) u32 {
    if (h == 0) {
        if (l < abi.ARENA_BASE or @as(u64, l) + size > (if (pool_base != 0) pool_base else module_bot)) return 0;
        var p = pageOf(l);
        while (p < pageOf(l +% size +% (PAGE_SIZE - 1))) : (p += 1) if (pages[p] == FREE) return 0;
        return 1;
    }
    return @intFromBool(h < PLANES and l >= L[h] and @as(u64, l - L[h]) + size <= R[h]);
}
inline fn inPlane(v: u64, n: u64) bool {
    const h = hi(v);
    return h != 0 and h < PLANES and R[h] != 0 and lo(v) >= L[h] and @as(u64, lo(v) - L[h]) + n <= R[h];
}
export fn resident_va(v: u64) i32 {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) {
        if (l < abi.ARENA_BASE or l >= (if (pool_base != 0) pool_base else module_bot)) return -1;
        const state = pages[pageOf(l)];
        return if (state == FREE) -1 else @intFromBool(state == USED or state == IMAGE);
    }
    if (!inPlane(v, 1)) return -1;
    return @intFromBool(units[unitOf(v)] & 1 != 0);
}
export fn commit_va(v: u64, n: u64) u32 {
    if (hi(v) == 0) return commit_pages(lo(v), @intCast(@min(n, 0xffff_ffff)));
    if (!inPlane(v, n)) return 0;
    setUnits(v, n, DEMAND);
    return 1;
}
/// MADV_DONTNEED: what is backed of [v, v + n) reads back as zero
export fn drop_va(v: u64, n: u64) u32 {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) {
        if (l < abi.ARENA_BASE or @as(u64, l) + n > (if (pool_base != 0) pool_base else module_bot)) return 0;
        _ = cpu.code_write(l, @intCast(n));
        fill(l, 0, @intCast(n));
        return 1;
    }
    if (!inPlane(v, n)) return 1;
    var a = v;
    while (a < v + n) {
        const next = @min((a | (UNIT - 1)) + 1, v + n);
        const u = unitOf(a);
        const e = units[u];
        if (e & 1 != 0) {
            if (next - a == UNIT) {
                setUnit(u, 0);
                units[u] = DEMAND;
            } else fill((e - 1) + (lo(a) & (UNIT - 1)), 0, @intCast(next - a));
        }
        a = next;
    }
    return 1;
}
/// PROT_NONE: the units wholly inside [v, v + n) go back to being address space
export fn decommit_va(v: u64, n: u64) void {
    if (hi(v) == 0) {
        decommit_pages(lo(v), @intCast(@min(n, 0xffff_ffff)));
        return;
    }
    const w = wholeUnits(v, n) orelse return;
    var u = w[0];
    while (u <= w[1]) : (u += 1) setUnit(u, 0);
}

var last_err: u32 = 0;
export fn err() u32 {
    return last_err;
}
pub export fn reserve(size: u32, alignment: u32) u32 {
    abi.require(alignment != 0 and alignment & (alignment - 1) == 0, "reserve: alignment is not a power of two");
    // Running out of address space is a result the caller already reads through err(), not a
    // programmer error; without the test the subtraction below wraps and hands back a base above
    // module_bot, which then walks the page map backwards.
    if (size == 0 or size > module_bot - abi.ARENA_BASE) {
        last_err = 4;
        return 0;
    }
    const base = (module_bot - size) & ~(alignment - 1);
    // the images grow down into the pool: units backed there move below them
    if (pool_base != 0 and base >= pool_base) {
        const keep = (base - pool_base) / UNIT;
        for (keep..poolUnits()) |d| {
            if (backs[d] == 0) continue;
            const to = for (0..keep) |i| {
                if (backs[i] == 0) break i;
            } else {
                last_err = 0x100 | @as(u32, @intCast((backs[d] - 1 + UNIT_FIRST) >> (32 - UNIT_SHIFT)));
                return 0;
            };
            const u = backs[d] - 1;
            move(pool_base + @as(u32, @intCast(to)) * UNIT, pool_base + @as(u32, @intCast(d)) * UNIT, UNIT);
            backs[to] = backs[d];
            backs[d] = 0;
            units[u] = (pool_base + @as(u32, @intCast(to)) * UNIT) | 1;
            moves += 1;
        }
    }
    for (pageOf(base)..pageOf(module_bot)) |i| if (pages[i] == USED) {
        last_err = 2;
        return 0;
    };
    if (base < heap_top) {
        last_err = 3;
        return 0;
    }
    @memset(pages[pageOf(base)..pageOf(module_bot)], IMAGE);
    module_bot = base;
    return base;
}

var free_stacks: [64][2]u32 = undefined;
var free_stack_count: u32 = 0;
export fn alloc_stack(size: u32) u32 {
    var i: u32 = 0;
    while (i < free_stack_count) : (i += 1) if (free_stacks[i][1] == size) {
        const base = free_stacks[i][0];
        free_stack_count -= 1;
        free_stacks[i] = free_stacks[free_stack_count];
        cpu.invalidate_range(base, size);
        return base;
    };
    const base = stack_top +% abi.STACK_GUARD;
    const top = @as(u64, base) + size;
    if (top > abi.STACK_END) {
        // the fixed span holds sixty stacks; past that a stack is page-mapped arena memory, so
        // the thread count is bounded by memory, as in a process (an app's dispatcher, http and
        // image pools alone pass sixty threads)
        const p = map_pages(size +% abi.STACK_GUARD, 0, PAGE_SIZE);
        if (p == 0) return 0;
        guard(p + abi.STACK_GUARD, 2);
        return p + abi.STACK_GUARD;
    }
    stack_top = @intCast(top);
    guard(base, 2);
    return base;
}
/// the guard gap below a stack: an overflowing store faults there rather than landing below it
fn guard(base: u32, flag: u8) void {
    const g = pageOf(base - abi.STACK_GUARD);
    for (g..pageOf(base)) |pg| page_flags[pg] = (page_flags[pg] & ~@as(u8, 2)) | flag;
}
export fn free_stack(base: u32, size: u32) void {
    if (free_stack_count < free_stacks.len) {
        free_stacks[free_stack_count] = .{ base, size };
        free_stack_count += 1;
        return;
    }
    // the table is full, which only overflow stacks can do: give the address space back rather
    // than lose it, since a mapped stack is reachable again through map_pages
    if (base >= abi.ARENA_BASE) {
        guard(base, 0);
        _ = unmap_pages(base - abi.STACK_GUARD, size +% abi.STACK_GUARD);
    }
}
export fn host_alloc(n: u32, alignment: u32) u32 {
    const p = (host_top + alignment - 1) & ~(alignment - 1);
    if (@as(u64, p) + n > abi.HOST_DATA_END) return 0;
    host_top = p + n;
    return p;
}

export fn mem_init(size: u32) void {
    mem_size = size;
    module_bot = size;
    pool_base = if (size > abi.POOL_BASE) abi.POOL_BASE else 0;
    pool_len = if (pool_base != 0) @min(backs.len, (size - pool_base) / UNIT) else 0;
    @memset(&backs, 0);
    @memset(&R, 0);
    @memset(&L, PLANE_LO);
    @memset(units[0..UNITS], 0);
    @memset(pages[0..pageOf(heap_top + PAGE_SIZE - 1)], USED);
    // a later reserve hands these out again and must read as fresh memory
    for (pageOf(heap_top)..MAX_PAGES) |i| if (pages[i] == IMAGE) {
        pages[i] = FREE;
        fill(@intCast(i * PAGE_SIZE), 0, PAGE_SIZE);
    };
    cpu.reset(size > abi.MEM_SIZE_A32);
    // the core's own data lies below the stacks: a guest store there faults, as below LOW
    @memset(page_flags[0..pageOf(abi.STACK_BASE)], 2);
}
export fn flags_ptr() u32 {
    return @intFromPtr(page_flags);
}
export fn stat(i: u32) f64 {
    return switch (i) {
        0 => @floatFromInt(used),
        1 => @floatFromInt(blocks),
        2 => @as(f64, @floatFromInt(heap_peak)) - @as(f64, @floatFromInt(abi.ARENA_BASE)),
        3 => @floatFromInt(mem_size),
        4 => @floatFromInt(module_bot - heap_top),
        5 => blk: {
            var n: u32 = 0;
            for (R) |r| n += @intFromBool(r != 0);
            break :blk @floatFromInt(n);
        },
        6 => blk: {
            var n: u32 = 0;
            for (backs) |o| n += @intFromBool(o != 0);
            break :blk @floatFromInt(n);
        },
        7 => @floatFromInt(moves),
        8 => @floatFromInt(module_bot),
        else => 0,
    };
}
