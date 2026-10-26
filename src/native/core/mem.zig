const std = @import("std");
const abi = @import("abi.zig");
const cpu = @import("cpu.zig");
const assert = std.debug.assert;

const PAGE_SHIFT = abi.PAGE_SHIFT;
const PAGE_SIZE = abi.PAGE_SIZE;

pub inline fn ptr(comptime T: type, a: u32) *align(1) T {
    return @ptrFromInt(a);
}
pub inline fn bytes(a: u32) [*]u8 {
    return @ptrFromInt(a);
}
pub inline fn ld(comptime T: type, a: u32) T {
    if (a >= window) return windowLoad(T, a);
    return ptr(T, a).*;
}

// The window (abi.WINDOW): the host serves its bytes, which another memory holds, at mapped
// window addresses the core has checked.
extern "env" fn shm_load(a: u32, n: u32) u32;
extern "env" fn shm_store(a: u32, n: u32, v: u32) void;
/// compare-and-swap of the n-byte value at window address a: the value it held
pub extern "env" fn shm_cas(a: u32, n: u32, expected: u32, v: u32) u32;
/// whether the 8 bytes at a held `expected` and now hold `v`
pub extern "env" fn shm_cas64(a: u32, expected: u64, v: u64) u32;
/// n bytes from s to d, guest addresses either of which may be in the window
pub extern "env" fn shm_copy(d: u32, s: u32, n: u32) void;
pub extern "env" fn shm_fill(d: u32, v: u32, n: u32) void;
/// where this process's window starts: past every address in a 64-bit process, whose memory goes on there
pub var window: u32 = 0xffff_ffff;
/// whether this process maps the n bytes at window address a (for storing, when `write`)
pub fn windowed(a: u32, n: u32, write: bool) bool {
    if (a < window) return false;
    const need: u8 = @intCast(abi.PAGE_MAPPED | (if (write) abi.PAGE_WRITABLE else 0));
    const last = @as(u64, a) + @max(n, 1) - 1;
    if (last > 0xffff_ffff) return false;
    for (pageOf(a)..@as(usize, @intCast(last >> PAGE_SHIFT)) + 1) |pg| if (page_flags[pg] & need != need) return false;
    return true;
}
fn windowLoad(comptime T: type, a: u32) T {
    const n = @sizeOf(T);
    if (n <= 4) return @bitCast(@as(std.meta.Int(.unsigned, n * 8), @truncate(shm_load(a, n))));
    var v: T = undefined;
    shm_copy(@intFromPtr(&v), a, n);
    return v;
}
pub fn windowStore(comptime T: type, a: u32, v: T) void {
    const n = @sizeOf(T);
    if (n <= 4) return shm_store(a, n, @as(std.meta.Int(.unsigned, n * 8), @bitCast(v)));
    var copy = v;
    shm_copy(a, @intFromPtr(&copy), n);
}
/// mmap's placement of a mapping at [a, a + n) of the window, as PROT_READ or PROT_WRITE allow, or
/// munmap's (prot 0); false outside the window
export fn window_map(a: u32, n: u32, prot: u32) u32 {
    if (a < window or n == 0 or @as(u64, a) + n > @as(u64, abi.WINDOW) + abi.WINDOW_SIZE) return 0;
    const flags: u8 = 2 | @as(u8, if (prot & 3 != 0) abi.PAGE_MAPPED else 0) | @as(u8, if (prot & 2 != 0) abi.PAGE_WRITABLE else 0);
    @memset(page_flags[pageOf(a)..pageOf(a + (n - 1)) + 1], flags);
    return 1;
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
/// a plane's pool unit: plane 0 has no page there
const POOL = 4;
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
pub var mem_size: u32 = abi.MEM_SIZE_INITIAL;
var heap_top: u32 = abi.ARENA_BASE;
var heap_peak: u32 = 0;
var blocks: u32 = 0;
var used: u64 = 0;
var stack_top: u32 = abi.STACK_BASE;
var host_top: u32 = abi.HOST_DATA;

extern "env" fn mem_grown() void;
/// The wasm memory backs the address space only up to the highest page in use, grown in steps
/// where pages come into use: the page's realms share one V8 isolate, which counts every
/// committed byte toward its heap limit (mem.ts). Every allocator here takes the lowest free run
/// (planes' units included), so the pages in use stay a prefix.
const COMMIT_STEP: u64 = 64 << 20;
fn back(end: u64) bool {
    const have = @as(u64, @wasmMemorySize(0)) << 16;
    if (end <= have) return true;
    if (end > mem_size) return false;
    const want = @min((end + COMMIT_STEP - 1) & ~(COMMIT_STEP - 1), mem_size);
    if (@wasmMemoryGrow(0, @intCast((want - have) >> 16)) < 0) return false;
    for (page_flags[@intCast(have >> PAGE_SHIFT)..@intCast(want >> PAGE_SHIFT)]) |*f| f.* &= ~@as(u8, 2);
    mem_grown();
    return true;
}
/// No page past what is backed is in use: a guest store there faults as on the core's own data
/// (the store path tests these flags already), and a load past ARM32's 2 GiB fails its address
/// test. A load below that into space not yet backed still traps in wasm.
fn protectUnbacked() void {
    @memset(page_flags[@intCast(@as(u64, @wasmMemorySize(0)) << 16 >> PAGE_SHIFT)..abi.PAGE_INDEX_MAX], 2);
}

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
    const end = pageOf(mem_size);
    const top: u32 = abi.PAGE_INDEX_MAX;
    const phantom = phantom_in and !planes;
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
        const end = @as(u64, p) + n + PAGE_SIZE - 1;
        if (end >> PAGE_SHIFT > pageOf(mem_size)) return 0;
        const b: u32 = @intCast(end >> PAGE_SHIFT);
        var j = a + @as(u32, if (p & (PAGE_SIZE - 1) != 0) 1 else 0);
        while (j < b and pages[j] == FREE) j += 1;
        if (j == b) {
            if (!back(@as(u64, b) << PAGE_SHIFT)) return 0;
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
    return claim(findRun(np, FREE, al, rsv != 0), n, rsv);
}
/// the n bytes of free pages at p become a mapping, reserved or committed and zero
fn claim(p: u32, n: u32, rsv: u32) u32 {
    if (p == 0 or (rsv == 0 and !back(@as(u64, p) + n))) return 0;
    const a = pageOf(p);
    const b = @min(a + (n >> PAGE_SHIFT), pageOf(mem_size));
    cpu.invalidate_range(p, (b - a) * PAGE_SIZE);
    @memset(pages[a..b], if (rsv != 0) RESERVED else USED);
    if (rsv == 0) fill(p, 0, n);
    return p;
}
pub export fn unmap_pages(addr: u32, n_in: u32) u32 {
    const n = (n_in +% (PAGE_SIZE - 1)) & ~(PAGE_SIZE - 1);
    if (addr & (PAGE_SIZE - 1) != 0 or n == 0 or addr < abi.ARENA_BASE) return 0;
    const a = pageOf(addr);
    const b = @min(a + (n >> PAGE_SHIFT), pageOf(mem_size));
    if (b > a) {
        cpu.invalidate_range(addr, (b - a) * PAGE_SIZE);
        for (a..b) |i| if (pages[i] != POOL) {
            pages[i] = FREE;
            page_flags[i] &= ~@as(u8, abi.PAGE_READONLY);
        };
    }
    return 1;
}
export fn commit_pages(addr: u32, n: u32) u32 {
    if (addr < abi.ARENA_BASE) return 0;
    const a = pageOf(addr);
    const end = @as(u64, addr) + n;
    if (end > mem_size) return 0;
    const b: u32 = @intCast((end + PAGE_SIZE - 1) >> PAGE_SHIFT);
    for (a..b) |i| if (pages[i] == FREE or pages[i] == POOL) return 0;
    if (!back(@as(u64, b) << PAGE_SHIFT)) return 0;
    for (a..b) |i| if (pages[i] == RESERVED) {
        cpu.invalidate_range(@intCast(i * PAGE_SIZE), PAGE_SIZE);
        pages[i] = USED;
        fill(@intCast(i * PAGE_SIZE), 0, PAGE_SIZE);
    };
    return 1;
}
export fn decommit_pages(addr: u32, n: u32) void {
    const a = @max(pageOf(addr), pageOf(abi.ARENA_BASE));
    const b = @min(pageOf(addr +% n +% (PAGE_SIZE - 1)), pageOf(mem_size));
    var i = a;
    while (i < b) : (i += 1) if (pages[i] == USED) {
        cpu.invalidate_range(@intCast(i * PAGE_SIZE), PAGE_SIZE);
        pages[i] = RESERVED;
    };
}

/// a plane's pages come from the pool in units this size: a small mapping still takes a whole one
const UNIT: u32 = 1 << 21;
const UNIT_PAGES = UNIT >> PAGE_SHIFT;
const PLANES = 256;
const PLANE_LO: u32 = 0x1000_0000;
/// A 64-bit process has planes; their pool is plane 0's free pages, a unit at a time, which plane
/// 0 then skips (POOL). owner[u] is the plane holding unit u, the buffer's [u * UNIT, (u + 1) * UNIT).
var planes = false;
var owner = [_]i16{-1} ** (abi.MEM_SIZE_A64 / UNIT);
pub var P = [_]u32{0} ** PLANES;
var R = [_]u64{0} ** PLANES;
pub var S = [_]u32{0} ** PLANES;
pub var L = [_]u32{PLANE_LO} ** PLANES;
/// A plane is R bytes of address space, of which S are committed from its start and the first W
/// are writable: Linux overcommits private anonymous memory, so a writable page the pool could not
/// commit up front is committed on first touch, from the plane's start upward.
var W = [_]u64{0} ** PLANES;
const DEMAND_STEP: u64 = 1 << 20;
/// A commit far past a plane's committed prefix (an allocator's region at a stride inside one huge
/// reservation, as scudo's primary lays them out) gets pool units of its own rather than growing
/// the prefix out to it. The prefix stays the one window the JIT translates inline; an extent,
/// a unit-aligned run [lo, lo + size) of plane h's low addresses, is found by tx.
const EXTENTS = 256;
const SPARSE_GAP: u64 = 64 << 20;
var ext_h = [_]u32{0} ** EXTENTS;
var ext_lo = [_]u32{0} ** EXTENTS;
var ext_size = [_]u32{0} ** EXTENTS;
var ext_p = [_]u32{0} ** EXTENTS;
fn extentAt(h: u32, l: u32) ?usize {
    for (0..EXTENTS) |i| if (ext_h[i] == h and l -% ext_lo[i] < ext_size[i]) return i;
    return null;
}
fn extentOfPhys(h: u32, p: u32) ?usize {
    for (0..EXTENTS) |i| if (ext_h[i] == h and p -% ext_p[i] < ext_size[i]) return i;
    return null;
}
/// back [l, l + n) of plane h with extents wherever none does yet
fn commitExtent(h: u32, l: u32, n: u64) bool {
    var u: u64 = l & ~@as(u32, UNIT - 1);
    const end: u64 = @as(u64, l) + n;
    while (u < end) {
        if (extentAt(h, @intCast(u))) |i| {
            u = @as(u64, ext_lo[i]) + ext_size[i];
            continue;
        }
        var run_end = u + UNIT;
        while (run_end < end and extentAt(h, @intCast(run_end)) == null) run_end += UNIT;
        const units: u32 = @intCast((run_end - u) / UNIT);
        const slot = for (0..EXTENTS) |i| {
            if (ext_h[i] == 0) break i;
        } else return false;
        const dst = placeRun(units, false) orelse return false;
        take(dst, units, h);
        ext_h[slot] = h;
        ext_lo[slot] = @intCast(u);
        ext_size[slot] = units * UNIT;
        ext_p[slot] = dst * UNIT;
        fill(ext_p[slot], 0, ext_size[slot]);
        u = run_end;
    }
    return true;
}
/// zero (madvise DONTNEED) or release (decommit, unmap) plane h's extents inside [l, l + n). A
/// release returns the whole units it covers to the pool, shrinking or splitting the extent; a
/// unit it covers only in part stays committed, zeroed.
fn dropExtents(h: u32, l: u32, n: u64, release_units: bool) void {
    const end = @as(u64, l) + n;
    for (0..EXTENTS) |i| {
        if (ext_h[i] != h) continue;
        const lo_e: u64 = ext_lo[i];
        const hi_e = lo_e + ext_size[i];
        if (hi_e <= l or lo_e >= end) continue;
        const a = @max(lo_e, l);
        const b = @min(hi_e, end);
        const ua = if (release_units) (a + UNIT - 1) & ~@as(u64, UNIT - 1) else b;
        const ub = if (release_units) b & ~@as(u64, UNIT - 1) else b;
        if (ua >= ub) {
            zeroExtent(i, a, b);
            continue;
        }
        zeroExtent(i, a, ua);
        zeroExtent(i, ub, b);
        releaseUnits(i, ua, ub);
    }
}
fn zeroExtent(i: usize, a: u64, b: u64) void {
    if (a < b) fill(ext_p[i] + @as(u32, @intCast(a - ext_lo[i])), 0, @intCast(b - a));
}
/// return extent i's unit-aligned [ua, ub) to the pool; what remains on both sides becomes two extents
fn releaseUnits(i: usize, ua: u64, ub: u64) void {
    const lo_e: u64 = ext_lo[i];
    const hi_e = lo_e + ext_size[i];
    const first = ext_p[i] / UNIT + @as(u32, @intCast((ua - lo_e) / UNIT));
    if (ua > lo_e and ub < hi_e) {
        const j = for (0..EXTENTS) |k| {
            if (ext_h[k] == 0) break k;
        } else {
            zeroExtent(i, ua, ub); // no slot to split into: the middle stays committed, zeroed
            return;
        };
        ext_h[j] = ext_h[i];
        ext_lo[j] = @intCast(ub);
        ext_size[j] = @intCast(hi_e - ub);
        ext_p[j] = ext_p[i] + @as(u32, @intCast(ub - lo_e));
    }
    give(first, @intCast((ub - ua) / UNIT));
    if (ua == lo_e and ub == hi_e) {
        ext_h[i] = 0;
    } else if (ua == lo_e) {
        ext_p[i] += @intCast(ub - lo_e);
        ext_lo[i] = @intCast(ub);
        ext_size[i] = @intCast(hi_e - ub);
    } else {
        ext_size[i] = @intCast(ua - lo_e);
    }
}
var moves: u32 = 0;

inline fn unitsOf(n: u64) u32 {
    return @intCast((n + UNIT - 1) / UNIT);
}
inline fn unitCount() u32 {
    return if (planes) mem_size / UNIT else 0;
}
/// no plane owns unit u and plane 0 has none of its pages
fn unitFree(u: u32) bool {
    if (owner[u] >= 0) return false;
    const w: [*]align(1) const u64 = @ptrCast(pages + u * UNIT_PAGES);
    for (0..UNIT_PAGES / 8) |i| if (w[i] != FREE) return false;
    return true;
}
fn runFree(from: u32, units: u32) bool {
    if (from + units > unitCount()) return false;
    for (from..from + units) |u| if (!unitFree(@intCast(u))) return false;
    return true;
}
fn take(at: u32, units: u32, h: u32) void {
    @memset(owner[at .. at + units], @intCast(h));
    @memset(pages[at * UNIT_PAGES .. (at + units) * UNIT_PAGES], POOL);
}
fn give(at: u32, units: u32) void {
    @memset(owner[at .. at + units], -1);
    @memset(pages[at * UNIT_PAGES .. (at + units) * UNIT_PAGES], FREE);
}
/// room for `units`, committed as needed: a plane that grows on demand takes the bottom of the
/// widest free run so it can extend in place, any other plane the lowest run that fits
fn placeRun(units: u32, grows: bool) ?u32 {
    const top = unitCount();
    var best: ?u32 = null;
    var best_len: u32 = 0;
    var i: u32 = 0;
    while (i < top) : (i += 1) {
        if (!unitFree(i)) continue;
        var j = i;
        while (j < top and unitFree(j)) j += 1;
        if (j - i >= units and !grows) {
            best = i;
            break;
        }
        if (j - i >= units and j - i > best_len) {
            best = i;
            best_len = j - i;
        }
        i = j;
    }
    const at = best orelse return null;
    return if (back(@as(u64, at + units) * UNIT)) at else null;
}
fn moveRun(h: usize, dst: u32, need: u32) void {
    const at = P[h] / UNIT;
    const have = unitsOf(S[h]);
    if (dst != at) {
        move(dst * UNIT, P[h], S[h]);
        give(at, have);
        moves += 1;
    }
    take(dst, need, @intCast(h));
    P[h] = dst * UNIT;
}
/// commit [0, n) of plane h; moving it invalidates every translation into it, so a caller that
/// already holds one passes may_move = false
fn grow(h: usize, n: u32, may_move: bool) bool {
    const have = unitsOf(S[h]);
    const need = unitsOf(n);
    if (need > have) {
        if (have == 0) {
            const dst = placeRun(need, W[h] > n) orelse return false;
            take(dst, need, @intCast(h));
            P[h] = dst * UNIT;
        } else {
            const at = P[h] / UNIT;
            const in_place = runFree(at + have, need - have) and back(@as(u64, at + need) * UNIT);
            const dst = if (in_place) at else if (may_move) placeRun(need, true) orelse return false else return false;
            moveRun(h, dst, need);
        }
    }
    fill(P[h] + S[h], 0, n - S[h]);
    S[h] = n;
    return true;
}
fn release(h: usize) void {
    if (S[h] != 0) give(P[h] / UNIT, unitsOf(S[h]));
    R[h] = 0;
    S[h] = 0;
    W[h] = 0;
    dropExtents(@intCast(h), 0, 0x1_0000_0000, true);
}
/// commit writable [off, off + n)
fn demand(h: usize, off: u32, n: u32, may_move: bool) bool {
    const end = @as(u64, off) + n;
    if (end > W[h]) return false;
    return grow(h, @intCast(@min(W[h], (end + DEMAND_STEP - 1) & ~(DEMAND_STEP - 1), 0xffff_f000)), may_move);
}
/// whether [v, v + n) is backed, committing the writable pages under it
pub fn commit_range(v_in: u64, n: u32) u32 {
    const v = v_in & 0x00ff_ffff_ffff_ffff; // a pointer's top-byte tag is not address
    const h = hi(v);
    if (h == 0 or h >= PLANES) return @intFromBool(h == 0);
    const off = lo(v) -% L[h];
    if (@as(u64, off) + n <= S[h]) return 1;
    if (extentAt(h, lo(v))) |i| return @intFromBool(@as(u64, lo(v) - ext_lo[i]) + n <= ext_size[i]);
    return @intFromBool(demand(h, off, n, true));
}
/// a host access of n bytes at buffer offset p: the host already holds p, so a plane's writable
/// pages under it commit in place; 0 when the plane cannot back the access there
export fn commit_phys(p: u32, n: u32) u32 {
    const u = p / UNIT;
    if (u >= unitCount() or owner[u] < 0) return 1;
    const h: usize = @intCast(owner[u]);
    if (extentOfPhys(@intCast(h), p)) |i| return @intFromBool(@as(u64, p - ext_p[i]) + n <= ext_size[i]);
    const off = p - P[h];
    return @intFromBool(@as(u64, off) + n <= S[h] or demand(h, off, n, false));
}
inline fn hi(v: u64) u32 {
    return @intCast(v >> 32);
}
inline fn lo(v: u64) u32 {
    return @truncate(v);
}

pub export fn tx(h_in: u32, l: u32) u32 {
    const h = h_in & 0x00ff_ffff; // a pointer's top-byte tag is not address
    if (h >= PLANES) return 0;
    const off = l -% L[h];
    if (off < S[h]) return P[h] + off;
    if (extentAt(h, l)) |i| return ext_p[i] + (l - ext_lo[i]);
    return if (demand(h, off, 1, true)) P[h] + off else 0;
}
export fn plane_reserved(h: u32) u32 {
    return @intFromBool(R[h & 255] != 0);
}
pub export fn va(phys: u32) u64 {
    const u = phys / UNIT;
    if (u >= unitCount() or owner[u] < 0) return phys;
    const h: u32 = @intCast(owner[u]);
    if (extentOfPhys(h, phys)) |i| return (@as(u64, h) << 32) | (ext_lo[i] + (phys - ext_p[i]));
    return (@as(u64, h) << 32) | (L[h] + (phys - P[h]));
}
/// `low` asks for plane 0, the only space the core executes from, whenever the mapping fits there
export fn map_va(n: u64, rsv: u32, low: u32, hint: u64) u64 {
    if (n == 0) return 0;
    // As Linux does, a mapping goes at its hint where that address space is free; PartitionAlloc's 32-bit pools
    // step their hints past the super pages they may not use.
    if (hint >= abi.ARENA_BASE and hint & (PAGE_SIZE - 1) == 0 and hint <= mem_size and n <= mem_size - hint) {
        const np: u32 = @intCast((n + PAGE_SIZE - 1) >> PAGE_SHIFT);
        const a = pageOf(@intCast(hint));
        if (std.mem.allEqual(u8, pages[a .. a + np], FREE)) return claim(@intCast(hint), np << PAGE_SHIFT, rsv);
    }
    if (n > @as(u64, 0x1_0000_0000) - PLANE_LO) {
        if (!planes) return 0;
        const count: usize = @intCast((n + 0xffff_ffff) / 0x1_0000_0000);
        var h: usize = 1;
        outer: while (h + count <= PLANES) : (h += 1) {
            for (h..h + count) |i| if (R[i] != 0) continue :outer;
            for (0..count) |i| {
                L[h + i] = 0;
                R[h + i] = @min(@as(u64, 0x1_0000_0000), n - @as(u64, i) * 0x1_0000_0000);
                if (rsv == 0) W[h + i] = R[h + i];
            }
            return @as(u64, h) << 32;
        }
        return 0;
    }
    // Large transient mappings strand the monotonic malloc bump when they share plane 0, and a
    // plane commits in whole pool units: keep sub-stack-sized mappings, reserved or not, in
    // plane 0 where they cost pages only.
    if (!planes or n < abi.STACK_SIZE or low != 0) {
        const p = map_pages(@intCast(n), rsv, PAGE_SIZE);
        if (p != 0 or !planes) return p;
    }
    var h: usize = 1;
    while (h < PLANES and R[h] != 0) h += 1;
    if (h == PLANES) return 0;
    L[h] = PLANE_LO;
    R[h] = n;
    if (rsv == 0) {
        W[h] = n;
        _ = grow(h, @intCast(n), true);
    }
    return (@as(u64, h) << 32) | L[h];
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
            if (off <= 0 and size >= R[h]) release(h) else {
                dropExtents(h, l, size, true);
                if (off > 0 and off + @as(i64, @intCast(size)) >= @as(i64, @intCast(R[h]))) {
                    R[h] = @intCast(off);
                    decommit_va(v, size);
                }
            }
        }
        n -= size;
        v += size;
    }
    return 1;
}
/// mremap's growth in place: [v, v + old_n) becomes [v, v + new_n) when the address space after it
/// is free, its new pages as accessible as its last one; 0 when they are taken
export fn extend_va(v: u64, old_n: u64, new_n: u64) u32 {
    const h = hi(v);
    const l = lo(v);
    if (v & (PAGE_SIZE - 1) != 0 or new_n <= old_n) return 0;
    if (h == 0) {
        if (l < abi.ARENA_BASE or @as(u64, l) + new_n > mem_size) return 0;
        const a = pageOf(@intCast((@as(u64, l) + old_n + PAGE_SIZE - 1) & ~@as(u64, PAGE_SIZE - 1)));
        const b: u32 = @intCast((@as(u64, l) + new_n + PAGE_SIZE - 1) >> PAGE_SHIFT);
        for (a..b) |i| if (pages[i] != FREE) return 0;
        const state = pages[a - 1];
        if (state != RESERVED and !back(@as(u64, b) << PAGE_SHIFT)) return 0;
        cpu.invalidate_range(a * PAGE_SIZE, (b - a) * PAGE_SIZE);
        @memset(pages[a..b], state);
        if (state != RESERVED) fill(a * PAGE_SIZE, 0, (b - a) * PAGE_SIZE);
        return 1;
    }
    // a plane holds one mapping, which grows into the free space after its reservation
    if (h >= PLANES or R[h] == 0 or l < L[h]) return 0;
    const off: u64 = l - L[h];
    if (off + old_n != R[h] or L[h] + off + new_n > 0x1_0000_0000) return 0;
    if (W[h] >= R[h]) W[h] = off + new_n;
    R[h] = off + new_n;
    return 1;
}
/// MAP_FIXED's and MREMAP_FIXED's claim on [v, v + n): address space no mapping holds becomes
/// reserved, as the kernel maps at any address in the process's range; the caller then commits or
/// reserves the range as usual. 0 when part of it is space the core keeps for itself (below the
/// arena, or a plane's pool unit) or past the planes.
export fn map_fixed(v: u64, n: u64) u32 {
    if (v & (PAGE_SIZE - 1) != 0 or n == 0) return 0;
    for (0..2) |pass| {
        var a = v;
        var left = n;
        while (left > 0) {
            const h = hi(a);
            const l = lo(a);
            const size: u64 = @min(left, 0x1_0000_0000 - @as(u64, l));
            if (h == 0) {
                if (l < abi.ARENA_BASE or l + size > mem_size) return 0;
                for (pageOf(l)..@as(usize, @intCast((l + size + PAGE_SIZE - 1) >> PAGE_SHIFT))) |i| {
                    if (pages[i] == POOL) return 0;
                    if (pass == 1 and pages[i] == FREE) pages[i] = RESERVED;
                    if (pass == 1) page_flags[i] &= ~@as(u8, abi.PAGE_READONLY);
                }
            } else if (h >= PLANES or !planes) {
                return 0;
            } else if (pass == 1 and !claimPlane(h, l, size)) return 0;
            left -= size;
            a += size;
        }
    }
    return 1;
}
/// plane h's one mapping widened to cover [l, l + size): a free plane starts there, a range past
/// its end extends it, and one before its start moves the committed prefix up to keep its offsets
fn claimPlane(h: usize, l: u32, size: u64) bool {
    if (R[h] == 0) {
        L[h] = l;
        R[h] = size;
        W[h] = 0;
        return true;
    }
    if (l < L[h]) {
        const d = L[h] - l;
        if (S[h] != 0) {
            const old = S[h];
            if (@as(u64, old) + d > 0xffff_f000 or !grow(h, old + d, true)) return false;
            move(P[h] + d, P[h], old);
            fill(P[h], 0, d);
        }
        if (W[h] != 0) W[h] += d;
        R[h] += d;
        L[h] = l;
    }
    R[h] = @max(R[h], @as(u64, l - L[h]) + size);
    return true;
}
export fn check_reserve(h: u32, l: u32, size: u32) u32 {
    if (h == 0) {
        if (l < abi.ARENA_BASE or @as(u64, l) + size > mem_size) return 0;
        var p = pageOf(l);
        while (p < pageOf(l +% size +% (PAGE_SIZE - 1))) : (p += 1) if (pages[p] == FREE or pages[p] == POOL) return 0;
        return 1;
    }
    return @intFromBool(h < PLANES and l >= L[h] and @as(u64, l - L[h]) + size <= R[h]);
}
export fn resident_va(v: u64) i32 {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) {
        if (l >= window) return if (page_flags[pageOf(l)] & abi.PAGE_MAPPED != 0) 1 else -1;
        if (l < abi.ARENA_BASE or l >= mem_size) return -1;
        const state = pages[pageOf(l)];
        return if (state == FREE or state == POOL) -1 else @intFromBool(state == USED or state == IMAGE);
    }
    if (h >= PLANES or R[h] == 0 or l < L[h] or @as(u64, l - L[h]) >= R[h]) return -1;
    return @intFromBool(l - L[h] < S[h] or extentAt(h, l) != null);
}
export fn commit_va(v: u64, n: u64) u32 {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) return commit_pages(l, @intCast(@min(n, 0xffff_ffff)));
    if (h >= PLANES or l < L[h]) return 0;
    const end: u64 = @as(u64, l - L[h]) + n;
    if (end > R[h]) return 0;
    if (l - L[h] > @as(u64, S[h]) + SPARSE_GAP) return @intFromBool(commitExtent(h, l, n));
    W[h] = @max(W[h], end);
    if (end > S[h]) _ = grow(h, @intCast(end), true);
    return 1;
}
export fn drop_va(v: u64, n: u64) u32 {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) {
        if (l < abi.ARENA_BASE or @as(u64, l) + n > mem_size) return 0;
        _ = cpu.code_write(l, @intCast(n));
        // what is committed of plane 0's pages: another plane's units are not this mapping
        const end = @min(@as(u64, l) + n, @as(u64, @wasmMemorySize(0)) << 16);
        var pg: u64 = l >> PAGE_SHIFT;
        while (pg << PAGE_SHIFT < end) : (pg += 1) if (pages[@intCast(pg)] != POOL) {
            const a: u32 = @intCast(@max(pg << PAGE_SHIFT, l));
            fill(a, 0, @intCast(@min((pg + 1) << PAGE_SHIFT, end) - a));
        };
        return 1;
    }
    const off = l - L[h];
    dropExtents(h, l, n, false);
    if (off < S[h]) {
        const size: u32 = @intCast(@min(S[h], off + n) - off);
        _ = cpu.code_write(P[h] + off, size);
        fill(P[h] + off, 0, size);
    }
    return 1;
}
/// mprotect's PROT_WRITE over [v, v + n) of plane 0, where a guest store faults without it; a
/// plane's pages keep no protection
export fn protect_va(v: u64, n: u64, writable: u32) void {
    if (hi(v) != 0) return;
    const a = @max(pageOf(lo(v)), pageOf(abi.ARENA_BASE));
    const b: u32 = @intCast(@min((@as(u64, lo(v)) + n + PAGE_SIZE - 1) >> PAGE_SHIFT, pageOf(mem_size)));
    for (a..@max(a, b)) |i| {
        if (writable != 0) page_flags[i] &= ~@as(u8, abi.PAGE_READONLY) else page_flags[i] |= abi.PAGE_READONLY;
    }
}
export fn decommit_va(v: u64, n: u64) void {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) {
        decommit_pages(l, @intCast(@min(n, 0xffff_ffff)));
        return;
    }
    const off = l - L[h];
    dropExtents(h, l, n, true);
    if (off + n >= W[h]) W[h] = @min(W[h], off);
    if (off < S[h] and off + n >= S[h]) {
        const at = P[h] / UNIT;
        give(at + unitsOf(off), unitsOf(S[h]) - unitsOf(off));
        S[h] = off;
    }
}

/// address space for a module image, the lowest that fits, zeroed: never freed
pub export fn reserve(size: u32, alignment: u32) u32 {
    abi.require(alignment != 0 and alignment & (alignment - 1) == 0, "reserve: alignment is not a power of two");
    const n = (size +% (PAGE_SIZE - 1)) & ~(PAGE_SIZE - 1);
    if (n == 0) return 0;
    const p = findRun(n >> PAGE_SHIFT, FREE, @max(alignment / PAGE_SIZE, 1), false);
    if (p == 0 or !back(@as(u64, p) + n)) return 0;
    cpu.invalidate_range(p, n);
    @memset(pages[pageOf(p) .. pageOf(p) + (n >> PAGE_SHIFT)], IMAGE);
    fill(p, 0, n);
    return p;
}

/// dlclose's unmapping of a module image: its pages are free for a later image or mapping
export fn release_image(base: u32, size: u32) void {
    const a = pageOf(base);
    const b = pageOf(base +% size +% (PAGE_SIZE - 1));
    if (base < abi.ARENA_BASE or b > pageOf(mem_size) or a >= b) return;
    cpu.invalidate_range(base, (b - a) * PAGE_SIZE);
    for (a..b) |i| if (pages[i] == IMAGE) {
        pages[i] = FREE;
    };
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

/// the process's address space: what is in use carries over, its planes do not
export fn mem_init(size: u32) void {
    for (0..owner.len) |u| if (owner[u] >= 0) give(@intCast(u), 1);
    mem_size = size;
    planes = size > abi.MEM_SIZE_A32;
    window = if (planes) 0xffff_ffff else abi.WINDOW;
    @memset(&R, 0);
    @memset(&S, 0);
    @memset(&W, 0);
    @memset(&L, PLANE_LO);
    @memset(&ext_h, 0);
    @memset(pages[0..pageOf(abi.ARENA_BASE)], USED);
    cpu.reset(planes);
    // the core's own data lies below the stacks: a guest store there faults, as below LOW
    @memset(page_flags[0..pageOf(abi.STACK_BASE)], 2);
    protectUnbacked();
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
        4 => @floatFromInt(mem_size - heap_top),
        5 => blk: {
            var n: u32 = 0;
            for (R) |r| n += @intFromBool(r != 0);
            break :blk @floatFromInt(n);
        },
        6 => blk: {
            var n: u32 = 0;
            for (owner) |o| n += @intFromBool(o >= 0);
            break :blk @floatFromInt(n);
        },
        7 => @floatFromInt(moves),
        else => 0,
    };
}
