//! A process's address space by plane: plane 0 is the core's own pages (mem.zig), and each plane past
//! 4 GiB of a 64-bit process is a run of plane 0's pool units that its low addresses translate onto;
//! tx translates them for guest accesses.
const std = @import("std");
const abi = @import("abi.zig");
const cpu = @import("cpu.zig");
const lane = @import("lane.zig");
const mem = @import("mem.zig");

const PAGE_SHIFT = abi.PAGE_SHIFT;
const PAGE_SIZE = abi.PAGE_SIZE;

/// a plane's pages come from the pool in units this size: a small mapping still takes a whole one
const UNIT: u32 = 1 << 21;
const UNIT_PAGES = UNIT >> PAGE_SHIFT;
const PLANES = 256;
const PLANE_LO: u32 = 0x1000_0000;
/// A 64-bit process has planes; their pool is plane 0's free pages, a unit at a time, which plane
/// 0 then skips (POOL). owner[u] is the plane holding unit u, the buffer's [u * UNIT, (u + 1) * UNIT).
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
        mem.fill(ext_p[slot], 0, ext_size[slot]);
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
    if (a < b) mem.fill(ext_p[i] + @as(u32, @intCast(a - ext_lo[i])), 0, @intCast(b - a));
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
    return if (mem.planes) mem.mem_size / UNIT else 0;
}
/// no plane owns unit u and plane 0 has none of its pages
fn unitFree(u: u32) bool {
    if (owner[u] >= 0) return false;
    return mem.poolFree(u * UNIT_PAGES, UNIT_PAGES);
}
fn runFree(from: u32, units: u32) bool {
    if (from + units > unitCount()) return false;
    for (from..from + units) |u| if (!unitFree(@intCast(u))) return false;
    return true;
}
fn take(at: u32, units: u32, h: u32) void {
    @memset(owner[at .. at + units], @intCast(h));
    mem.pool(at * UNIT_PAGES, units * UNIT_PAGES, true);
}
fn give(at: u32, units: u32) void {
    @memset(owner[at .. at + units], -1);
    mem.pool(at * UNIT_PAGES, units * UNIT_PAGES, false);
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
    return if (mem.back(@as(u64, at + units) * UNIT)) at else null;
}
fn moveRun(h: usize, dst: u32, need: u32) void {
    const at = P[h] / UNIT;
    const have = unitsOf(S[h]);
    if (dst != at) {
        mem.move(dst * UNIT, P[h], S[h]);
        give(at, have);
        moves += 1;
    }
    take(dst, need, @intCast(h));
    P[h] = dst * UNIT;
}
/// commit [0, n) of plane h; moving it invalidates every translation into it, so a caller that
/// already holds one passes may_move = false, and one that does not reads P and S after
fn grow(h: usize, n: u32, may_move: bool) bool {
    // another lane may have grown it since the caller looked
    if (n <= S[h]) return true;
    const have = unitsOf(S[h]);
    const need = unitsOf(n);
    if (need > have) {
        if (have == 0) {
            const dst = placeRun(need, W[h] > n) orelse return false;
            take(dst, need, @intCast(h));
            P[h] = dst * UNIT;
        } else {
            const at = P[h] / UNIT;
            const in_place = runFree(at + have, need - have) and mem.back(@as(u64, at + need) * UNIT);
            if (!in_place) {
                // only lane 0 moves a plane: another lane's access faults, and lane 0 runs it again
                if (!may_move or lane.id != 0) return false;
                if (lane.quiesce()) return grow(h, n, may_move);
            }
            moveRun(h, if (in_place) at else placeRun(need, true) orelse return false, need);
        }
    }
    mem.fill(P[h] + S[h], 0, n - S[h]);
    // other lanes translate through S unlocked, so the zeroed pages go first
    @atomicStore(u32, &S[h], n, .release);
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
    lane.lock();
    defer lane.unlock();
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
    lane.lock();
    defer lane.unlock();
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
    if (l -% L[h] < S[h]) return P[h] + (l -% L[h]);
    lane.lock();
    defer lane.unlock();
    const off = l -% L[h];
    if (extentAt(h, l)) |i| return ext_p[i] + (l - ext_lo[i]);
    return if (demand(h, off, 1, true)) P[h] + off else 0;
}
export fn plane_reserved(h: u32) u32 {
    return @intFromBool(R[h & 255] != 0);
}
pub export fn va(phys: u32) u64 {
    lane.lock();
    defer lane.unlock();
    const u = phys / UNIT;
    if (u >= unitCount() or owner[u] < 0) return phys;
    const h: u32 = @intCast(owner[u]);
    if (extentOfPhys(h, phys)) |i| return (@as(u64, h) << 32) | (ext_lo[i] + (phys - ext_p[i]));
    return (@as(u64, h) << 32) | (L[h] + (phys - P[h]));
}
/// `low` asks for plane 0, the only space the core executes from, whenever the mapping fits there
export fn map_va(n: u64, rsv: u32, low: u32, hint: u64) u64 {
    lane.lock();
    defer lane.unlock();
    if (n == 0) return 0;
    // As Linux does, a mapping goes at its hint where that address space is free; PartitionAlloc's 32-bit pools
    // step their hints past the super pages they may not use.
    if (mem.mapAt(hint, n, rsv)) |p| return p;
    if (n > @as(u64, 0x1_0000_0000) - PLANE_LO) {
        if (!mem.planes) return 0;
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
    if (!mem.planes or n < abi.STACK_SIZE or low != 0) {
        const p = mem.map_pages(@intCast(n), rsv, PAGE_SIZE);
        if (p != 0 or !mem.planes) return p;
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
    lane.lock();
    defer lane.unlock();
    if (va_in & (PAGE_SIZE - 1) != 0 or n_in == 0) return 0;
    var v = va_in;
    var n = n_in;
    while (n > 0) {
        const h = hi(v);
        const l = lo(v);
        const size: u64 = @min(n, 0x1_0000_0000 - @as(u64, l));
        if (h == 0) {
            if (mem.unmap_pages(l, @intCast(@min(size, 0xffff_ffff))) == 0) return 0;
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
    lane.lock();
    defer lane.unlock();
    const h = hi(v);
    const l = lo(v);
    if (v & (PAGE_SIZE - 1) != 0 or new_n <= old_n) return 0;
    if (h == 0) return mem.extend(l, old_n, new_n);
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
    lane.lock();
    defer lane.unlock();
    if (v & (PAGE_SIZE - 1) != 0 or n == 0) return 0;
    for (0..2) |pass| {
        var a = v;
        var left = n;
        while (left > 0) {
            const h = hi(a);
            const l = lo(a);
            const size: u64 = @min(left, 0x1_0000_0000 - @as(u64, l));
            if (h == 0) {
                if (!mem.fixed(l, size, pass == 1)) return 0;
            } else if (h >= PLANES or !mem.planes) {
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
            // the host's mappings run on lane 0
            if (lane.quiesce()) return claimPlane(h, l, size);
            const old = S[h];
            if (@as(u64, old) + d > 0xffff_f000 or !grow(h, old + d, true)) return false;
            mem.move(P[h] + d, P[h], old);
            mem.fill(P[h], 0, d);
        }
        if (W[h] != 0) W[h] += d;
        R[h] += d;
        L[h] = l;
    }
    R[h] = @max(R[h], @as(u64, l - L[h]) + size);
    return true;
}
export fn check_reserve(h: u32, l: u32, size: u32) u32 {
    lane.lock();
    defer lane.unlock();
    if (h == 0) return mem.reserved(l, size);
    return @intFromBool(h < PLANES and l >= L[h] and @as(u64, l - L[h]) + size <= R[h]);
}
export fn resident_va(v: u64) i32 {
    lane.lock();
    defer lane.unlock();
    const h = hi(v);
    const l = lo(v);
    if (h == 0) return mem.resident(l);
    if (h >= PLANES or R[h] == 0 or l < L[h] or @as(u64, l - L[h]) >= R[h]) return -1;
    return @intFromBool(l - L[h] < S[h] or extentAt(h, l) != null);
}
export fn commit_va(v: u64, n: u64) u32 {
    lane.lock();
    defer lane.unlock();
    const h = hi(v);
    const l = lo(v);
    if (h == 0) return mem.commit(l, n);
    if (h >= PLANES or l < L[h]) return 0;
    const end: u64 = @as(u64, l - L[h]) + n;
    if (end > R[h]) return 0;
    if (l - L[h] > @as(u64, S[h]) + SPARSE_GAP) return @intFromBool(commitExtent(h, l, n));
    W[h] = @max(W[h], end);
    if (end > S[h]) _ = grow(h, @intCast(end), true);
    return 1;
}
export fn drop_va(v: u64, n: u64) u32 {
    lane.lock();
    defer lane.unlock();
    const h = hi(v);
    const l = lo(v);
    if (h == 0) return mem.drop(l, n);
    const off = l - L[h];
    dropExtents(h, l, n, false);
    if (off < S[h]) {
        const size: u32 = @intCast(@min(S[h], off + n) - off);
        _ = cpu.code_write(P[h] + off, size);
        mem.fill(P[h] + off, 0, size);
    }
    return 1;
}
/// mprotect over [v, v + n): a plane's pages keep no protection
export fn protect_va(v: u64, n: u64, prot: u32) void {
    lane.lock();
    defer lane.unlock();
    if (hi(v) == 0) mem.protect(lo(v), n, prot);
}
export fn decommit_va(v: u64, n: u64) void {
    lane.lock();
    defer lane.unlock();
    const h = hi(v);
    const l = lo(v);
    if (h == 0) {
        mem.decommit_pages(l, @intCast(@min(n, 0xffff_ffff)));
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

/// a new process's address space: what is in use in plane 0 carries over, and what its planes held goes back to the pool
export fn mem_init(size: u32) void {
    lane.lock();
    defer lane.unlock();
    for (0..owner.len) |u| if (owner[u] >= 0) give(@intCast(u), 1);
    @memset(&R, 0);
    @memset(&S, 0);
    @memset(&W, 0);
    @memset(&L, PLANE_LO);
    @memset(&ext_h, 0);
    mem.init(size);
}
/// planes reserved, units they hold, plane moves
export fn plane_stat(i: u32) f64 {
    var n: u32 = 0;
    switch (i) {
        0 => for (R) |r| {
            n += @intFromBool(r != 0);
        },
        1 => for (owner) |o| {
            n += @intFromBool(o >= 0);
        },
        else => n = moves,
    }
    return @floatFromInt(n);
}
