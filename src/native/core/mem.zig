const std = @import("std");
const abi = @import("abi.zig");
const cpu = @import("cpu.zig");
const lane = @import("lane.zig");
const assert = std.debug.assert;

const PAGE_SHIFT = abi.PAGE_SHIFT;
const PAGE_SIZE = abi.PAGE_SIZE;

pub inline fn ptr(comptime T: type, a: u32) *align(1) T {
    return @ptrFromInt(a);
}
pub inline fn bytes(a: u32) [*]u8 {
    return @ptrFromInt(a);
}
/// a load, which in an ARM32 process may be from its window (at an address the caller checked is mapped)
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
/// an ARM32 process's: a window onto the pool its processes share
pub fn hasWindow() bool {
    return window != 0xffff_ffff;
}
/// whether this process maps the n bytes at window address a, with the access (storing, when `write`)
pub fn windowed(a: u32, n: u32, write: bool) bool {
    if (a < window) return false;
    const mask: u8 = @intCast(abi.PAGE_MAPPED | abi.PAGE_NOACCESS | (if (write) abi.PAGE_READONLY else 0));
    const last = @as(u64, a) + @max(n, 1) - 1;
    if (last > 0xffff_ffff) return false;
    for (pageOf(a)..@as(usize, @intCast(last >> PAGE_SHIFT)) + 1) |pg| if (page_flags[pg] & mask != abi.PAGE_MAPPED) return false;
    return true;
}
/// windowed, or the fault an access there takes
pub fn windowAccess(c: *cpu.Cpu, a: u32, n: u32, write: bool) bool {
    if (windowed(a, n, write)) return true;
    c.fault_addr = a;
    return false;
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
/// page_flags of a mapped window page under protection `prot`
fn windowProt(prot: u32) u8 {
    return @intCast(abi.PAGE_GUARD | abi.PAGE_MAPPED | (if (prot & 3 == 0) abi.PAGE_NOACCESS else 0) | (if (prot & 2 == 0) abi.PAGE_READONLY else 0));
}
/// the pool offset each window page shows, reserved with the first mapping and guarded from guest
/// stores. JIT code reads it for any address at (address >> PAGE_SHIFT) % WINDOW_PAGES, the window
/// being the address space's top half.
pub var window_table: u32 = 0;
pub const WINDOW_PAGES = abi.PAGE_INDEX_MAX >> 1;
comptime {
    std.debug.assert(abi.WINDOW == WINDOW_PAGES << PAGE_SHIFT);
}
export fn window_table_ptr() u32 {
    return window_table;
}
/// mmap's placement of a mapping at [a, a + n) of the window under protection `prot` showing the
/// pool from offset `off`, or munmap's (prot < 0); false outside the window or without room for the table
export fn window_map(a: u32, n: u32, prot: i32, off: u32) u32 {
    lane.lock();
    defer lane.unlock();
    if (a < window or n == 0 or @as(u64, a) + n > @as(u64, abi.WINDOW) + abi.WINDOW_SIZE) return 0;
    const first = pageOf(a) % WINDOW_PAGES;
    const count = pageOf(a + (n - 1)) + 1 - pageOf(a);
    if (prot >= 0) {
        if (window_table == 0) {
            window_table = reserve(WINDOW_PAGES * 4, PAGE_SIZE);
            if (window_table == 0) return 0;
            @memset(page_flags[pageOf(window_table)..][0 .. WINDOW_PAGES * 4 >> PAGE_SHIFT], abi.PAGE_GUARD);
        }
        const table: [*]u32 = @ptrFromInt(window_table);
        for (table[first..][0..count], 0..) |*t, i| t.* = off + @as(u32, @intCast(i)) * PAGE_SIZE;
    }
    @memset(page_flags[pageOf(a)..][0..count], if (prot < 0) abi.PAGE_GUARD else windowProt(@intCast(prot)));
    return 1;
}
pub fn fill(a: u32, v: u8, n: u32) void {
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
/// whether this is a 64-bit process, whose address space has planes (plane.zig)
pub var planes = false;
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
pub fn back(end: u64) bool {
    const have = @as(u64, @wasmMemorySize(0)) << 16;
    if (end <= have) return true;
    if (end > mem_size) return false;
    const want = @min((end + COMMIT_STEP - 1) & ~(COMMIT_STEP - 1), mem_size);
    if (@wasmMemoryGrow(0, @intCast((want - have) >> 16)) < 0) return false;
    for (page_flags[@intCast(have >> PAGE_SHIFT)..@intCast(want >> PAGE_SHIFT)]) |*f| f.* &= ~@as(u8, abi.PAGE_GUARD);
    mem_grown();
    return true;
}
/// No page past what is backed is in use: a guest store there faults as on the core's own data
/// (the store path tests these flags already), and a load past ARM32's 2 GiB fails its address
/// test. A load below that into space not yet backed still traps in wasm.
fn protectUnbacked() void {
    @memset(page_flags[@intCast(@as(u64, @wasmMemorySize(0)) << 16 >> PAGE_SHIFT)..abi.PAGE_INDEX_MAX], abi.PAGE_GUARD);
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
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
pub export fn decommit_pages(addr: u32, n: u32) void {
    lane.lock();
    defer lane.unlock();
    const a = @max(pageOf(addr), pageOf(abi.ARENA_BASE));
    const b = @min(pageOf(addr +% n +% (PAGE_SIZE - 1)), pageOf(mem_size));
    var i = a;
    while (i < b) : (i += 1) if (pages[i] == USED) {
        cpu.invalidate_range(@intCast(i * PAGE_SIZE), PAGE_SIZE);
        pages[i] = RESERVED;
    };
}


/// address space for a module image, the lowest that fits, zeroed: never freed
pub export fn reserve(size: u32, alignment: u32) u32 {
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
        guard(p + abi.STACK_GUARD, abi.PAGE_GUARD);
        return p + abi.STACK_GUARD;
    }
    stack_top = @intCast(top);
    guard(base, abi.PAGE_GUARD);
    return base;
}
/// the guard gap below a stack: an overflowing store faults there rather than landing below it
fn guard(base: u32, flag: u8) void {
    const g = pageOf(base - abi.STACK_GUARD);
    for (g..pageOf(base)) |pg| page_flags[pg] = (page_flags[pg] & ~@as(u8, abi.PAGE_GUARD)) | flag;
}
export fn free_stack(base: u32, size: u32) void {
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
    const p = (host_top + alignment - 1) & ~(alignment - 1);
    if (@as(u64, p) + n > abi.HOST_DATA_END) return 0;
    host_top = p + n;
    return p;
}

/// plane 0 of a new process's address space (plane.zig's mem_init): what is in use carries over
pub fn init(size: u32) void {
    mem_size = size;
    planes = size > abi.MEM_SIZE_A32;
    window = if (planes) 0xffff_ffff else abi.WINDOW;
    @memset(pages[0..pageOf(abi.ARENA_BASE)], USED);
    cpu.reset(planes);
    // the core's own data lies below the stacks: a guest store there faults, as below LOW
    @memset(page_flags[0..pageOf(abi.STACK_BASE)], abi.PAGE_GUARD);
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
        else => 0,
    };
}

// Plane 0's part of the address-space calls plane.zig makes for a 64-bit address, each the caller's under the lock.

/// whether plane 0's n pages from page a, a multiple of 8, are all free for plane.zig's pool
pub fn poolFree(a: u32, n: u32) bool {
    const w: [*]align(1) const u64 = @ptrCast(pages + a);
    for (0..n / 8) |i| if (w[i] != FREE) return false;
    return true;
}
/// plane 0's n pages from page a go to plane.zig's pool, or come back free
pub fn pool(a: u32, n: u32, taken: bool) void {
    @memset(pages[a .. a + n], if (taken) POOL else FREE);
}
/// map_va's mapping at `hint`: null unless plane 0's pages there are free
pub fn mapAt(hint: u64, n: u64, rsv: u32) ?u32 {
    if (hint < abi.ARENA_BASE or hint & (PAGE_SIZE - 1) != 0 or hint > mem_size or n > mem_size - hint) return null;
    const np: u32 = @intCast((n + PAGE_SIZE - 1) >> PAGE_SHIFT);
    const a = pageOf(@intCast(hint));
    return if (std.mem.allEqual(u8, pages[a .. a + np], FREE)) claim(@intCast(hint), np << PAGE_SHIFT, rsv) else null;
}
/// extend_va's growth of [l, l + old_n) to new_n bytes where the pages after it are free
pub fn extend(l: u32, old_n: u64, new_n: u64) u32 {
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
/// map_fixed over [l, l + size): false where the core keeps the space; `claims` reserves what is free
pub fn fixed(l: u32, size: u64, claims: bool) bool {
    if (l < abi.ARENA_BASE or l + size > mem_size) return false;
    for (pageOf(l)..@as(usize, @intCast((l + size + PAGE_SIZE - 1) >> PAGE_SHIFT))) |i| {
        if (pages[i] == POOL) return false;
        if (!claims) continue;
        if (pages[i] == FREE) pages[i] = RESERVED;
        page_flags[i] &= ~@as(u8, abi.PAGE_READONLY);
    }
    return true;
}
/// check_reserve: whether a mapping holds all of [l, l + size)
pub fn reserved(l: u32, size: u32) u32 {
    if (l < abi.ARENA_BASE or @as(u64, l) + size > mem_size) return 0;
    var p = pageOf(l);
    while (p < pageOf(l +% size +% (PAGE_SIZE - 1))) : (p += 1) if (pages[p] == FREE or pages[p] == POOL) return 0;
    return 1;
}
/// resident_va: -1 unmapped, else whether the page at l is committed
pub fn resident(l: u32) i32 {
    if (l >= window) return if (page_flags[pageOf(l)] & abi.PAGE_MAPPED != 0) 1 else -1;
    if (l < abi.ARENA_BASE or l >= mem_size) return -1;
    const state = pages[pageOf(l)];
    return if (state == FREE or state == POOL) -1 else @intFromBool(state == USED or state == IMAGE);
}
pub fn commit(l: u32, n: u64) u32 {
    if (l < window) return commit_pages(l, @intCast(@min(n, 0xffff_ffff)));
    // mprotect's ENOMEM where the window has no mapping
    for (pageOf(l)..@intCast(@min((@as(u64, l) + n + PAGE_SIZE - 1) >> PAGE_SHIFT, abi.PAGE_INDEX_MAX))) |i| if (page_flags[i] & abi.PAGE_MAPPED == 0) return 0;
    return 1;
}
/// madvise(DONTNEED) of [l, l + n): its committed pages read zero
pub fn drop(l: u32, n: u64) u32 {
    // a window mapping is its region's pages, which keep their contents
    if (l >= window) return 1;
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
/// mprotect over [l, l + n): without PROT_WRITE a guest store faults, and on the window's mapped
/// pages an access without PROT_READ or PROT_WRITE faults too
pub fn protect(l: u32, n: u64, prot: u32) void {
    const last: u64 = (@as(u64, l) + n + PAGE_SIZE - 1) >> PAGE_SHIFT;
    if (l >= window) {
        for (pageOf(l)..@intCast(@min(last, abi.PAGE_INDEX_MAX))) |i| if (page_flags[i] & abi.PAGE_MAPPED != 0) {
            page_flags[i] = windowProt(prot);
        };
        return;
    }
    const a = @max(pageOf(l), pageOf(abi.ARENA_BASE));
    const b: u32 = @intCast(@min(last, pageOf(mem_size)));
    for (a..@max(a, b)) |i| {
        if (prot & 2 != 0) page_flags[i] &= ~@as(u8, abi.PAGE_READONLY) else page_flags[i] |= abi.PAGE_READONLY;
    }
}
