const abi = @import("abi.zig");
const mem = @import("mem.zig");
const a64 = @import("a64.zig");
const arm = @import("arm.zig");
const libc = @import("libc.zig");
const jit = @import("jit.zig");

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
    a64: u32,
    exit: u32,
    fault_word: u32,
    fault_addr: u32,
    errno_addr: u32,
    ic_limit: i64,
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

const FIELDS = [_][]const u8{ "x", "pc", "v", "cpsr", "fpcr", "fpsr", "excl", "tls", "ic", "bpc", "tid", "a64", "exit", "fault_word", "fault_addr", "tls", "errno_addr", "tls_tab" };
export fn layout(i: u32) u32 {
    if (i == 0) return @sizeOf(Cpu);
    inline for (FIELDS, 1..) |name, k| if (i == k) return @offsetOf(Cpu, name);
    return 0xffff_ffff;
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

pub const OPS_PER_PAGE = abi.PAGE_SIZE / 4;
pub const Page = extern struct {
    cov: [OPS_PER_PAGE / 8]u8,
    epoch: u32,
    heat: [2 * OPS_PER_PAGE]u8,
    slot: [2 * OPS_PER_PAGE]u32,
    ops: [OPS_PER_PAGE]a64.Op,
};
pub fn cover(page: *Page, from: u32, to: u32) void {
    var i = (from & (abi.PAGE_SIZE - 1)) >> 2;
    const end = (to & (abi.PAGE_SIZE - 1)) >> 2;
    while (i <= end) : (i = (i | 7) + 1) {
        const hi: u4 = @intCast(@min(end - (i & ~@as(u32, 7)), 7));
        page.cov[i >> 3] |= @truncate((@as(u16, 0xff) >> (7 - hi)) & (@as(u16, 0xff) << @as(u4, @intCast(i & 7))));
    }
}
inline fn blockSize(comptime T: type) u32 {
    return (@sizeOf(T) + abi.PAGE_SIZE - 1) & ~@as(u32, abi.PAGE_SIZE - 1);
}
pub var page_block: u32 = blockSize(Page);
pub const DECODED = abi.KERN_BASE + 0x60_0000;
const decoded: [*]u32 = @ptrFromInt(DECODED);
pub var stats = extern struct { pages: u32 = 0, invalidated: u32 = 0 }{};
var epoch: u32 = 0;

pub fn decodedPage(pg: u32) ?*Page {
    const p = decoded[pg];
    return if (p == 0) null else @ptrFromInt(p);
}
var free_blocks: [4096]u32 = undefined;
var nfree: u32 = 0;
fn allocBlock() u32 {
    var p: u32 = 0;
    if (nfree > 0) {
        nfree -= 1;
        p = free_blocks[nfree];
    } else p = mem.reserve(page_block, abi.PAGE_SIZE);
    if (p != 0) @memset(mem.bytes(p)[0..page_block], 0);
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
const dead: [*]u8 = @ptrFromInt(abi.KERN_BASE + 0xa4_0000);
export fn jit_kill(slot: u32) void {
    dead[slot] = 1;
}
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

export fn exec_word(cp: u32, w: u32, pc: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    const page = pageFor(pc) orelse return 2;
    const i = (pc & (abi.PAGE_SIZE - 1)) >> 2;
    const o = &page.ops[i];
    if (o.kind == .raw) {
        o.* = a64.decode(w, pc);
        cover(page, pc, pc);
    }
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
export fn exec_word32(cp: u32, pc: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    c.bpc = pc;
    const len: u32 = if (c.cpsr & (1 << 5) != 0 and (mem.ptr(u16, pc).* & 0xf800) != 0xf000) 2 else 4;
    return switch (arm.step(c, pc)) {
        .next => @intFromBool(@as(u32, @truncate(c.pc)) != pc +% len),
        .jump => 1,
        .fault => 2,
        .syscall => 3,
    };
}
pub inline fn raise(c: *Cpu, code: Fault, w: u32) Status {
    c.exit = @intFromEnum(code);
    c.fault_word = w;
    return .fault;
}
pub inline fn setPc32(c: *Cpu, target: u32) void {
    c.cpsr = (c.cpsr & ~@as(u32, 1 << 5)) | ((target & 1) << 5);
    c.pc = target & ~@as(u32, 1);
}
pub inline fn st(comptime T: type, c: *Cpu, a: u32, v: T) bool {
    const f = mem.page_flags[a >> abi.PAGE_SHIFT];
    if (f != 0) {
        if (f & 2 != 0) {
            c.fault_addr = a;
            return false;
        }
        _ = code_write(a);
    }
    mem.ptr(T, a).* = v;
    return true;
}
export fn on_store(cp: u32, a: u32) u32 {
    const c: *Cpu = @ptrFromInt(cp);
    if (mem.page_flags[a >> abi.PAGE_SHIFT] & 2 != 0) {
        c.fault_addr = a;
        _ = raise(c, .bad_address, 0);
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
pub fn reset(is64: bool) void {
    invalidate_all();
    nfree = 0;
    page_block = if (is64) blockSize(Page) else blockSize(extern struct { cov: [OPS_PER_PAGE / 8]u8, epoch: u32, heat: [2 * OPS_PER_PAGE]u8, slot: [2 * OPS_PER_PAGE]u32 });
}
export fn cpu_stat(i: u32) u32 {
    return if (i == 0) stats.pages else stats.invalidated;
}
pub var max_block: u32 = 256;
export fn set_max_block(n: u32) void {
    max_block = n;
}

pub inline fn isTramp(pc: u32) bool {
    return pc >= abi.TRAMP_BASE and pc < abi.TRAMP_END;
}

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
        var status: Status = .jump;
        const page = pageFor(pc) orelse {
            _ = raise(c, .bad_address, pc);
            return @intFromEnum(Exit.fault);
        };
        const i = (pc & (abi.PAGE_SIZE - 1)) >> 1;
        const s = page.slot[i];
        if (s != 0) {
            const f: *const fn (u32, u32) callconv(.c) u32 = @ptrFromInt(s >> 8);
            const r = f(cp, s & 255);
            if (r >= jit.STATUS_MAX) {
                if (c.a64 != 0) c.pc = r else setPc32(c, r);
            } else switch (r) {
                2 => return @intFromEnum(Exit.fault),
                3 => return @intFromEnum(Exit.syscall),
                else => {},
            }
        } else {
            const h = page.heat[i] +% 1;
            page.heat[i] = h;
            if (h == jit.HEAT and !jit.request(pc, if (c.a64 != 0) .a64 else if (c.cpsr & (1 << 5) != 0) .thumb else .arm)) page.heat[i] = h - 1;
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
