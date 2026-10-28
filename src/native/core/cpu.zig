const std = @import("std");
const abi = @import("abi.zig");
const assert = std.debug.assert;
const mem = @import("mem.zig");
const a64 = @import("a64.zig");
const arm = @import("arm.zig");
const libc = @import("libc.zig");
const jit = @import("jit.zig");
const lane = @import("lane.zig");
const is = @import("bits.zig").is;

pub const Cpu = extern struct {
    x: [32]u64,
    pc: u64,
    v: [32][16]u8 align(16),
    cpsr: u32,
    fpcr: u32,
    fpsr: u32,
    excl: u32,
    tls: u64,
    ic: i64,
    bpc: u32,
    tid: u32,
    os_tid: u32,
    pid: u32,
    a64: u32,
    exit: u32,
    fault_word: u32,
    /// the faulting data address (si_addr), the whole virtual address for a plane's
    fault_addr: u64,
    errno_addr: u32,
    ic_limit: i64,
    tls_tab: u32,
    /// what the last load-exclusive read, which the store-exclusive swaps out only while memory still holds it
    excl_val: u64,
    /// the high half of a 128-bit exclusive pair
    excl_val2: u64,

    pub inline fn cf(c: *Cpu) u32 {
        return (c.cpsr >> 29) & 1;
    }
    pub inline fn setNZCV(c: *Cpu, nzcv: u32) void {
        c.cpsr = (c.cpsr & 0x0fff_ffff) | (nzcv & 0xf000_0000);
    }
    pub inline fn setQ(c: *Cpu) void {
        c.fpsr |= 1 << 27;
    }
};

pub const Exit = enum(u32) { budget = 0, host = 1, ret = 2, fault = 3, syscall = 4 };
pub const Status = enum(u8) { next, jump, fault, syscall };
/// What a JIT region returns below LOW (any other value is the pc to go on at). jump, fault and
/// syscall are also what exec_word and exec_word32 return, as Status, and a region passes on.
pub const RegionExit = enum(u32) { jump = 1, fault = 2, syscall = 3, interpret = abi.REGION_INTERPRET };
comptime {
    for ([_]Status{ .jump, .fault, .syscall }) |s| assert(@intFromEnum(s) == @intFromEnum(@field(RegionExit, @tagName(s))));
}

pub const Fault = enum(u32) {
    unimplemented = 0,
    undefined = 1,
    bad_address = 2,
    misaligned_pc = 3,
    dc_zva = 4,
    brk = 5,
    unsupported_syscall = 6,
    sysreg = 7,
    null_page = 8,
    /// an optional extension HWCAP does not advertise: SIGILL, as on a CPU without it, where
    /// `.unimplemented` is a gap in the emulator
    extension = 9,
};

/// The guest-visible state is the run of fields up to `tls`; src/native/cpu.ts reads it through
/// layout slot 16 as ARCH_SIZE and snapshots that many bytes across a nested call.
const ARCH_END_FIELD = "tls";
pub const ARCH_SIZE = @offsetOf(Cpu, ARCH_END_FIELD);
const FIELDS = [_][]const u8{ "x", "pc", "v", "cpsr", "fpcr", "fpsr", "excl", "tls", "ic", "bpc", "tid", "a64", "exit", "fault_word", "fault_addr", ARCH_END_FIELD, "errno_addr", "tls_tab" };
comptime {
    // Slot 16 is a size, not a field: it is `tls`'s offset only while every architectural field is
    // declared above `tls`. Moving one below would shrink the snapshot and lose it silently.
    for ([_][]const u8{ "x", "pc", "v", "cpsr", "fpcr", "fpsr", "excl" }) |f| {
        assert(@offsetOf(Cpu, f) + @sizeOf(@FieldType(Cpu, f)) <= ARCH_SIZE);
    }
}
export fn layout(i: u32) u32 {
    if (i == 0) return @sizeOf(Cpu);
    inline for (FIELDS, 1..) |name, k| if (i == k) return @offsetOf(Cpu, name);
    return 0xffff_ffff;
}

export fn cpu_alloc(tid: u32, os_tid: u32, pid: u32, is64: u32) u32 {
    const p = mem.calloc(1, @sizeOf(Cpu));
    if (p == 0) return 0;
    const c: *Cpu = @ptrFromInt(p);
    c.tid = tid;
    c.os_tid = os_tid;
    c.pid = pid;
    c.a64 = is64;
    return p;
}
export fn cpu_free(p: u32) void {
    _ = mem.free(p);
}

pub const OPS_PER_PAGE = abi.PAGE_SIZE / 4;
pub const Page = extern struct {
    cov: [OPS_PER_PAGE / 8]u8,
    epoch: u32,
    heat: [2 * OPS_PER_PAGE]u8,
    slot: [2 * OPS_PER_PAGE]u32,
    ops: [OPS_PER_PAGE]a64.Op,
};
pub fn cover(page: *Page, from: u32, to: u32) void {
    // Both ends are masked to the page below, so a range that runs backwards or leaves the page
    // marks nothing at all and says so to nobody.
    assert(to >= from);
    assert(from >> abi.PAGE_SHIFT == to >> abi.PAGE_SHIFT);
    var i = (from & (abi.PAGE_SIZE - 1)) >> 2;
    const end = (to & (abi.PAGE_SIZE - 1)) >> 2;
    while (i <= end) : (i = (i | 7) + 1) {
        const hi: u4 = @intCast(@min(end - (i & ~@as(u32, 7)), 7));
        _ = @atomicRmw(u8, &page.cov[i >> 3], .Or, @truncate((@as(u16, 0xff) >> (7 - hi)) & (@as(u16, 0xff) << @as(u4, @intCast(i & 7)))), .monotonic);
    }
}
inline fn blockSize(comptime T: type) u32 {
    return (@sizeOf(T) + abi.PAGE_SIZE - 1) & ~@as(u32, abi.PAGE_SIZE - 1);
}
pub var page_block: u32 = blockSize(Page);
pub const DECODED = abi.KERN_DECODED;
const decoded: [*]u32 = @ptrFromInt(DECODED);
comptime {
    assert(@sizeOf(@TypeOf(decoded[0])) * abi.PAGE_INDEX_MAX <= abi.KERN_SLOT_FN - abi.KERN_DECODED);
}
pub var stats = extern struct { pages: u32 = 0, invalidated: u32 = 0 }{};
var epoch: u32 = 0;

pub fn decodedPage(pg: u32) ?*Page {
    const p = decoded[pg];
    return if (p == 0) null else @ptrFromInt(p);
}
var free_blocks: [4096]u32 = undefined;
var nfree: u32 = 0;
/// dropped blocks, each with the generation it was retired in (lane.zig)
var retired: [4096][2]u32 = undefined;
var nretired: u32 = 0;
fn reclaim() void {
    const floor = lane.floor();
    var keep: u32 = 0;
    for (retired[0..nretired]) |r| if (r[1] < floor and nfree < free_blocks.len) {
        free_blocks[nfree] = r[0];
        nfree += 1;
    } else {
        retired[keep] = r;
        keep += 1;
    };
    nretired = keep;
}
fn allocBlock() u32 {
    var p: u32 = 0;
    if (nfree == 0 and nretired != 0) reclaim();
    if (nfree > 0) {
        nfree -= 1;
        p = free_blocks[nfree];
    } else p = mem.reserve(page_block, abi.PAGE_SIZE);
    if (p != 0) @memset(mem.bytes(p)[0..page_block], 0);
    return p;
}
pub fn pageFor(pc: u32) ?*Page {
    const pg = pc >> abi.PAGE_SHIFT;
    const p = @atomicLoad(u32, &decoded[pg], .acquire);
    if (p != 0) return @ptrFromInt(p);
    lane.lock();
    defer lane.unlock();
    if (decoded[pg] == 0) {
        const b = allocBlock();
        if (b == 0) return null;
        epoch += 1;
        @as(*Page, @ptrFromInt(b)).epoch = epoch;
        mem.page_flags[pg] |= 1;
        stats.pages += 1;
        @atomicStore(u32, &decoded[pg], b, .release);
    }
    return @ptrFromInt(decoded[pg]);
}
/// Per table slot, the page.slot entries that name its region: a slot none names is free. A dropped
/// page releases its entries, so code the guest rewrites gives its slots back as it goes.
const refs: [*]u8 = @ptrFromInt(abi.KERN_REFS);
comptime {
    assert(@sizeOf(@TypeOf(refs[0])) * abi.JIT_SLOTS <= abi.KERN_REFS_END - abi.KERN_REFS);
}
/// a page.slot entry now names `v` (slot << 8 | block, or 0 for none)
pub fn setSlot(e: *u32, v: u32) void {
    if (e.* != 0) release(e.* >> 8);
    if (v != 0) refs[v >> 8] += 1;
    e.* = v;
}
/// Slots that lost their last entry, for the host to unlink so their module can be collected. One
/// the queue has no room for keeps its function until the slot is reused.
var freed: [4096]u32 = undefined;
var nfreed: u32 = 0;
/// While lanes run (lanes.ts), a slot that loses its last entry is held rather than free: a lane's
/// table may still link its old region, which a new region's entries would reach there. The host
/// frees it once every lane has unlinked it (jit_unhold).
const HELD: u8 = 0xff;
var holding = false;
fn release(slot: u32) void {
    refs[slot] -= 1;
    if (refs[slot] != 0) return;
    if (holding) refs[slot] = HELD;
    if (nfreed == freed.len) return;
    freed[nfreed] = slot;
    nfreed += 1;
}
/// a freed slot still free or held, or 0 once there are none; called before installing a batch,
/// whose slots may be ones freed since
export fn jit_reclaim() u32 {
    while (nfreed != 0) {
        nfreed -= 1;
        if (refs[freed[nfreed]] == 0 or refs[freed[nfreed]] == HELD) return freed[nfreed];
    }
    return 0;
}
/// the first lane starts: freed slots are held from here on
export fn jit_hold() void {
    holding = true;
}
export fn jit_unhold(slot: u32) void {
    if (refs[slot] == HELD) refs[slot] = 0;
}
/// whether a page entry names the slot's region
export fn jit_live(slot: u32) bool {
    return refs[slot] != 0 and refs[slot] != HELD;
}
var cursor: u32 = abi.JIT_SLOT0;
/// a slot no entry names, taken round the table so a freed one is reused last; when live regions fill
/// the table every one goes, and those still hot re-heat and come back. 0 while lanes hold them all.
pub fn freeSlot() u32 {
    return unnamedSlot() orelse {
        jit_flush();
        return unnamedSlot() orelse 0;
    };
}
fn unnamedSlot() ?u32 {
    for (abi.JIT_SLOT0..abi.JIT_SLOTS) |_| {
        const s = cursor;
        cursor = if (s + 1 == abi.JIT_SLOTS) abi.JIT_SLOT0 else s + 1;
        if (refs[s] == 0) return s;
    }
    return null;
}
/// flushes of the table, after which the host unlinks every slot (lanes.ts)
pub var flushes: u32 = 0;
export fn jit_flushes() u32 {
    return flushes;
}
export fn jit_flush() void {
    lane.lock();
    defer lane.unlock();
    flushes += 1;
    var pg: u32 = 0;
    while (pg < (abi.MEM_SIZE_A64 >> abi.PAGE_SHIFT)) : (pg += 1) if (decoded[pg] != 0) {
        const page: *Page = @ptrFromInt(decoded[pg]);
        for (&page.slot, &page.heat) |*s, *h| if (s.* != 0) {
            s.* = 0;
            h.* = 0;
        };
    };
    if (holding) {
        for (refs[abi.JIT_SLOT0..abi.JIT_SLOTS]) |*r| if (r.* != 0) {
            r.* = HELD;
        };
    } else @memset(refs[0..abi.JIT_SLOTS], 0);
}

/// JIT code's interpreter fallbacks by instruction form (register fields cleared): what the JIT leaves to
/// the interpreter in hot code (wd.native.fallbacks). Lanes may race on a count; it is a census, off until
/// asked for since its shared counts would contend on the fallback path.
var census = false;
var fallback_forms: [abi.FALLBACK_FORMS]u32 = [_]u32{0} ** abi.FALLBACK_FORMS;
var fallback_counts: [abi.FALLBACK_FORMS]u32 = [_]u32{0} ** abi.FALLBACK_FORMS;
fn countFallback(w: u32) void {
    const form = (w & 0xffe0_fc00) | 1;
    var i = (form *% 0x9e37_79b1) >> (32 - @ctz(abi.FALLBACK_FORMS));
    for (0..16) |_| {
        if (fallback_forms[i] == 0) fallback_forms[i] = form;
        if (fallback_forms[i] == form) {
            fallback_counts[i] +%= 1;
            return;
        }
        i = (i + 1) & (abi.FALLBACK_FORMS - 1);
    }
}
export fn jit_census() void {
    census = true;
}
/// entry i of the census: the form, and how many of its fallbacks were counted
export fn jit_fallback_form(i: u32) u32 {
    return fallback_forms[i] & ~@as(u32, 1);
}
export fn jit_fallback_count(i: u32) u32 {
    return fallback_counts[i];
}
export fn exec_word(cp: u32, w: u32, pc: u32) u32 {
    if (census) countFallback(w);
    const c: *Cpu = @ptrFromInt(cp);
    const page = pageFor(pc) orelse return 2;
    const o = &page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2];
    if (@atomicLoad(a64.Kind, &o.kind, .acquire) == .raw) {
        cover(page, pc, pc);
        a64.publish(o, pc, w);
    }
    c.bpc = pc;
    const s = a64.exec(c, o, pc);
    if (s == .fault) c.pc = pc;
    return @intFromEnum(s);
}
export fn exec_word32(cp: u32, pc: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    c.bpc = pc;
    const len: u32 = if (c.cpsr & (1 << 5) != 0 and (mem.ptr(u16, pc).* & 0xf800) < 0xe800) 2 else 4;
    const s = arm.step(c, pc);
    return if (s == .next) @intFromBool(@as(u32, @truncate(c.pc)) != pc +% len) else @intFromEnum(s);
}
export fn exec_it_block32(cp: u32, pc: u32, end: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    const pg = pc >> abi.PAGE_SHIFT;
    const source = decodedPage(pg) orelse {
        c.pc = pc;
        return 1;
    };
    const source_epoch = source.epoch;
    var at = pc;
    var n: u32 = 0;
    while (n < 5) : (n += 1) {
        const result = exec_word32(cp, at);
        c.ic += 1;
        if (result != 0) return result;
        at = @truncate(c.pc);
        if (n > 0 and ((((c.cpsr >> 8) & 0xfc) | ((c.cpsr >> 25) & 3)) == 0)) {
            const page = decodedPage(pg) orelse return 1;
            return @intFromBool(at != end or page.epoch != source_epoch);
        }
    }
    return 1;
}
pub inline fn raise(c: *Cpu, code: Fault, w: u32) Status {
    c.exit = @intFromEnum(if (code == .unimplemented and optionalExtension(c.a64 != 0, w)) .extension else code);
    c.fault_word = w;
    return .fault;
}
/// Encodings of the optional extensions getauxval(AT_HWCAP) leaves out. OpenSSL's armcap probes
/// SHA512, SHA3 and SM4 (and on ARM32 AES, PMULL and SHA1/SHA256) by executing one under a SIGILL
/// handler. ARM32 NEON words arrive here in their A32 form, Thumb's included.
fn optionalExtension(aarch64: bool, w: u32) bool {
    if (aarch64) return is(w, 0xff000000, 0xce000000) // SHA512, SHA3, SM3, SM4
    or is(w, 0xffff0000, 0xdac10000) // PAuth
    or is(w, 0x1e000000, 0x04000000); // SVE
    return is(w, 0xffb30f10, 0xf3b00300) // AESE, AESD, AESMC, AESIMC
    or is(w, 0xfe800f50, 0xf2000c40) // SHA1C..SHA256SU1
    or is(w, 0xffbf0fd0, 0xf3b902c0) // SHA1H
    or is(w, 0xffbf0f90, 0xf3ba0380) // SHA1SU1, SHA256SU0
    or is(w, 0xffb00f50, 0xf2a00e00) // VMULL.P64
    or is(w, 0x0f900df0, 0x01000040); // CRC32{C}
}
pub inline fn setPc32(c: *Cpu, target: u32) void {
    c.cpsr = (c.cpsr & ~@as(u32, 1 << 5)) | ((target & 1) << 5);
    c.pc = target & ~@as(u32, 1);
}
/// whether a page under [a, a + n) has flags a store must answer to
inline fn flagged(a: u32, n: u32) bool {
    return (mem.page_flags[a >> abi.PAGE_SHIFT] | mem.page_flags[(a +% (n - 1)) >> abi.PAGE_SHIFT]) != 0;
}
/// whether a store of n bytes at a may go ahead, as st decides it for an access outside the window
pub inline fn storable(c: *Cpu, a: u32, n: u32) bool {
    return !flagged(a, n) or on_store(@intFromPtr(c), a, n) == 0;
}
pub inline fn st(comptime T: type, c: *Cpu, a: u32, v: T) bool {
    const n = @sizeOf(T);
    if (flagged(a, n)) {
        if (a >= mem.window) return windowStore(T, c, a, v);
        if (on_store(@intFromPtr(c), a, n) != 0) return false;
    }
    mem.ptr(T, a).* = v;
    return true;
}
fn windowStore(comptime T: type, c: *Cpu, a: u32, v: T) bool {
    if (!mem.windowAccess(c, a, @sizeOf(T), true)) {
        _ = raise(c, .bad_address, 0);
        return false;
    }
    mem.windowStore(T, a, v);
    return true;
}
fn on_store(cp: u32, a: u32, n: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    const last = a +% (n - 1);
    for ([_]u32{ a, last }) |at| if (mem.page_flags[at >> abi.PAGE_SHIFT] & (abi.PAGE_GUARD | abi.PAGE_READONLY) != 0) {
        c.fault_addr = at;
        _ = raise(c, .bad_address, 0);
        return 1;
    };
    _ = code_write(a, n);
    return 0;
}
fn dropPage(pg: u32) void {
    const p = decoded[pg];
    if (p == 0) return;
    @atomicStore(u32, &decoded[pg], 0, .release);
    mem.page_flags[pg] &= ~@as(u8, 1);
    for (&@as(*Page, @ptrFromInt(p)).slot) |s| if (s != 0) release(s >> 8);
    if (nretired < retired.len) {
        retired[nretired] = .{ p, lane.retire() };
        nretired += 1;
    }
    stats.invalidated += 1;
}
pub export fn code_write(addr: u32, size: u32) u32 {
    if (size == 0) return 0;
    lane.lock();
    defer lane.unlock();
    const last: u32 = @intCast(@min(@as(u64, addr) + size, 0x1_0000_0000) - 1);
    var dropped: u32 = 0;
    for (addr >> abi.PAGE_SHIFT..(last >> abi.PAGE_SHIFT) + 1) |pg| {
        mem.page_flags[pg] &= ~@as(u8, abi.PAGE_WATCH);
        const page = decodedPage(@intCast(pg)) orelse continue;
        const lo = @max(addr, pg * abi.PAGE_SIZE) & (abi.PAGE_SIZE - 1);
        const hi = @min(last, (pg * abi.PAGE_SIZE) | (abi.PAGE_SIZE - 1)) & (abi.PAGE_SIZE - 1);
        var i = lo >> 2;
        const end = hi >> 2;
        while (i <= end) : (i = (i | 7) + 1) {
            const high: u4 = @intCast(@min(end - (i & ~@as(usize, 7)), 7));
            const mask: u8 = @truncate((@as(u16, 0xff) >> (7 - high)) & (@as(u16, 0xff) << @as(u4, @intCast(i & 7))));
            if (page.cov[i >> 3] & mask != 0) {
                dropPage(@intCast(pg));
                dropped += 1;
                break;
            }
        }
    }
    return dropped;
}
pub export fn invalidate_range(addr: u32, size: u32) void {
    if (size == 0) return;
    lane.lock();
    defer lane.unlock();
    var pg = addr >> abi.PAGE_SHIFT;
    const end: u32 = @intCast((@min(@as(u64, addr) + size, 0x1_0000_0000) - 1) >> abi.PAGE_SHIFT);
    while (pg <= end) : (pg += 1) dropPage(pg);
}
export fn invalidate_all() void {
    lane.lock();
    defer lane.unlock();
    var pg: u32 = 0;
    while (pg < (abi.MEM_SIZE_A64 >> abi.PAGE_SHIFT)) : (pg += 1) dropPage(pg);
}
pub fn reset(is64: bool) void {
    invalidate_all();
    nfree = 0;
    nretired = 0;
    page_block = if (is64) blockSize(Page) else blockSize(extern struct { cov: [OPS_PER_PAGE / 8]u8, epoch: u32, heat: [2 * OPS_PER_PAGE]u8, slot: [2 * OPS_PER_PAGE]u32 });
}
export fn cpu_stat(i: u32) u32 {
    return if (i == 0) stats.pages else stats.invalidated;
}
pub var max_block: u32 = 256;
export fn set_max_block(n: u32) void {
    // A block never leaves the page it started on, so a page of instructions is the whole range.
    abi.require(n >= 1 and n <= OPS_PER_PAGE, "set_max_block: out of range");
    max_block = n;
}

pub inline fn isTramp(pc: u32) bool {
    return pc >= abi.TRAMP_BASE and pc < abi.TRAMP_END;
}

/// Each lane's running Cpu, the process Worker's at CPU_CUR and a lane's past it, in the first 64 KiB
const CPU_STRIDE = std.mem.alignForward(u32, @sizeOf(Cpu), @alignOf(Cpu));
comptime {
    assert(abi.CPU_CUR % @alignOf(Cpu) == 0 and abi.CPU_CUR + lane.MAX * CPU_STRIDE <= abi.LOW);
}
inline fn current() *Cpu {
    return @ptrFromInt(abi.CPU_CUR + lane.id * CPU_STRIDE);
}
/// the thread whose state this lane's running Cpu holds, which run_slice copies back on return
threadlocal var running: ?*Cpu = null;
/// after a trap unwound run_slice: its thread's state back from the running Cpu, and the lane holds nothing
export fn slice_abort() void {
    if (running) |own| own.* = current().*;
    running = null;
    lane.reset();
}
export fn run_slice(cp: u32, budget: u32) u32 {
    abi.require(running == null, "run_slice: nested");
    lane.enter();
    const own: *Cpu = @ptrFromInt(cp);
    const c = current();
    c.* = own.*;
    running = own;
    defer slice_abort();
    const limit = c.ic + budget;
    c.ic_limit = limit;
    var interpret = false;
    while (true) {
        const pc: u32 = @truncate(c.pc);
        if (isTramp(pc)) {
            if (pc == abi.RET_SENTINEL) return @intFromEnum(Exit.ret);
            const slot = (pc - abi.TRAMP_BASE) >> 3;
            const id = libc.slot_fn[slot];
            if (id == 0 or libc.bypass) {
                c.exit = slot;
                return @intFromEnum(Exit.host);
            }
            switch (libc.call(c, id)) {
                .fault => {
                    _ = raise(c, .bad_address, 0);
                    return @intFromEnum(Exit.fault);
                },
                .host => {
                    c.exit = slot;
                    return @intFromEnum(Exit.host);
                },
                .done => {},
            }
            const lr: u32 = @truncate(c.x[if (c.a64 != 0) 30 else 14]);
            if (c.a64 != 0) c.pc = lr else setPc32(c, lr);
            continue;
        }
        // The first 64 KiB is never mapped and holds only the running Cpus (current()), nothing the
        // guest may run: a null-ish branch target faults here instead of being decoded, for either
        // ISA, as does one past the end of the memory.
        if (pc < abi.LOW or pc >= mem.mem_size) {
            c.fault_addr = pc;
            _ = raise(c, .null_page, pc);
            return @intFromEnum(Exit.fault);
        }
        var status: Status = .jump;
        const page = pageFor(pc) orelse {
            _ = raise(c, .bad_address, pc);
            return @intFromEnum(Exit.fault);
        };
        const i = (pc & (abi.PAGE_SIZE - 1)) >> 1;
        const s = page.slot[i];
        // the interpreter takes an instruction a region handed back, and one inside a Thumb IT block
        const interpreted = interpret or (c.a64 == 0 and c.cpsr & (1 << 5) != 0 and ((((c.cpsr >> 8) & 0xfc) | ((c.cpsr >> 25) & 3)) != 0));
        if (s != 0 and !interpreted) {
            const f: *const fn (u32, u32, u32, u32) callconv(.c) u32 = @ptrFromInt(s >> 8);
            const r = f(@intFromPtr(c), s & 255, 0, 0);
            // A region returns either the pc to go on at or one of the statuses below. Telling them
            // apart by LOW rather than by a bound of their own is what keeps a wild target from
            // being read as a status and leaving the pc where it was, which advances nothing.
            if (r >= abi.LOW) {
                if (c.a64 != 0) c.pc = r else setPc32(c, r);
            } else switch (r) {
                @intFromEnum(RegionExit.jump) => {},
                @intFromEnum(RegionExit.fault) => return @intFromEnum(Exit.fault),
                @intFromEnum(RegionExit.syscall) => return @intFromEnum(Exit.syscall),
                // a region handed its instruction back, or a lane's table does not link this one yet
                @intFromEnum(RegionExit.interpret) => interpret = true,
                else => {
                    // the branch was taken: the pc is the target, as an instruction abort reports it
                    if (c.a64 != 0) c.pc = r else setPc32(c, r);
                    c.fault_addr = r;
                    _ = raise(c, .null_page, r);
                    return @intFromEnum(Exit.fault);
                },
            }
        } else {
            interpret = false;
            if (s == 0) {
                const h = page.heat[i] +% 1;
                page.heat[i] = h;
                if (h == jit.HEAT and !jit.request(pc, if (c.a64 != 0) .a64 else if (c.cpsr & (1 << 5) != 0) .thumb else .arm)) page.heat[i] = h - 1;
            }
            status = if (c.a64 != 0) a64.block(c, pc, page) else arm.block(c, pc, page);
        }
        switch (status) {
            .fault => return @intFromEnum(Exit.fault),
            .syscall => return @intFromEnum(Exit.syscall),
            else => {},
        }
        if (c.ic >= limit and (c.excl == 0 or c.ic >= limit + 256)) return @intFromEnum(Exit.budget);
    }
}
