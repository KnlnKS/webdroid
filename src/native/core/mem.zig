// Guest memory: the malloc arena, the page allocator behind mmap, the address planes a 64-bit
// runtime reserves past the buffer, and the module/stack/host-data regions. Semantics are
// mem.ts's of old, one for one; the page tables live at KERN_BASE so they exist before the
// allocator that hands out everything else does.

const std = @import("std");
const abi = @import("abi.zig");

const PAGE_SHIFT = abi.PAGE_SHIFT;
const PAGE_SIZE = abi.PAGE_SIZE;
const MAX_PAGES: u32 = abi.MEM_SIZE_A64 >> PAGE_SHIFT;

pub inline fn ptr(comptime T: type, a: u32) *align(1) T {
    return @ptrFromInt(a);
}
pub inline fn bytes(a: u32) [*]u8 {
    return @ptrFromInt(a);
}
pub inline fn ld32(a: u32) u32 {
    return ptr(u32, a).*;
}
pub inline fn st32(a: u32, v: u32) void {
    ptr(u32, a).* = v;
}
fn fill(a: u32, v: u8, n: u32) void {
    @memset(bytes(a)[0..n], v);
}
pub fn move(d: u32, s: u32, n: u32) void {
    if (d <= s) std.mem.copyForwards(u8, bytes(d)[0..n], bytes(s)[0..n]) else std.mem.copyBackwards(u8, bytes(d)[0..n], bytes(s)[0..n]);
}

// ── page tables
const FREE = 0;
const RESERVED = 1;
const USED = 2;
const pages: [*]u8 = @ptrFromInt(abi.KERN_BASE);
/// bit 0: a page holding compiled code (a store into it invalidates); bit 1: never mapped
pub const page_flags: [*]u8 = @ptrFromInt(abi.KERN_BASE + 0x10_0000);
/// bytes of the page-run block starting at that page (0: none)
const big_len: [*]u32 = @ptrFromInt(abi.KERN_BASE + 0x20_0000);
inline fn pageOf(a: u32) u32 {
    return a >> PAGE_SHIFT;
}

// ── malloc arena: 16-byte size classes to 1 KiB, four classes per doubling to 256 KiB, whole
// pages above that. The header is 16 bytes before the block: [p-8] = owning block for aligned
// allocations or 0, [p-4] = class size. Page-run blocks carry no header; big_len knows them.
const CLASS_STEP = 16;
const SMALL_MAX = 1024;
const PAGE_MAX = 0x40000;
const HDR = 16;
var small_heads = [_]u32{0} ** (SMALL_MAX / CLASS_STEP + 1);
var big_heads = [_]u32{0} ** 32;
var mem_size: u32 = abi.MEM_SIZE_A32;
var heap_top: u32 = abi.ARENA_BASE;
var heap_peak: u32 = 0;
var blocks: u32 = 0;
var used: u64 = 0;
var module_bot: u32 = abi.MEM_SIZE_A32;
var stack_top: u32 = abi.STACK_BASE;
var host_top: u32 = abi.HOST_DATA;

fn classSize(n: u32) u32 {
    if (n <= SMALL_MAX) return @max(CLASS_STEP, (n + CLASS_STEP - 1) & ~@as(u32, CLASS_STEP - 1));
    const k: u5 = @intCast(31 - @clz(n - 1));
    const q = @as(u32, 1) << (k - 2);
    return ((n + q - 1) / q) * q;
}
fn bigIdx(cs: u32) usize {
    const k: u5 = @intCast(31 - @clz(cs - 1));
    return (@as(usize, k) - 10) * 4 + (cs >> (k - 2)) - 5;
}

/// First run of n pages starting at a multiple of `alignment` pages whose every page is at most
/// `allow`. A reservation (`phantom`) may run past the arena's end, over the images and beyond
/// memory: those pages can never be committed, and a reserve-then-trim caller unmaps them at once.
fn findRun(n: u32, allow: u8, alignment: u32, phantom_in: bool) u32 {
    const end = pageOf(if (pool_base != 0) pool_base else module_bot);
    const top: u32 = 0x100000;
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
/// grow the heap by n bytes through free pages, stepping over a mapping in its way
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

pub export fn malloc(n: u32) u32 {
    if (n > PAGE_MAX) {
        const p = map_pages(n, 0, PAGE_SIZE);
        if (p != 0) {
            big_len[pageOf(p)] = n;
            blocks += 1;
            used += n;
        }
        return p;
    }
    const cs = classSize(n);
    var p: u32 = 0;
    if (cs <= SMALL_MAX) {
        p = small_heads[cs / CLASS_STEP];
        if (p != 0) small_heads[cs / CLASS_STEP] = ld32(p);
    } else {
        p = big_heads[bigIdx(cs)];
        if (p != 0) big_heads[bigIdx(cs)] = ld32(p);
    }
    if (p == 0) {
        p = bump(cs + HDR);
        if (p == 0) return 0;
        p += HDR;
    }
    st32(p - 8, 0);
    st32(p - 4, cs);
    blocks += 1;
    used += cs;
    return p;
}
/// 0 for a corrupt header
pub export fn free(p_in: u32) u32 {
    if (p_in == 0) return 1;
    var p = p_in;
    if (p & (PAGE_SIZE - 1) == 0 and big_len[pageOf(p)] != 0) {
        const n = big_len[pageOf(p)];
        big_len[pageOf(p)] = 0;
        blocks -= 1;
        used -= n;
        _ = unmap_pages(p, n);
        return 1;
    }
    const own = ld32(p - 8);
    if (own != 0) p = own;
    const cs = ld32(p - 4);
    if (cs == 0 or cs > PAGE_MAX or (cs & 15) != 0) return 0;
    blocks -= 1;
    used -= cs;
    if (cs <= SMALL_MAX) {
        st32(p, small_heads[cs / CLASS_STEP]);
        small_heads[cs / CLASS_STEP] = p;
    } else {
        st32(p, big_heads[bigIdx(cs)]);
        big_heads[bigIdx(cs)] = p;
    }
    return 1;
}
pub export fn usable_size(p: u32) u32 {
    if (p == 0) return 0;
    if (p & (PAGE_SIZE - 1) == 0 and big_len[pageOf(p)] != 0) return big_len[pageOf(p)];
    return ld32(p - 4);
}
pub export fn realloc(p: u32, n: u32) u32 {
    if (p == 0) return malloc(n);
    if (n == 0) {
        _ = free(p);
        return 0;
    }
    const cur = usable_size(p);
    const big = p & (PAGE_SIZE - 1) == 0 and big_len[pageOf(p)] != 0;
    if (n <= cur and n >= cur >> 2 and !big) return p;
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
    if (alignment >= PAGE_SIZE and (alignment & (alignment - 1)) == 0) {
        const p = map_pages(n, 0, alignment);
        if (p != 0) {
            big_len[pageOf(p)] = n;
            blocks += 1;
            used += n;
        }
        return p;
    }
    const raw = malloc(n + alignment + HDR);
    if (raw == 0 or (raw & (PAGE_SIZE - 1) == 0 and big_len[pageOf(raw)] != 0)) return raw;
    const p = (raw + HDR + alignment - 1) & ~(alignment - 1);
    st32(p - 8, raw);
    st32(p - 4, n);
    return p;
}

// ── pages: FREE / RESERVED / USED. A reservation (an anonymous PROT_NONE mmap) holds address
// space, not pages: reservations may overlap one another, as overcommit lets a process reserve
// far more than it has, and a commit (mprotect to readable/writable) is what claims the pages.

/// n bytes of pages: a hole, then fresh heap, and for a reservation the uncommitted part of
/// other reservations. Pages of a mapping come zeroed; a reservation's are zeroed at commit.
pub export fn map_pages(n_in: u32, rsv: u32, alignment: u32) u32 {
    const n = (n_in +% (PAGE_SIZE - 1)) & ~(PAGE_SIZE - 1);
    if (n == 0) return 0;
    const np = n >> PAGE_SHIFT;
    // a reservation of 2A is the reserve-then-trim idiom for an A-aligned block: placing it on an
    // A boundary packs the kept blocks back to back instead of leaving an A-sized hole between them
    var al = alignment / PAGE_SIZE;
    if (rsv != 0 and np >= 256) al = @max(al, @as(u32, 1) << @intCast(31 - @clz((np + 1) >> 1)));
    al = @max(al, 1);
    const p = findRun(np, FREE, al, rsv != 0);
    if (p == 0) return 0;
    const a = pageOf(p);
    const b = @min(a + np, pageOf(module_bot));
    @memset(pages[a..b], if (rsv != 0) RESERVED else USED);
    if (rsv == 0) fill(p, 0, n);
    return p;
}
/// return a page-aligned run (any sub-range of a mapping); 0 when misaligned
pub export fn unmap_pages(addr: u32, n_in: u32) u32 {
    const n = (n_in +% (PAGE_SIZE - 1)) & ~(PAGE_SIZE - 1);
    if (addr & (PAGE_SIZE - 1) != 0 or n == 0 or addr < abi.ARENA_BASE) return 0;
    const a = pageOf(addr);
    const b = @min(a + (n >> PAGE_SHIFT), pageOf(module_bot));
    if (b > a) @memset(pages[a..b], FREE);
    return 1;
}
/// mprotect to accessible: a reserved page becomes a zeroed page of its own; 0 (ENOMEM) on an
/// unmapped or phantom one. Pages below the arena are the images' and the loader's own.
export fn commit_pages(addr: u32, n: u32) u32 {
    if (addr < abi.ARENA_BASE) return 0;
    const a = pageOf(addr);
    const b = pageOf(addr +% n +% (PAGE_SIZE - 1));
    if (b > pageOf(module_bot)) return 0;
    for (a..b) |i| if (pages[i] == FREE) return 0;
    for (a..b) |i| if (pages[i] == RESERVED) {
        pages[i] = USED;
        fill(@intCast(i * PAGE_SIZE), 0, PAGE_SIZE);
    };
    return 1;
}
/// mprotect to PROT_NONE: the pages go back to being address space
export fn decommit_pages(addr: u32, n: u32) void {
    const a = @max(pageOf(addr), pageOf(abi.ARENA_BASE));
    const b = @min(pageOf(addr +% n +% (PAGE_SIZE - 1)), pageOf(module_bot));
    var i = a;
    while (i < b) : (i += 1) if (pages[i] == USED) {
        pages[i] = RESERVED;
    };
}

// ── address planes. A pointer whose high half is h ≠ 0 lives in plane h: one mapping per plane,
// normally starting at PLANE_LO; large reservations span consecutive planes from offset zero.
// A plane's committed prefix is one contiguous run of the pool at the top of the arena, so a
// range in the plane is a range in the buffer for host and guest alike; a commit past the run
// grows it in place or moves it (the guest keeps its addresses; the move copies what is committed).
const UNIT: u32 = 1 << 25;
const PLANES = 256;
const PLANE_LO: u32 = 0x1000_0000;
var pool_base: u32 = 0;
var owner = [_]i16{-1} ** 64; // pool unit → plane, -1 free
var owner_len: u32 = 0;
var P = [_]u32{0} ** PLANES; // plane → buffer offset of its run
var R = [_]u64{0} ** PLANES; // reservation (0: plane free)
var S = [_]u32{0} ** PLANES; // committed prefix
var L = [_]u32{PLANE_LO} ** PLANES; // low base
var moves: u32 = 0;

inline fn unitsOf(n: u64) u32 {
    return @intCast((n + UNIT - 1) / UNIT);
}
fn poolUnits() u32 {
    return @min(owner_len, (module_bot - pool_base) / UNIT);
}
fn freeRun(units: u32, from: u32) i32 {
    const top = poolUnits();
    var run: u32 = 0;
    var i = from;
    while (i < top) : (i += 1) {
        run = if (owner[i] < 0) run + 1 else 0;
        if (run == units) return @intCast(i + 1 - units);
    }
    return -1;
}
/// the start of the largest free gap that holds `units`: room to grow in place behind a new run
fn widestRun(units: u32) i32 {
    const top = poolUnits();
    var best: i32 = -1;
    var best_len: u32 = 0;
    var i: u32 = 0;
    while (i < top) : (i += 1) {
        if (owner[i] >= 0) continue;
        var j = i;
        while (j < top and owner[j] < 0) j += 1;
        if (j - i >= units and j - i > best_len) {
            best = @intCast(i);
            best_len = j - i;
        }
        i = j;
    }
    return best;
}
/// the plane's run moves to the free run at `dst` (its `need` units), the guest none the wiser
fn moveRun(h: usize, dst: u32, need: u32) void {
    const at = (P[h] - pool_base) / UNIT;
    const have = unitsOf(S[h]);
    if (dst != at) {
        move(pool_base + dst * UNIT, P[h], S[h]);
        @memset(owner[at .. at + have], -1);
        moves += 1;
    }
    @memset(owner[dst .. dst + need], @intCast(h));
    P[h] = pool_base + dst * UNIT;
}
/// commit the plane's prefix up to `n` bytes: extend the run in place, or move it to a free run
fn grow(h: usize, n: u32) bool {
    const have = unitsOf(S[h]);
    const need = unitsOf(n);
    if (need > have) {
        const at: i32 = if (have != 0) @intCast((P[h] - pool_base) / UNIT) else -1;
        var dst: i32 = undefined;
        if (at < 0) dst = widestRun(need) else {
            const after: u32 = @intCast(at + @as(i32, @intCast(have)));
            dst = if (freeRun(need - have, after) == @as(i32, @intCast(after))) at else freeRun(need, 0);
        }
        if (dst < 0) return false;
        if (at < 0) {
            @memset(owner[@intCast(dst)..@as(usize, @intCast(dst)) + need], @intCast(h));
            P[h] = pool_base + @as(u32, @intCast(dst)) * UNIT;
        } else moveRun(h, @intCast(dst), need);
    }
    fill(P[h] + S[h], 0, n - S[h]);
    S[h] = n;
    return true;
}
fn release(h: usize) void {
    const at = (P[h] - pool_base) / UNIT;
    @memset(owner[at .. at + unitsOf(S[h])], -1);
    R[h] = 0;
    S[h] = 0;
}
inline fn hi(v: u64) u32 {
    return @intCast(v >> 32);
}
inline fn lo(v: u64) u32 {
    return @truncate(v);
}

/// plane h ≠ 0 address → buffer offset; 0 past the committed prefix, as the page would fault
pub export fn tx(h: u32, l: u32) u32 {
    const off = l -% L[h & 255];
    if (h >= PLANES or off >= S[h]) return 0;
    return P[h] + off;
}
export fn plane_reserved(h: u32) u32 {
    return @intFromBool(R[h & 255] != 0);
}
/// buffer offset → the address the guest knows it by: itself in plane 0, else the plane's
pub export fn va(phys: u32) u64 {
    if (pool_base == 0 or phys < pool_base) return phys;
    const u = (phys - pool_base) / UNIT;
    if (u >= owner_len or owner[u] < 0) return phys;
    const h: u32 = @intCast(owner[u]);
    return (@as(u64, h) << 32) | (L[h] + (phys - P[h]));
}
/// mmap: plane 0 while it has room, else a plane of its own (a reservation commits nothing yet;
/// a writable mapping is committed whole); 0 when neither has room
export fn map_va(n: u64, rsv: u32) u64 {
    if (n == 0) return 0;
    if (n > @as(u64, 0x1_0000_0000) - PLANE_LO) {
        if (rsv == 0 or pool_base == 0) return 0;
        const count: usize = @intCast((n + 0xffff_ffff) / 0x1_0000_0000);
        var h: usize = 1;
        outer: while (h + count <= PLANES) : (h += 1) {
            for (h..h + count) |i| if (R[i] != 0) continue :outer;
            for (0..count) |i| {
                L[h + i] = 0;
                R[h + i] = @min(@as(u64, 0x1_0000_0000), n - @as(u64, i) * 0x1_0000_0000);
            }
            return @as(u64, h) << 32;
        }
        return 0;
    }
    const p = map_pages(@intCast(n), rsv, PAGE_SIZE);
    if (p != 0 or pool_base == 0) return p;
    var h: usize = 1;
    while (h < PLANES and R[h] != 0) h += 1;
    if (h == PLANES or (rsv == 0 and !grow(h, @intCast(n)))) return 0;
    L[h] = PLANE_LO;
    R[h] = n;
    return (@as(u64, h) << 32) | L[h];
}
/// unmapping the tail shortens the plane; the whole of it frees the plane; a hole is a decommit
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
            if (off <= 0 and size >= R[h]) release(h) else if (off + @as(i64, @intCast(size)) >= @as(i64, @intCast(R[h]))) {
                R[h] = @intCast(off);
                decommit_va(v, size);
            }
        }
        n -= size;
        v += size;
    }
    return 1;
}
/// may this range be re-reserved over (MAP_FIXED on top of a mapping)?
export fn check_reserve(h: u32, l: u32, size: u32) u32 {
    if (h == 0) {
        if (l < abi.ARENA_BASE or @as(u64, l) + size > (if (pool_base != 0) pool_base else module_bot)) return 0;
        var p = pageOf(l);
        while (p < pageOf(l +% size +% (PAGE_SIZE - 1))) : (p += 1) if (pages[p] == FREE) return 0;
        return 1;
    }
    return @intFromBool(h < PLANES and l >= L[h] and @as(u64, l - L[h]) + size <= R[h]);
}
export fn commit_va(v: u64, n: u64) u32 {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) return commit_pages(l, @intCast(@min(n, 0xffff_ffff)));
    const end: u64 = @as(u64, l - L[h & 255]) + n;
    return @intFromBool(h < PLANES and l >= L[h] and end <= R[h] and (end <= S[h] or grow(h, @intCast(end))));
}
/// MADV_DONTNEED on a private anonymous mapping: what is committed of it reads back as zero.
/// 0 when the range is not the process's own to drop (the images, the loader's data).
export fn drop_va(v: u64, n: u64) u32 {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) {
        if (l < abi.ARENA_BASE or @as(u64, l) + n > (if (pool_base != 0) pool_base else module_bot)) return 0;
        fill(l, 0, @intCast(n));
        return 1;
    }
    const off = l - L[h];
    if (off < S[h]) fill(P[h] + off, 0, @intCast(@min(S[h], off + n) - off));
    return 1;
}
export fn decommit_va(v: u64, n: u64) void {
    const h = hi(v);
    const l = lo(v);
    if (h == 0) {
        decommit_pages(l, @intCast(@min(n, 0xffff_ffff)));
        return;
    }
    const off = l - L[h];
    if (off < S[h] and off + n >= S[h]) {
        const at = (P[h] - pool_base) / UNIT;
        @memset(owner[at + unitsOf(off) .. at + unitsOf(S[h])], -1);
        S[h] = off;
    }
}

// ── regions: modules bump DOWN from the top of the shared arena, malloc bumps up from the bottom
var last_err: u32 = 0;
export fn err() u32 {
    return last_err;
}
/// address space for a module image: never freed. 0 with `err` set: 0x100|h (the pool holds
/// plane h), 2 (the pool reaches the images), 3 (the heap does)
export fn reserve(size: u32, alignment: u32) u32 {
    const base = (module_bot - size) & ~(alignment - 1);
    // the pool's top units become the image's: a plane run up there moves down first
    if (pool_base != 0) {
        const keep = (base - pool_base) / UNIT;
        for (1..PLANES) |h| {
            if (R[h] == 0 or S[h] == 0) continue;
            const at = (P[h] - pool_base) / UNIT;
            const need = unitsOf(S[h]);
            if (at + need <= keep) continue;
            @memset(owner[at .. at + need], -1); // its own units count as free for the search
            var dst: i32 = -1;
            var run: u32 = 0;
            for (0..keep) |i| {
                run = if (owner[i] < 0) run + 1 else 0;
                if (run == need) {
                    dst = @intCast(i + 1 - need);
                    break;
                }
            }
            @memset(owner[at .. at + need], @intCast(h));
            if (dst < 0) {
                last_err = 0x100 | @as(u32, @intCast(h));
                return 0;
            }
            moveRun(h, @intCast(dst), need);
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
    module_bot = base;
    return base;
}

var free_stacks: [64][2]u32 = undefined; // (base, size) of finished threads' stacks
var free_stack_count: u32 = 0;
/// a thread stack of `size` bytes; 0 when the stack region is exhausted
export fn alloc_stack(size: u32) u32 {
    var i: u32 = 0;
    while (i < free_stack_count) : (i += 1) if (free_stacks[i][1] == size) {
        const base = free_stacks[i][0];
        free_stack_count -= 1;
        free_stacks[i] = free_stacks[free_stack_count];
        return base;
    };
    const base = stack_top +% abi.STACK_GUARD;
    const top = @as(u64, base) + size;
    if (top > abi.STACK_END) return 0;
    stack_top = @intCast(top);
    return base;
}
export fn free_stack(base: u32, size: u32) void {
    if (free_stack_count < free_stacks.len) {
        free_stacks[free_stack_count] = .{ base, size };
        free_stack_count += 1;
    }
}
/// host-owned guest data (FILE structs, JNI tables, static strings): bump only; 0 when full
export fn host_alloc(n: u32, alignment: u32) u32 {
    const p = (host_top + alignment - 1) & ~(alignment - 1);
    if (@as(u64, p) + n > abi.HOST_DATA_END) return 0;
    host_top = p + n;
    return p;
}

/// size the process's memory: the image region is reset, the arena and its tables carry over
export fn mem_init(size: u32) void {
    mem_size = size;
    module_bot = size;
    pool_base = if (size > abi.POOL_BASE) abi.POOL_BASE else 0;
    owner_len = if (pool_base != 0) @min(owner.len, (size - pool_base) / UNIT) else 0;
    @memset(&owner, -1);
    @memset(&R, 0);
    @memset(&S, 0);
    @memset(&L, PLANE_LO);
    @memset(pages[0..pageOf(heap_top + PAGE_SIZE - 1)], USED);
    @memset(page_flags[0..pageOf(abi.LOW)], 2);
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
            for (owner) |o| n += @intFromBool(o >= 0);
            break :blk @floatFromInt(n);
        },
        7 => @floatFromInt(moves),
        8 => @floatFromInt(module_bot),
        else => 0,
    };
}
