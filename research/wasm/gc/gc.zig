// Prototype of a precise, non-moving, size-segregated mark-sweep collector for a linear-memory JVM heap.
// Object: [u32 header][fields...]; header = size_in_16B_granules<<8 | nrefs (refs come first) ; bit31 = mark.
const std = @import("std");
const GRAN = 16;
const PAGE = 65536;
var heap_lo: u32 = 0;
var heap_hi: u32 = 0; // current end of region
var bump: u32 = 0;
var free_lists: [33]u32 = [_]u32{0} ** 33; // index = granules (1..32)
var shadow: [*]u32 = undefined;
var sp: u32 = 0;
var allocated_since: u32 = 0;
var live_bytes: u32 = 0;
var threshold: u32 = 16 << 20;
var markstack: [*]u32 = undefined;
var gc_count: u32 = 0;
var gc_ns_total: f64 = 0;

extern fn now() f64;

fn mem(a: u32) *u32 { return @ptrFromInt(a); }

fn growBy(bytes: u32) bool {
    const pages = (bytes + PAGE - 1) / PAGE;
    const old: isize = @wasmMemoryGrow(0, pages);
    if (old < 0) return false;
    heap_hi = @as(u32, @intCast(old)) * PAGE + pages * PAGE;
    return true;
}

export fn init(shadow_base: u32, mark_base: u32, start: u32) void {
    shadow = @ptrFromInt(shadow_base);
    markstack = @ptrFromInt(mark_base);
    heap_lo = start;
    bump = start;
    heap_hi = @as(u32, @intCast(@wasmMemorySize(0))) * PAGE;
    sp = 0; free_lists = [_]u32{0} ** 33; allocated_since = 0; threshold = 16 << 20; gc_count = 0; gc_ns_total = 0;
}
export fn stats(i: u32) f64 { return switch (i) { 0 => @floatFromInt(gc_count), 1 => gc_ns_total, 2 => @floatFromInt(bump - heap_lo), else => 0 }; }

fn mark_from(root: u32) void {
    var top: u32 = 0;
    if (root == 0) return;
    markstack[top] = root; top += 1;
    while (top > 0) {
        top -= 1;
        const o = markstack[top];
        const h = mem(o);
        if (h.* & 0x80000000 != 0) continue;
        h.* |= 0x80000000;
        const nrefs = h.* & 0xff;
        var i: u32 = 0;
        while (i < nrefs) : (i += 1) {
            const c = mem(o + 4 + i * 4).*;
            if (c != 0 and mem(c).* & 0x80000000 == 0) { markstack[top] = c; top += 1; }
        }
    }
}

fn collect() void {
    const t0 = now();
    var i: u32 = 0;
    while (i < sp) : (i += 1) mark_from(shadow[i]);
    // sweep whole heap linearly: objects are contiguous with size in header (free cells have nrefs=0 and tag bit 30)
    free_lists = [_]u32{0} ** 33;
    var p = heap_lo; var live: u32 = 0;
    while (p < bump) {
        const h = mem(p);
        const gran = (h.* >> 8) & 0x3fffff;
        const bytes = gran * GRAN;
        if (h.* & 0x80000000 != 0) { h.* &= 0x7fffffff; live += bytes; }
        else {
            h.* = (gran << 8) | 0x40000000; // free
            if (gran <= 32) { mem(p + 4).* = free_lists[gran]; free_lists[gran] = p; }
        }
        p += bytes;
    }
    live_bytes = live; allocated_since = 0;
    threshold = @max(16 << 20, live);
    gc_count += 1; gc_ns_total += now() - t0;
}

export fn alloc(size: u32, nrefs: u32) u32 {
    const gran = (size + 4 + GRAN - 1) / GRAN;
    if (allocated_since >= threshold) collect();
    allocated_since += gran * GRAN;
    var p = free_lists[gran];
    if (p != 0) {
        free_lists[gran] = mem(p + 4).*;
    } else {
        if (bump + gran * GRAN > heap_hi) { if (!growBy(@max(gran * GRAN, 1 << 20))) @trap(); }
        p = bump; bump += gran * GRAN;
    }
    mem(p).* = (gran << 8) | nrefs;
    var q = p + 4; const e = p + gran * GRAN;
    while (q < e) : (q += 4) mem(q).* = 0;
    return p;
}
export fn push(o: u32) void { shadow[sp] = o; sp += 1; }
export fn pop() void { sp -= 1; }

// binary-trees: node = [hdr][left][right][val]
fn mk(d: u32) u32 {
    const o = alloc(12, 2);
    if (d != 0) {
        push(o);
        const l = mk(d - 1); mem(o + 4).* = l;
        const r = mk(d - 1); mem(o + 8).* = r;
        pop();
    }
    mem(o + 12).* = 1;
    return o;
}
fn sum(n: u32) i32 { if (n == 0) return 0; return @as(i32, @intCast(mem(n + 12).*)) + sum(mem(n + 4).*) + sum(mem(n + 8).*); }
export fn run(d: u32, reps: u32) i32 {
    var s: i32 = 0; var r = reps;
    while (r > 0) : (r -= 1) { const t = mk(d); push(t); s += sum(t); pop(); }
    return s;
}
// long-lived tree kept across churn, as a mature heap
export fn keep(d: u32) void { const t = mk(d); push(t); }
