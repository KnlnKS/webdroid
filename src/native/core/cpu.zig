// The guest CPU: one state struct per thread in linear memory, the slice run loop, and the
// per-page decode cache. A block is interpreted from a decoded-op cache until a control
// transfer; the loop hands control back to the host for a trampoline pc, the return sentinel,
// a fault, the budget, or a syscall the host owns.

const abi = @import("abi.zig");
const mem = @import("mem.zig");
const a64 = @import("a64.zig");

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
    ops: [OPS_PER_PAGE]a64.Op,
};
const PAGE_BLOCK = (@sizeOf(Page) + abi.PAGE_SIZE - 1) & ~@as(u32, abi.PAGE_SIZE - 1);
/// page number → its decode block (0: none), sized for the largest memory
const decoded: [*]u32 = @ptrFromInt(abi.KERN_BASE + 0x60_0000);
pub var stats = extern struct { pages: u32 = 0, invalidated: u32 = 0 }{};

pub fn pageFor(pc: u32) ?*Page {
    const pg = pc >> abi.PAGE_SHIFT;
    var p = decoded[pg];
    if (p == 0) {
        p = mem.map_pages(PAGE_BLOCK, 0, abi.PAGE_SIZE);
        if (p == 0) return null;
        decoded[pg] = p;
        mem.page_flags[pg] |= 1;
        stats.pages += 1;
    }
    return @ptrFromInt(p);
}
fn dropPage(pg: u32) void {
    const p = decoded[pg];
    if (p == 0) return;
    decoded[pg] = 0;
    mem.page_flags[pg] &= ~@as(u8, 1);
    _ = mem.unmap_pages(p, PAGE_BLOCK);
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
export fn invalidate_range(addr: u32, size: u32) void {
    var pg = addr >> abi.PAGE_SHIFT;
    const end = (addr +% size -% 1) >> abi.PAGE_SHIFT;
    while (pg <= end) : (pg += 1) dropPage(pg);
}
export fn invalidate_all() void {
    var pg: u32 = 0;
    while (pg < (abi.MEM_SIZE_A64 >> abi.PAGE_SHIFT)) : (pg += 1) dropPage(pg);
}
export fn cpu_stat(i: u32) u32 {
    return if (i == 0) stats.pages else stats.invalidated;
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
    while (true) {
        const pc: u32 = @truncate(c.pc);
        if (isTramp(pc)) {
            if (pc == abi.RET_SENTINEL) return @intFromEnum(Exit.ret);
            c.exit = (pc - abi.TRAMP_BASE) >> 3;
            return @intFromEnum(Exit.host);
        }
        const st = if (c.a64 != 0) a64.block(c, pc) else Status.fault;
        switch (st) {
            .fault => {
                if (c.a64 == 0) c.exit = @intFromEnum(Fault.unimplemented);
                return @intFromEnum(Exit.fault);
            },
            .syscall => return @intFromEnum(Exit.syscall),
            else => {},
        }
        // a CAS loop's block ends between its load- and store-exclusive: another thread running
        // there would make the unconditional-success store write a stale value, so the monitor
        // holds the slice
        if (c.ic >= limit and (c.excl == 0 or c.ic >= limit + 256)) return @intFromEnum(Exit.budget);
    }
}
