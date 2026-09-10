// The guest CPU: one state struct per thread in linear memory, the slice run loop, and the
// per-page decode cache. A block is interpreted from a decoded-op cache until a control
// transfer; the loop hands control back to the host for a trampoline pc, the return sentinel,
// a fault, the budget, or a syscall the host owns.

const abi = @import("abi.zig");
const mem = @import("mem.zig");
const a64 = @import("a64.zig");
const arm = @import("arm.zig");
const libc = @import("libc.zig");
const jit = @import("jit.zig");

pub const Cpu = extern struct {
    // the architectural state Cpu.call saves and restores: everything up to `tls`
    x: [32]u64, // x31 is sp
    pc: u64,
    v: [32][16]u8 align(16),
    /// CPSR layout: N Z C V at 31..28, Q at 27, GE at 19..16, T at 5 (ARM32); A64 keeps NZCV here too
    cpsr: u32,
    fpcr: u32,
    fpsr: u32,
    /// exclusive monitor: set by a load-exclusive, consumed by the store
    excl: u32,
    tls: u64,
    ic: i64,
    /// the block being executed, for fault attribution
    bpc: u32,
    tid: u32,
    a64: u32,
    /// the trampoline slot (HOST), the fault code (FAULT) or the syscall number (SYSCALL) of the last exit
    exit: u32,
    fault_word: u32,
    fault_addr: u32,
    /// the thread's errno, for calls served in the core
    errno_addr: u32,
    /// the slice's instruction budget, for a region to leave at a block boundary
    ic_limit: i64,
    /// the thread's pthread key values, TLS_KEYS of them (libc.zig serves the lookups)
    tls_tab: u32,

    pub inline fn n(c: *Cpu) u32 {
        return c.cpsr >> 31;
    }
    pub inline fn z(c: *Cpu) u32 {
        return (c.cpsr >> 30) & 1;
    }
    pub inline fn cf(c: *Cpu) u32 {
        return (c.cpsr >> 29) & 1;
    }
    pub inline fn vf(c: *Cpu) u32 {
        return (c.cpsr >> 28) & 1;
    }
    pub inline fn setNZCV(c: *Cpu, nzcv: u32) void {
        c.cpsr = (c.cpsr & 0x0fff_ffff) | (nzcv & 0xf000_0000);
    }
    pub inline fn setQ(c: *Cpu) void {
        c.fpsr |= 1 << 27;
    }
};

pub const Exit = enum(u32) { budget = 0, host = 1, ret = 2, fault = 3, syscall = 4 };
/// what an instruction leaves the block loop with
pub const Status = enum(u8) { next, jump, fault, syscall };

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
};

export fn layout(i: u32) u32 {
    return switch (i) {
        0 => @sizeOf(Cpu),
        1 => @offsetOf(Cpu, "x"),
        2 => @offsetOf(Cpu, "pc"),
        3 => @offsetOf(Cpu, "v"),
        4 => @offsetOf(Cpu, "cpsr"),
        5 => @offsetOf(Cpu, "fpcr"),
        6 => @offsetOf(Cpu, "fpsr"),
        7 => @offsetOf(Cpu, "excl"),
        8 => @offsetOf(Cpu, "tls"),
        9 => @offsetOf(Cpu, "ic"),
        10 => @offsetOf(Cpu, "bpc"),
        11 => @offsetOf(Cpu, "tid"),
        12 => @offsetOf(Cpu, "a64"),
        13 => @offsetOf(Cpu, "exit"),
        14 => @offsetOf(Cpu, "fault_word"),
        15 => @offsetOf(Cpu, "fault_addr"),
        16 => @offsetOf(Cpu, "tls"), // the end of the saved state
        17 => @offsetOf(Cpu, "errno_addr"),
        18 => @offsetOf(Cpu, "tls_tab"),
        else => 0xffff_ffff,
    };
}

export fn cpu_alloc(tid: u32, is64: u32) u32 {
    const p = mem.calloc(1, @sizeOf(Cpu));
    if (p == 0) return 0;
    const c: *Cpu = @ptrFromInt(p);
    c.tid = tid;
    c.a64 = is64;
    return p;
}
export fn cpu_free(p: u32) void {
    _ = mem.free(p);
}

// ── the decode cache: one Op per instruction word of a page, decoded on first execution. The
// coverage bits say which words were decoded, so a store into the page's data leaves the code
// alone while a store into an executed word drops the page (self-modifying code, JIT stubs).
pub const OPS_PER_PAGE = abi.PAGE_SIZE / 4;
pub const Page = extern struct {
    cov: [OPS_PER_PAGE / 8]u8,
    /// which allocation of this page's block: a region compiled against an older one is stale
    epoch: u32,
    /// entries of this page executed, until the JIT takes the block (by halfword: Thumb blocks)
    heat: [2 * OPS_PER_PAGE]u16,
    /// table slot << 8 | block index of the region holding the block starting here (0: none)
    slot: [2 * OPS_PER_PAGE]u32,
    ops: [OPS_PER_PAGE]a64.Op,
};
const PAGE_BLOCK = (@sizeOf(Page) + abi.PAGE_SIZE - 1) & ~@as(u32, abi.PAGE_SIZE - 1);
/// page number → its decode block (0: none), sized for the largest memory
pub const DECODED = abi.KERN_BASE + 0x60_0000;
const decoded: [*]u32 = @ptrFromInt(DECODED);
pub var stats = extern struct { pages: u32 = 0, invalidated: u32 = 0, interp: u64 = 0 }{};
var epoch: u32 = 0;

pub fn decodedPage(pg: u32) ?*Page {
    const p = decoded[pg];
    return if (p == 0) null else @ptrFromInt(p);
}
// Decode blocks come from the image region, which the guest never owns: a block taken from
// the arena could be written through a pointer the guest freed and kept.
var free_blocks: [4096]u32 = undefined;
var nfree: u32 = 0;
fn allocBlock() u32 {
    var p: u32 = 0;
    if (nfree > 0) {
        nfree -= 1;
        p = free_blocks[nfree];
    } else p = mem.reserve(PAGE_BLOCK, abi.PAGE_SIZE);
    // a resized memory hands out the same addresses again: never trust a block to be clean
    if (p != 0) @memset(mem.bytes(p)[0..PAGE_BLOCK], 0);
    return p;
}
pub fn pageFor(pc: u32) ?*Page {
    const pg = pc >> abi.PAGE_SHIFT;
    var p = decoded[pg];
    if (p == 0) {
        p = allocBlock();
        if (p == 0) return null;
        decoded[pg] = p;
        mem.page_flags[pg] |= 1;
        stats.pages += 1;
        epoch += 1;
        @as(*Page, @ptrFromInt(p)).epoch = epoch;
    }
    return @ptrFromInt(p);
}
/// table slots whose regions the host dropped, until `jit_evict` takes their entries out
const dead: [*]u8 = @ptrFromInt(abi.KERN_BASE + 0xa4_0000);
export fn jit_kill(slot: u32) void {
    dead[slot] = 1;
}
/// every slot-map entry of a killed slot goes, and its block re-heats from zero
export fn jit_evict() void {
    var pg: u32 = 0;
    while (pg < (abi.MEM_SIZE_A64 >> abi.PAGE_SHIFT)) : (pg += 1) if (decoded[pg] != 0) {
        const page: *Page = @ptrFromInt(decoded[pg]);
        for (&page.slot, &page.heat) |*s, *h| if (s.* != 0 and dead[s.* >> 8] != 0) {
            s.* = 0;
            h.* = 0;
        };
    };
    @memset(dead[0 .. 1 << 18], 0);
}

// ── the JIT's helpers, imported by every region module
/// what regions hand to the interpreter: by op kind, and by the word's top 12 bits for the
/// SIMD&FP space (256 + those); ARM32 words count under 255
var fb_hist: [256 + 4096]u32 = [_]u32{0} ** (256 + 4096);
export fn fb_count(i: u32) u32 {
    return fb_hist[i % fb_hist.len];
}
/// the SIMD&FP words themselves, register fields masked off: what the space's histogram cannot name
const FB_WORDS = 4096;
var fb_words: [FB_WORDS]u32 = [_]u32{0} ** FB_WORDS;
var fb_wcounts: [FB_WORDS]u32 = [_]u32{0} ** FB_WORDS;
fn countWord(w: u32) void {
    // rd and rn go; rm too, but only where bits 16-20 are a register (the three-register forms)
    const key = (w & (if (w & 0x0020_0400 == 0x0020_0400) @as(u32, 0xffe0_fc00) else 0xffff_fc00)) | 1;
    var i = (key *% 0x9e37_79b9) >> 20;
    var probes: u32 = 0;
    while (probes < 8) : (probes += 1) {
        if (fb_words[i] == key or fb_words[i] == 0) {
            fb_words[i] = key;
            fb_wcounts[i] += 1;
            return;
        }
        i = (i + 1) & (FB_WORDS - 1);
    }
}
export fn fb_word(i: u32) u32 {
    return fb_words[i & (FB_WORDS - 1)] & ~@as(u32, 1);
}
export fn fb_wcount(i: u32) u32 {
    return fb_wcounts[i & (FB_WORDS - 1)];
}
/// the interpreter runs one word for a region: 0 next, 1 jump (pc set), 2 fault, 3 syscall
export fn exec_word(cp: u32, w: u32, pc: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    const page = pageFor(pc) orelse return 2;
    const i = (pc & (abi.PAGE_SIZE - 1)) >> 2;
    const o = &page.ops[i];
    if (o.kind == .raw) {
        o.* = a64.decode(w, pc);
        page.cov[i >> 3] |= @as(u8, 1) << @intCast(i & 7);
    }
    fb_hist[switch (o.kind) {
        .simd, .vmem, .vldrlit => blk: {
            countWord(w);
            break :blk 256 + (w >> 20);
        },
        else => @intFromEnum(o.kind),
    }] += 1;
    c.bpc = pc;
    switch (a64.exec(c, o, pc)) {
        .next => return 0,
        .jump => return 1,
        .fault => {
            c.pc = pc;
            return 2;
        },
        .syscall => return 3,
    }
}
/// the ARM32 interpreter runs one instruction for a region: the same statuses as exec_word
export fn exec_word32(cp: u32, pc: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    fb_hist[255] += 1;
    c.bpc = pc;
    // the ARM interpreter reports a taken branch through pc alone
    const len: u32 = if (c.cpsr & (1 << 5) != 0 and (mem.ptr(u16, pc).* & 0xf800) != 0xf000) 2 else 4;
    return switch (arm.step(c, pc)) {
        .next => @intFromBool(@as(u32, @truncate(c.pc)) != pc +% len),
        .jump => 1,
        .fault => 2,
        .syscall => 3,
    };
}
/// a plane address for a region: 0 when it does not translate (the fault is set)
export fn tx_addr(cp: u32, va: u64) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    if (a64.addr(c, va)) |a| return a;
    c.exit = @intFromEnum(Fault.bad_address);
    c.fault_word = 0;
    return 0;
}
/// a store into a flagged page: code goes stale, the null page faults
export fn on_store(cp: u32, a: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    const f = mem.page_flags[a >> abi.PAGE_SHIFT];
    if (f & 2 != 0) {
        c.exit = @intFromEnum(Fault.bad_address);
        c.fault_word = 0;
        c.fault_addr = a;
        return 1;
    }
    _ = code_write(a);
    return 0;
}
fn dropPage(pg: u32) void {
    const p = decoded[pg];
    if (p == 0) return;
    decoded[pg] = 0;
    mem.page_flags[pg] &= ~@as(u8, 1);
    if (nfree < free_blocks.len) {
        free_blocks[nfree] = p;
        nfree += 1;
    }
    stats.invalidated += 1;
}
/// a store into a page holding decoded code: the page is dropped if the word was decoded
pub export fn code_write(addr: u32) u32 {
    const pg = addr >> abi.PAGE_SHIFT;
    const p = decoded[pg];
    if (p == 0) return 0;
    const page: *Page = @ptrFromInt(p);
    const i = (addr & (abi.PAGE_SIZE - 1)) >> 2;
    if (page.cov[i >> 3] & (@as(u8, 1) << @intCast(i & 7)) == 0) return 0;
    dropPage(pg);
    return 1;
}
pub export fn invalidate_range(addr: u32, size: u32) void {
    var pg = addr >> abi.PAGE_SHIFT;
    const end = (addr +% size -% 1) >> abi.PAGE_SHIFT;
    while (pg <= end) : (pg += 1) dropPage(pg);
}
export fn invalidate_all() void {
    var pg: u32 = 0;
    while (pg < (abi.MEM_SIZE_A64 >> abi.PAGE_SHIFT)) : (pg += 1) dropPage(pg);
}
/// the memory was sized anew: every block address is stale
pub fn reset() void {
    invalidate_all();
    nfree = 0;
}
/// instructions the interpreter ran: against `ic`, the JIT's coverage
export fn interp_ic() f64 {
    return @floatFromInt(stats.interp);
}
export fn cpu_stat(i: u32) u32 {
    return switch (i) {
        0 => stats.pages,
        1 => stats.invalidated,
        else => libc.calls,
    };
}
/// instructions per interpreted block; 1 makes every instruction a slice boundary (the step tracer)
pub var max_block: u32 = 256;
export fn set_max_block(n: u32) void {
    max_block = n;
}

pub inline fn isTramp(pc: u32) bool {
    return pc >= abi.TRAMP_BASE and pc < abi.TRAMP_END;
}

/// run until the frame returns, a host call, a fault, or the budget: the exit code, with the
/// details in the struct
export fn run_slice(cp: u32, budget: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    const limit = c.ic + budget;
    c.ic_limit = limit;
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
            if (!libc.call(c, id)) {
                c.exit = @intFromEnum(Fault.bad_address);
                c.fault_word = 0;
                return @intFromEnum(Exit.fault);
            }
            // return as the host would: to lr, interworking on ARM32
            const lr: u32 = @truncate(c.x[if (c.a64 != 0) 30 else 14]);
            if (c.a64 != 0) c.pc = lr else {
                c.cpsr = (c.cpsr & ~@as(u32, 1 << 5)) | ((lr & 1) << 5);
                c.pc = lr & ~@as(u32, 1);
            }
            continue;
        }
        var st: Status = .jump;
        const page = pageFor(pc) orelse {
            c.exit = @intFromEnum(Fault.bad_address);
            c.fault_word = pc;
            return @intFromEnum(Exit.fault);
        };
        const i = (pc & (abi.PAGE_SIZE - 1)) >> 1;
        const s = page.slot[i];
        if (s != 0) {
            const f: *const fn (u32, u32) callconv(.c) u32 = @ptrFromInt(s >> 8);
            const r = f(cp, s & 255);
            if (r >= jit.STATUS_MAX) {
                // an ARM32 region leaves with an interworking target
                if (c.a64 != 0) c.pc = r else {
                    c.cpsr = (c.cpsr & ~@as(u32, 1 << 5)) | ((r & 1) << 5);
                    c.pc = r & ~@as(u32, 1);
                }
            } else switch (r) {
                2 => return @intFromEnum(Exit.fault),
                3 => return @intFromEnum(Exit.syscall),
                else => {},
            }
        } else {
            const h = page.heat[i] +% 1;
            page.heat[i] = h;
            // a request the queue has no room for is asked again at the block's next entry
            if (h == jit.HEAT and !jit.request(pc, if (c.a64 != 0) .a64 else if (c.cpsr & (1 << 5) != 0) .thumb else .arm)) page.heat[i] = h - 1;
            st = if (c.a64 != 0) a64.block(c, pc, page) else arm.block(c, pc);
        }
        switch (st) {
            .fault => return @intFromEnum(Exit.fault),
            .syscall => return @intFromEnum(Exit.syscall),
            else => {},
        }
        // a CAS loop's block ends between its load- and store-exclusive: another thread running
        // there would make the unconditional-success store write a stale value, so the monitor
        // holds the slice
        if (c.ic >= limit and (c.excl == 0 or c.ic >= limit + 256)) return @intFromEnum(Exit.budget);
    }
}
