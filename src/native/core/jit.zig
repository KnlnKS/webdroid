// The JIT: a hot A64 region — the blocks reachable from an entry through direct branches
// inside its page — becomes one wasm function over the decoded ops. Registers live in i64
// locals, NZCV in four i32 locals, and blocks dispatch through a br_table so loops stay inside
// the function. What the emitter does not inline calls the interpreter for that one word after
// spilling, so semantics have one home (a64.zig). The host compiles the batch and links each
// region into the function table; the page's slot map then routes the dispatcher to it.

const abi = @import("abi.zig");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const a64 = @import("a64.zig");
const wasm = @import("wasm.zig");
const jit32 = @import("jit32.zig");
const Cpu = cpu.Cpu;
const Op = a64.Op;
const Buf = wasm.Buf;
const O = wasm.Op;

pub const HEAT = 48;
const MAX_BLOCKS = 40;
const MAX_INSTR = 320;
const MAX_REGIONS = 24;

// ── locals: the parameters, then a fixed layout every region shares
const L_CPU = 0;
const L_ENTRY = 1;
pub const L_X = 2; // x0..x31 (x31 is sp)
pub const L_N = 34;
pub const L_Z = 35;
pub const L_C = 36;
pub const L_V = 37;
pub const L_T0 = 38;
pub const L_T1 = 39;
pub const L_T2 = 40;
pub const L_T3 = 41;
pub const L_A = 42;
pub const L_B = 43;
pub const L_R = 44;
pub const L_NEXT = 45;
pub const L_RET = 46;
pub const L_SC = 47;
pub const L_IC = 48;
pub const L_LIMIT = 49;
// imported functions
const F_EXEC = 0; // exec_word(cpu, word, pc) -> status
const F_TX = 1; // tx_addr(cpu, addr i64) -> i32 (0: fault)
const F_STORE = 2; // on_store(cpu, addr) -> i32 (0 ok)
const F_EXEC32 = 3; // exec_word32(cpu, pc) -> status
const N_IMPORTS = 4;
/// a region function's return: a status below this, else the next pc
pub const STATUS_MAX = 16;

const OFF_X = @offsetOf(Cpu, "x");
const OFF_CPSR = @offsetOf(Cpu, "cpsr");
const OFF_IC = @offsetOf(Cpu, "ic");
const OFF_LIMIT = @offsetOf(Cpu, "ic_limit");
const OFF_BPC = @offsetOf(Cpu, "bpc");
const OFF_EXCL = @offsetOf(Cpu, "excl");
const OFF_V = @offsetOf(Cpu, "v");
const OFF_SLOT = @offsetOf(cpu.Page, "slot");
const FLAGS_BASE = abi.KERN_BASE + 0x10_0000;
/// regions hand off to the next region by tail call (the engine has return_call_indirect)
var chain: bool = false;
export fn jit_config(c: u32) void {
    chain = c != 0;
}

pub const Isa = enum(u8) { a64 = 0, arm = 1, thumb = 2 };
pub const Block = struct { pc: u32, n: u32, taken: i32, fall: i32 };
pub const Region = struct {
    entry: u32,
    page: u32,
    epoch: u32,
    isa: Isa,
    nblocks: u32,
    blocks: [MAX_BLOCKS]Block,
};
var regions: [MAX_REGIONS]Region = undefined;
var nregions: u32 = 0;
var requests: [MAX_REGIONS]u32 = undefined;
var request_isa: [MAX_REGIONS]Isa = undefined;
var nrequests: u32 = 0;
/// a batch handed to the host waits for its install; requests queue behind it
var in_flight: bool = false;
pub var stats = struct { regions: u32 = 0, batches: u32 = 0, skipped: u32 = 0, bytes: u32 = 0 }{};

pub fn request(pc: u32, isa: Isa) void {
    if (nrequests >= MAX_REGIONS) return;
    for (requests[0..nrequests]) |r| if (r == pc) return;
    requests[nrequests] = pc;
    request_isa[nrequests] = isa;
    nrequests += 1;
}
/// debug: instructions in [fb_lo, fb_hi) go to the interpreter (bisects a miscompile within a region)
var fb_lo: u32 = 0;
var fb_hi: u32 = 0;
export fn jit_fallback(lo: u32, hi: u32) void {
    fb_lo = lo;
    fb_hi = hi;
}
export fn jit_pending() u32 {
    return if (in_flight) 0 else nrequests;
}
export fn jit_count() u32 {
    return nregions;
}
export fn jit_entry(i: u32) u32 {
    return regions[i].entry;
}
export fn jit_stat(i: u32) u32 {
    return switch (i) {
        0 => stats.regions,
        1 => stats.batches,
        2 => stats.skipped,
        3 => stats.bytes,
        else => @intFromBool(chain),
    };
}
/// the region's blocks get the slot the host linked it into; a page dropped since emission keeps none
export fn jit_install(i: u32, slot: u32) void {
    const r = &regions[i];
    const page = cpu.decodedPage(r.page) orelse return;
    if (page.epoch != r.epoch) return;
    for (r.blocks[0..r.nblocks], 0..) |b, k| page.slot[(b.pc & (abi.PAGE_SIZE - 1)) >> 1] = (slot << 8) | @as(u32, @intCast(k));
    stats.regions += 1;
}
export fn jit_done() void {
    in_flight = false;
    nregions = 0;
}

// ── region discovery
fn findBlock(r: *Region, pc: u32) i32 {
    for (r.blocks[0..r.nblocks], 0..) |b, i| if (b.pc == pc) return @intCast(i);
    return -1;
}
/// the block index for `pc`, adding it (unfinished) when the region has room
pub fn blockFor(r: *Region, pc: u32) i32 {
    const i = findBlock(r, pc);
    if (i >= 0) return i;
    if (r.nblocks >= MAX_BLOCKS or (pc >> abi.PAGE_SHIFT) != r.page) return -1;
    r.blocks[r.nblocks] = .{ .pc = pc, .n = 0, .taken = -1, .fall = -1 };
    r.nblocks += 1;
    return @intCast(r.nblocks - 1);
}
fn opAt(page: *cpu.Page, pc: u32) *Op {
    const i = (pc & (abi.PAGE_SIZE - 1)) >> 2;
    const o = &page.ops[i];
    if (o.kind == .raw) {
        o.* = a64.decode(mem.ld32(pc), pc);
        page.cov[i >> 3] |= @as(u8, 1) << @intCast(i & 7);
    }
    return o;
}
fn scanA64(r: *Region, i: u32, page: *cpu.Page, pc: u32) jit32.Scan {
    const o = opAt(page, pc);
    const next = pc + 4;
    const ends = switch (o.kind) {
        .b => blk: {
            if (o.a == 0) r.blocks[i].taken = blockFor(r, @truncate(o.imm));
            break :blk true;
        },
        .bcond, .cbz, .tbz => blk: {
            r.blocks[i].taken = blockFor(r, @truncate(o.imm));
            r.blocks[i].fall = if (next & (abi.PAGE_SIZE - 1) != 0) blockFor(r, next) else -1;
            break :blk true;
        },
        .br, .svc, .fault => true,
        else => false,
    };
    return .{ .len = 4, .ends = ends };
}
fn discover(r: *Region, page: *cpu.Page) bool {
    var total: u32 = 0;
    var i: u32 = 0;
    while (i < r.nblocks) : (i += 1) {
        var pc = r.blocks[i].pc;
        var n: u32 = 0;
        while (true) {
            const s = switch (r.isa) {
                .a64 => scanA64(r, i, page, pc),
                .arm => jit32.scanArm(r, i, pc),
                .thumb => jit32.scanThumb(r, i, pc),
            };
            n += 1;
            total += 1;
            const ends = s.ends;
            const next = pc + s.len;
            pc = next;
            if (ends or n >= MAX_INSTR or total >= MAX_INSTR or (pc & (abi.PAGE_SIZE - 1)) == 0) {
                if (!ends) r.blocks[i].fall = if ((pc & (abi.PAGE_SIZE - 1)) != 0 and total < MAX_INSTR) blockFor(r, pc) else -1;
                break;
            }
        }
        r.blocks[i].n = n;
    }
    return r.nblocks > 0;
}

// ── emission
/// the registers an op reads and writes, and whether it reads or writes NZCV
pub const RW = struct { r: u32, w: u32, fr: bool = false, fw: bool = false };
const ALL = RW{ .r = 0xffff_ffff, .w = 0xffff_ffff, .fr = true, .fw = true };
const ALL32 = RW{ .r = 0x7fff, .w = 0x7fff, .fr = true, .fw = true };

pub const Emit = struct {
    b: *Buf,
    r: *Region,
    page: *cpu.Page,
    blk: u32,
    /// every register the region reads or writes (the prologue loads them), every one it
    /// writes (the status exit spills them), and what may have been written on the way to the
    /// op being emitted (all a transfer exit spills)
    used: u32,
    written: u32,
    wcur: u32,
    /// what the op being emitted touches: a fallback spills and reloads only that
    rw: RW,
    /// the depth of the status exit, the hand-off and the loop from the current block body,
    /// and how many if-blocks the emitter is inside at the moment
    exit_depth: u32,
    chain_depth: u32,
    top_depth: u32,
    nest: u32,

    pub fn ifv(e: *Emit) void {
        e.b.blockStart(O.if_, wasm.VOID);
        e.nest += 1;
    }
    pub fn endif(e: *Emit) void {
        e.b.op(O.end);
        e.nest -= 1;
    }

    fn getX(e: *Emit, n: u8) void {
        if (n == 31) e.b.i64c(0) else e.b.get(L_X + n);
    }
    fn getSP(e: *Emit, n: u8) void {
        e.b.get(L_X + n);
    }
    /// pops an i64 into Xn (a zero-register write is dropped)
    fn setX(e: *Emit, n: u8) void {
        if (n == 31) e.b.op(O.drop) else e.b.set(L_X + n);
    }
    fn setSP(e: *Emit, n: u8) void {
        e.b.set(L_X + n);
    }
    /// pops an i32, zero-extends it into Xn
    fn setW(e: *Emit, n: u8) void {
        e.b.op(O.i64_extend_i32_u);
        e.setX(n);
    }
    /// ic += k
    pub fn countIc(e: *Emit, k: u32) void {
        e.b.get(L_IC);
        e.b.i64c(k);
        e.b.op(O.i64_add);
        e.b.set(L_IC);
    }
    fn storeIc(e: *Emit) void {
        e.b.get(L_CPU);
        e.b.get(L_IC);
        e.b.memop(O.i64_store, OFF_IC);
    }
    /// an ARM32 region's registers are the low words, in i32 locals
    fn spillRegs(e: *Emit, mask: u32) void {
        const wide = e.r.isa == .a64;
        var n: u8 = 0;
        while (n < 32) : (n += 1) if (mask & bit(n) != 0) {
            e.b.get(L_CPU);
            e.b.get(L_X + n);
            e.b.memop(if (wide) O.i64_store else O.i32_store, OFF_X + 8 * @as(u32, n));
        };
    }
    fn loadRegs(e: *Emit, mask: u32) void {
        const wide = e.r.isa == .a64;
        var n: u8 = 0;
        while (n < 32) : (n += 1) if (mask & bit(n) != 0) {
            e.b.get(L_CPU);
            e.b.memop(if (wide) O.i64_load else O.i32_load, OFF_X + 8 * @as(u32, n));
            e.b.set(L_X + n);
        };
    }
    fn spillFlags(e: *Emit) void {
        const b = e.b;
        b.get(L_CPU);
        b.get(L_CPU);
        b.memop(O.i32_load, OFF_CPSR);
        b.i32c(0x0fff_ffff);
        b.op(O.i32_and);
        b.get(L_N);
        b.i32c(31);
        b.op(O.i32_shl);
        b.op(O.i32_or);
        b.get(L_Z);
        b.i32c(30);
        b.op(O.i32_shl);
        b.op(O.i32_or);
        b.get(L_C);
        b.i32c(29);
        b.op(O.i32_shl);
        b.op(O.i32_or);
        b.get(L_V);
        b.i32c(28);
        b.op(O.i32_shl);
        b.op(O.i32_or);
        b.memop(O.i32_store, OFF_CPSR);
    }
    fn loadFlags(e: *Emit) void {
        const b = e.b;
        b.get(L_CPU);
        b.memop(O.i32_load, OFF_CPSR);
        b.set(L_A);
        const shifts = [_]u8{ 31, 30, 29, 28 };
        for (shifts, 0..) |s, i| {
            b.get(L_A);
            b.i32c(s);
            b.op(O.i32_shr_u);
            if (s != 31) {
                b.i32c(1);
                b.op(O.i32_and);
            }
            b.set(L_N + @as(u32, @intCast(i)));
        }
    }
    /// leave with a status already in L_RET: the epilogue spills everything the region writes
    pub fn exit(e: *Emit) void {
        e.b.br(e.exit_depth + e.nest);
    }
    /// leave for the pc already in L_RET: what this path may have written is spilled here
    pub fn exitRet(e: *Emit) void {
        e.spillRegs(e.wcur);
        e.spillFlags();
        e.b.br(e.chain_depth + e.nest);
    }
    pub fn exitTo(e: *Emit, pc: u32) void {
        e.b.i32c(@bitCast(pc));
        e.b.set(L_RET);
        e.exitRet();
    }
    pub fn exitStatus(e: *Emit, s: u32) void {
        e.b.i32c(@intCast(s));
        e.b.set(L_RET);
        e.exit();
    }
    /// go to a block of the region, or out to a pc; `k` instructions of the current block ran
    pub fn transfer(e: *Emit, target: i32, pc: u32, k: u32) void {
        e.countIc(k);
        if (target < 0) {
            e.exitTo(pc);
            return;
        }
        // the budget: leave at the boundary, the dispatcher decides
        e.b.get(L_IC);
        e.b.get(L_LIMIT);
        e.b.op(O.i64_ge_s);
        e.ifv();
        e.exitTo(pc);
        e.endif();
        e.b.i32c(target);
        e.b.set(L_NEXT);
        e.b.br(e.top_depth + e.nest);
    }
    /// the interpreter runs this word: what it reads spills first, what it writes reloads after.
    /// What reloads spills too: a register the classifier over-names as written must not come
    /// back stale from memory.
    pub fn fallback(e: *Emit, pc: u32, k: u32) void {
        const b = e.b;
        e.spillRegs(e.rw.r | e.rw.w);
        if (e.rw.fr or e.rw.fw) e.spillFlags();
        b.get(L_CPU);
        if (e.r.isa == .a64) {
            b.i32c(@bitCast(mem.ld32(pc)));
            b.i32c(@bitCast(pc));
            b.call(F_EXEC);
        } else {
            b.i32c(@bitCast(pc));
            b.call(F_EXEC32);
        }
        b.set(L_R);
        // reload first: an exit spills the locals, which must be what the interpreter left
        e.loadRegs(e.rw.w);
        if (e.rw.fw) e.loadFlags();
        b.get(L_R);
        e.ifv();
        e.countIc(k);
        b.get(L_R);
        b.set(L_RET);
        e.exit();
        e.endif();
    }
    /// pops an i64 address; leaves the translated i32 in L_A or exits with a fault
    fn address(e: *Emit) void {
        const b = e.b;
        b.tee(L_T0);
        b.i64c(32);
        b.op(O.i64_shr_u);
        b.op(O.i64_eqz);
        b.blockStart(O.if_, wasm.I32);
        b.get(L_T0);
        b.op(O.i32_wrap_i64);
        b.op(O.else_);
        b.get(L_CPU);
        b.get(L_T0);
        b.call(F_TX);
        b.op(O.end);
        b.tee(L_A);
        b.op(O.i32_eqz);
        e.ifv();
        e.exitStatus(2);
        e.endif();
    }
    /// the page check before a store at L_A (+off)
    pub fn storeCheck(e: *Emit, off: u32) void {
        const b = e.b;
        b.get(L_A);
        b.i32c(@bitCast(off));
        b.op(O.i32_add);
        b.i32c(12);
        b.op(O.i32_shr_u);
        b.memop(O.i32_load8_u, FLAGS_BASE);
        e.ifv();
        b.get(L_CPU);
        b.get(L_A);
        b.i32c(@bitCast(off));
        b.op(O.i32_add);
        b.call(F_STORE);
        e.ifv();
        e.exitStatus(2);
        e.endif();
        e.endif();
    }
    pub fn cond(e: *Emit, cc: u8) void {
        const b = e.b;
        switch (cc >> 1) {
            0 => b.get(L_Z),
            1 => b.get(L_C),
            2 => b.get(L_N),
            3 => b.get(L_V),
            4 => {
                b.get(L_C);
                b.get(L_Z);
                b.op(O.i32_eqz);
                b.op(O.i32_and);
            },
            5 => {
                b.get(L_N);
                b.get(L_V);
                b.op(O.i32_eq);
            },
            6 => {
                b.get(L_Z);
                b.op(O.i32_eqz);
                b.get(L_N);
                b.get(L_V);
                b.op(O.i32_eq);
                b.op(O.i32_and);
            },
            else => {
                b.i32c(1);
                return;
            },
        }
        if (cc & 1 != 0) b.op(O.i32_eqz);
    }
    /// NZCV of a + b + cin (T0 = a, T1 = b, T2 = result already computed; cin in L_R for adc)
    fn flagsAdd64(e: *Emit, carry_in: bool, sub: bool) void {
        const b = e.b;
        b.get(L_T2);
        b.i64c(63);
        b.op(O.i64_shr_u);
        b.op(O.i32_wrap_i64);
        b.set(L_N);
        b.get(L_T2);
        b.op(O.i64_eqz);
        b.set(L_Z);
        if (!carry_in) {
            if (sub) {
                b.get(L_T0);
                b.get(L_T1);
                b.op(O.i64_ge_u);
            } else {
                b.get(L_T2);
                b.get(L_T0);
                b.op(O.i64_lt_u);
            }
        } else {
            // t = a + b; r = t + cin: a carry out of either step
            b.get(L_T0);
            b.get(L_T1);
            b.op(O.i64_add);
            b.tee(L_T3);
            b.get(L_T0);
            b.op(O.i64_lt_u);
            b.get(L_T2);
            b.get(L_T3);
            b.op(O.i64_lt_u);
            b.op(O.i32_or);
        }
        b.set(L_C);
        // overflow: the operands agree in sign and the result does not (a subtraction's operands disagree)
        b.get(L_T0);
        b.get(if (sub) L_T1 else L_T2);
        b.op(O.i64_xor);
        b.get(if (sub) L_T0 else L_T1);
        b.get(L_T2);
        b.op(O.i64_xor);
        b.op(O.i64_and);
        b.i64c(63);
        b.op(O.i64_shr_u);
        b.op(O.i32_wrap_i64);
        b.set(L_V);
    }
    pub fn flagsAdd32(e: *Emit, carry_in: bool, sub: bool) void {
        const b = e.b;
        b.get(L_R);
        b.i32c(31);
        b.op(O.i32_shr_u);
        b.set(L_N);
        b.get(L_R);
        b.op(O.i32_eqz);
        b.set(L_Z);
        if (!carry_in) {
            if (sub) {
                b.get(L_A);
                b.get(L_B);
                b.op(O.i32_ge_u);
            } else {
                b.get(L_R);
                b.get(L_A);
                b.op(O.i32_lt_u);
            }
        } else {
            b.get(L_A);
            b.get(L_B);
            b.op(O.i32_add);
            b.tee(L_NEXT);
            b.get(L_A);
            b.op(O.i32_lt_u);
            b.get(L_R);
            b.get(L_NEXT);
            b.op(O.i32_lt_u);
            b.op(O.i32_or);
        }
        b.set(L_C);
        b.get(L_A);
        b.get(if (sub) L_B else L_R);
        b.op(O.i32_xor);
        b.get(if (sub) L_A else L_B);
        b.get(L_R);
        b.op(O.i32_xor);
        b.op(O.i32_and);
        b.i32c(31);
        b.op(O.i32_shr_u);
        b.set(L_V);
    }
    fn flagsLogic(e: *Emit, sf: bool) void {
        const b = e.b;
        if (sf) {
            b.get(L_T2);
            b.i64c(63);
            b.op(O.i64_shr_u);
            b.op(O.i32_wrap_i64);
            b.set(L_N);
            b.get(L_T2);
            b.op(O.i64_eqz);
            b.set(L_Z);
        } else {
            b.get(L_R);
            b.i32c(31);
            b.op(O.i32_shr_u);
            b.set(L_N);
            b.get(L_R);
            b.op(O.i32_eqz);
            b.set(L_Z);
        }
        b.i32c(0);
        b.set(L_C);
        b.i32c(0);
        b.set(L_V);
    }
    /// the second operand of a register-form op as an i64 on the stack
    fn operand2(e: *Emit, o: *const Op) void {
        const b = e.b;
        const sf = o.a & 4 != 0;
        switch (o.b) {
            0 => b.i64c(@bitCast(o.imm)),
            1 => {
                const amt: u32 = @intCast(o.imm);
                e.getX(o.rm);
                if (!sf) {
                    b.op(O.i32_wrap_i64);
                    if (amt != 0) {
                        b.i32c(@intCast(amt));
                        b.op(switch (o.ra & 3) {
                            0 => O.i32_shl,
                            1 => O.i32_shr_u,
                            2 => O.i32_shr_s,
                            else => O.i32_rotr,
                        });
                    }
                    if (o.ra & 4 != 0) {
                        b.i32c(-1);
                        b.op(O.i32_xor);
                    }
                    b.op(O.i64_extend_i32_u);
                } else {
                    if (amt != 0) {
                        b.i64c(amt);
                        b.op(switch (o.ra & 3) {
                            0 => O.i64_shl,
                            1 => O.i64_shr_u,
                            2 => O.i64_shr_s,
                            else => O.i64_rotr,
                        });
                    }
                    if (o.ra & 4 != 0) {
                        b.i64c(-1);
                        b.op(O.i64_xor);
                    }
                }
            },
            else => {
                e.getX(o.rm);
                switch (o.ra) {
                    0 => {
                        b.i64c(255);
                        b.op(O.i64_and);
                    },
                    1 => {
                        b.i64c(65535);
                        b.op(O.i64_and);
                    },
                    2 => {
                        b.i64c(0xffff_ffff);
                        b.op(O.i64_and);
                    },
                    4 => b.op(O.i64_extend8_s),
                    5 => b.op(O.i64_extend16_s),
                    6 => b.op(O.i64_extend32_s),
                    else => {},
                }
                if (o.imm != 0) {
                    b.i64c(@intCast(o.imm));
                    b.op(O.i64_shl);
                }
            },
        }
    }

    /// emit one op; true when it ended the block (a transfer was emitted)
    fn emitOp(e: *Emit, o: *const Op, pc: u32, k: u32) bool {
        const b = e.b;
        switch (o.kind) {
            .nop => {},
            .adr => {
                b.i64c(@bitCast(o.imm));
                e.setX(o.rd);
            },
            .addsub => {
                const sub = o.a & 1 != 0;
                const S = o.a & 2 != 0;
                const sf = o.a & 4 != 0;
                if (o.b == 1) e.getX(o.rn) else e.getSP(o.rn);
                if (sf) {
                    b.set(L_T0);
                    e.operand2(o);
                    b.set(L_T1);
                    b.get(L_T0);
                    b.get(L_T1);
                    b.op(if (sub) O.i64_sub else O.i64_add);
                    b.tee(L_T2);
                    if (S) {
                        e.flagsAdd64(false, sub);
                        e.setX(o.rd);
                    } else e.setSP(o.rd);
                } else {
                    b.op(O.i32_wrap_i64);
                    b.set(L_A);
                    e.operand2(o);
                    b.op(O.i32_wrap_i64);
                    b.set(L_B);
                    b.get(L_A);
                    b.get(L_B);
                    b.op(if (sub) O.i32_sub else O.i32_add);
                    b.tee(L_R);
                    if (S) {
                        e.flagsAdd32(false, sub);
                        e.setW(o.rd);
                    } else {
                        b.op(O.i64_extend_i32_u);
                        e.setSP(o.rd);
                    }
                }
            },
            .logic => {
                const opc = o.a & 3;
                const sf = o.a & 4 != 0;
                e.getX(o.rn);
                e.operand2(o);
                b.op(switch (opc) {
                    0, 3 => O.i64_and,
                    1 => O.i64_or,
                    else => O.i64_xor,
                });
                if (!sf) {
                    b.op(O.i32_wrap_i64);
                    b.tee(L_R);
                    b.op(O.i64_extend_i32_u);
                } else b.tee(L_T2);
                if (opc == 3) {
                    e.flagsLogic(sf);
                    e.setX(o.rd);
                } else if (o.a & 8 != 0) e.setX(o.rd) else e.setSP(o.rd);
            },
            .movw => {
                const sf = o.a & 4 != 0;
                const sh: u6 = @intCast(o.b);
                const val = o.imm << sh;
                switch (o.a & 3) {
                    0 => b.i64c(@bitCast(if (sf) ~val else ~val & 0xffff_ffff)),
                    2 => b.i64c(@bitCast(val)),
                    else => {
                        e.getX(o.rd);
                        b.i64c(@bitCast(~(@as(u64, 0xffff) << sh) & (if (sf) ~@as(u64, 0) else 0xffff_ffff)));
                        b.op(O.i64_and);
                        b.i64c(@bitCast(val));
                        b.op(O.i64_or);
                    },
                }
                e.setX(o.rd);
            },
            .bfm => {
                const opc = o.a & 3;
                const sf = o.a & 4 != 0;
                const width: u32 = if (sf) 64 else 32;
                const rot: u32 = o.b;
                const wmask = o.imm;
                const tmask = a64.replicate(ones(o.rm), @as(u32, 1) << @intCast(o.a >> 3), width);
                // src, rotated right by immr within the width
                e.getX(o.rn);
                if (!sf) {
                    b.op(O.i32_wrap_i64);
                    if (rot != 0) {
                        b.i32c(@intCast(rot));
                        b.op(O.i32_rotr);
                    }
                    b.op(O.i64_extend_i32_u);
                } else if (rot != 0) {
                    b.i64c(rot);
                    b.op(O.i64_rotr);
                }
                b.i64c(@bitCast(wmask));
                b.op(O.i64_and);
                if (opc == 1) {
                    e.getX(o.rd);
                    b.i64c(@bitCast(~wmask));
                    b.op(O.i64_and);
                    b.op(O.i64_or);
                }
                b.i64c(@bitCast(tmask));
                b.op(O.i64_and);
                b.set(L_T2);
                // the top: the sign bit replicated (SBFM), the destination (BFM), or zero
                if (opc == 0) {
                    e.getX(o.rn);
                    b.i64c(63 - @as(i64, o.ra));
                    b.op(O.i64_shl);
                    b.i64c(63);
                    b.op(O.i64_shr_s);
                    b.i64c(@bitCast(~tmask));
                    b.op(O.i64_and);
                    b.get(L_T2);
                    b.op(O.i64_or);
                } else if (opc == 1) {
                    e.getX(o.rd);
                    b.i64c(@bitCast(~tmask));
                    b.op(O.i64_and);
                    b.get(L_T2);
                    b.op(O.i64_or);
                } else b.get(L_T2);
                if (!sf) {
                    b.i64c(0xffff_ffff);
                    b.op(O.i64_and);
                }
                e.setX(o.rd);
            },
            .extr => {
                const lsb: u32 = o.b;
                if (o.a != 0) {
                    e.getX(o.rm);
                    if (lsb != 0) {
                        b.i64c(lsb);
                        b.op(O.i64_shr_u);
                        e.getX(o.rn);
                        b.i64c(64 - @as(i64, lsb));
                        b.op(O.i64_shl);
                        b.op(O.i64_or);
                    }
                    e.setX(o.rd);
                } else {
                    e.getX(o.rm);
                    b.op(O.i32_wrap_i64);
                    if (lsb != 0) {
                        b.i32c(@intCast(lsb));
                        b.op(O.i32_shr_u);
                        e.getX(o.rn);
                        b.op(O.i32_wrap_i64);
                        b.i32c(32 - @as(i32, @intCast(lsb)));
                        b.op(O.i32_shl);
                        b.op(O.i32_or);
                    }
                    e.setW(o.rd);
                }
            },
            .b => {
                if (o.a != 0) {
                    b.i64c(pc + 4);
                    e.setX(30);
                    e.transfer(-1, @truncate(o.imm), k);
                } else e.transfer(e.r.blocks[e.blk].taken, @truncate(o.imm), k);
                return true;
            },
            .bcond, .cbz, .tbz => {
                switch (o.kind) {
                    .bcond => e.cond(o.a),
                    .cbz => {
                        e.getX(o.rd);
                        if (o.a & 1 == 0) b.op(O.i32_wrap_i64);
                        b.op(if (o.a & 1 == 0) O.i32_eqz else O.i64_eqz);
                        if (o.a & 2 != 0) b.op(O.i32_eqz);
                    },
                    else => {
                        e.getX(o.rd);
                        b.i64c(o.b);
                        b.op(O.i64_shr_u);
                        b.op(O.i32_wrap_i64);
                        b.i32c(1);
                        b.op(O.i32_and);
                        if (o.a == 0) b.op(O.i32_eqz);
                    },
                }
                e.ifv();
                e.transfer(e.r.blocks[e.blk].taken, @truncate(o.imm), k);
                e.endif();
                e.transfer(e.r.blocks[e.blk].fall, pc + 4, k);
                return true;
            },
            .br => {
                e.getX(o.rn);
                b.op(O.i32_wrap_i64);
                b.set(L_RET);
                if (o.a == 1) {
                    b.i64c(pc + 4);
                    e.setX(30);
                }
                e.countIc(k);
                e.exitRet();
                return true;
            },
            .ldrlit => {
                const a: u32 = @truncate(o.imm);
                switch (o.b) {
                    0 => {
                        b.i32c(0);
                        b.memop(O.i64_load32_u, a);
                        e.setX(o.rd);
                    },
                    1 => {
                        b.i32c(0);
                        b.memop(O.i64_load, a);
                        e.setX(o.rd);
                    },
                    2 => {
                        b.i32c(0);
                        b.memop(O.i64_load32_s, a);
                        e.setX(o.rd);
                    },
                    else => {},
                }
            },
            .ldp => {
                const kind = o.a & 3;
                const Ld = o.a & 4 != 0;
                const opc = o.a >> 3;
                e.getSP(o.rn);
                if (kind != 1 and o.imm != 0) {
                    b.i64c(@bitCast(o.imm));
                    b.op(O.i64_add);
                }
                e.address();
                if (kind == 1 or kind == 3) {
                    e.getSP(o.rn);
                    b.i64c(@bitCast(o.imm));
                    b.op(O.i64_add);
                    e.setSP(o.rn);
                }
                const step: u32 = if (opc == 2) 8 else 4;
                const regs = [_]u8{ o.rd, o.rm };
                if (Ld) {
                    for (regs, 0..) |t, i| {
                        b.get(L_A);
                        b.memop(if (opc == 2) O.i64_load else if (opc == 1) O.i64_load32_s else O.i64_load32_u, step * @as(u32, @intCast(i)));
                        e.setX(t);
                    }
                } else {
                    for (regs, 0..) |t, i| {
                        e.storeCheck(step * @as(u32, @intCast(i)));
                        b.get(L_A);
                        e.getX(t);
                        b.memop(if (opc == 2) O.i64_store else O.i64_store32, step * @as(u32, @intCast(i)));
                    }
                }
            },
            .ldst => {
                const size: u5 = @intCast(o.b >> 2);
                const opc = o.b & 3;
                e.getSP(o.rn);
                switch (o.a) {
                    0, 2 => if (o.imm != 0) {
                        b.i64c(@bitCast(o.imm));
                        b.op(O.i64_add);
                    },
                    3 => {
                        e.getX(o.rm);
                        switch (o.ra >> 1) {
                            2 => {
                                b.i64c(0xffff_ffff);
                                b.op(O.i64_and);
                            },
                            6 => b.op(O.i64_extend32_s),
                            else => {},
                        }
                        if (o.ra & 1 != 0 and size != 0) {
                            b.i64c(size);
                            b.op(O.i64_shl);
                        }
                        b.op(O.i64_add);
                    },
                    else => {},
                }
                if (o.a == 2) {
                    b.tee(L_T0);
                    e.setSP(o.rn);
                    b.get(L_T0);
                }
                e.address();
                if (o.a == 1) {
                    e.getSP(o.rn);
                    b.i64c(@bitCast(o.imm));
                    b.op(O.i64_add);
                    e.setSP(o.rn);
                }
                const load = opc != 0 and !(size == 3 and opc == 2);
                if (!load) {
                    e.storeCheck(0);
                    b.get(L_A);
                    e.getX(o.rd);
                    b.memop(switch (size) {
                        0 => O.i64_store8,
                        1 => O.i64_store16,
                        2 => O.i64_store32,
                        else => O.i64_store,
                    }, 0);
                } else {
                    b.get(L_A);
                    if (size == 3) {
                        b.memop(O.i64_load, 0);
                    } else if (opc == 1) {
                        b.memop(switch (size) {
                            0 => O.i64_load8_u,
                            1 => O.i64_load16_u,
                            else => O.i64_load32_u,
                        }, 0);
                    } else {
                        b.memop(switch (size) {
                            0 => O.i64_load8_s,
                            1 => O.i64_load16_s,
                            else => O.i64_load32_s,
                        }, 0);
                        if (opc == 3) {
                            b.i64c(0xffff_ffff);
                            b.op(O.i64_and);
                        }
                    }
                    e.setX(o.rd);
                }
            },
            .adc => {
                const sub = o.a & 1 != 0;
                const S = o.a & 2 != 0;
                if (o.a & 4 != 0) {
                    e.getX(o.rn);
                    b.set(L_T0);
                    e.getX(o.rm);
                    if (sub) {
                        b.i64c(-1);
                        b.op(O.i64_xor);
                    }
                    b.set(L_T1);
                    b.get(L_T0);
                    b.get(L_T1);
                    b.op(O.i64_add);
                    b.get(L_C);
                    b.op(O.i64_extend_i32_u);
                    b.op(O.i64_add);
                    b.tee(L_T2);
                    if (S) e.flagsAdd64(true, false);
                    e.setX(o.rd);
                } else {
                    e.getX(o.rn);
                    b.op(O.i32_wrap_i64);
                    b.set(L_A);
                    e.getX(o.rm);
                    b.op(O.i32_wrap_i64);
                    if (sub) {
                        b.i32c(-1);
                        b.op(O.i32_xor);
                    }
                    b.set(L_B);
                    b.get(L_A);
                    b.get(L_B);
                    b.op(O.i32_add);
                    b.get(L_C);
                    b.op(O.i32_add);
                    b.tee(L_R);
                    if (S) e.flagsAdd32(true, false);
                    e.setW(o.rd);
                }
            },
            .ccmp => {
                const sub = o.a & 1 != 0;
                const sf = o.a & 4 != 0;
                e.cond(o.b);
                b.blockStart(O.if_, wasm.VOID);
                if (sf) {
                    e.getX(o.rn);
                    b.set(L_T0);
                    if (o.a & 8 != 0) b.i64c(@bitCast(o.imm)) else e.getX(o.rm);
                    b.set(L_T1);
                    b.get(L_T0);
                    b.get(L_T1);
                    b.op(if (sub) O.i64_sub else O.i64_add);
                    b.set(L_T2);
                    e.flagsAdd64(false, sub);
                } else {
                    e.getX(o.rn);
                    b.op(O.i32_wrap_i64);
                    b.set(L_A);
                    if (o.a & 8 != 0) b.i32c(@intCast(o.imm)) else {
                        e.getX(o.rm);
                        b.op(O.i32_wrap_i64);
                    }
                    b.set(L_B);
                    b.get(L_A);
                    b.get(L_B);
                    b.op(if (sub) O.i32_sub else O.i32_add);
                    b.set(L_R);
                    e.flagsAdd32(false, sub);
                }
                b.op(O.else_);
                b.i32c((o.ra >> 3) & 1);
                b.set(L_N);
                b.i32c((o.ra >> 2) & 1);
                b.set(L_Z);
                b.i32c((o.ra >> 1) & 1);
                b.set(L_C);
                b.i32c(o.ra & 1);
                b.set(L_V);
                b.op(O.end);
            },
            .csel => {
                const opc = o.a & 1;
                const op2 = (o.a >> 1) & 1;
                const sf = o.a & 4 != 0;
                e.getX(o.rn);
                e.getX(o.rm);
                if (opc == 0 and op2 == 1) {
                    b.i64c(1);
                    b.op(O.i64_add);
                } else if (opc == 1 and op2 == 0) {
                    b.i64c(-1);
                    b.op(O.i64_xor);
                } else if (opc == 1) {
                    b.set(L_T0);
                    b.i64c(0);
                    b.get(L_T0);
                    b.op(O.i64_sub);
                }
                e.cond(o.b);
                b.op(O.select);
                if (!sf) {
                    b.i64c(0xffff_ffff);
                    b.op(O.i64_and);
                }
                e.setX(o.rd);
            },
            .one => {
                const opc = o.a & 7;
                const sf = o.a & 8 != 0;
                if (opc == 4) {
                    e.getX(o.rn);
                    if (sf) {
                        b.op(O.i64_clz);
                        e.setX(o.rd);
                    } else {
                        b.op(O.i32_wrap_i64);
                        b.op(O.i32_clz);
                        e.setW(o.rd);
                    }
                } else {
                    e.fallback(pc, k);
                }
            },
            .two => {
                const opc = o.a & 63;
                const sf = o.a & 64 != 0;
                if (opc == 2 or opc == 3) {
                    // a zero divisor gives zero; INT_MIN / -1 gives INT_MIN, which wasm's division traps on
                    e.getX(o.rn);
                    e.getX(o.rm);
                    if (sf) {
                        b.set(L_T1);
                        b.set(L_T0);
                        b.get(L_T1);
                        b.op(O.i64_eqz);
                        b.blockStart(O.if_, wasm.I64);
                        b.i64c(0);
                        b.op(O.else_);
                        if (opc == 3) {
                            b.get(L_T1);
                            b.i64c(-1);
                            b.op(O.i64_eq);
                            b.blockStart(O.if_, wasm.I64);
                            b.i64c(0);
                            b.get(L_T0);
                            b.op(O.i64_sub);
                            b.op(O.else_);
                            b.get(L_T0);
                            b.get(L_T1);
                            b.op(O.i64_div_s);
                            b.op(O.end);
                        } else {
                            b.get(L_T0);
                            b.get(L_T1);
                            b.op(O.i64_div_u);
                        }
                        b.op(O.end);
                        e.setX(o.rd);
                    } else {
                        b.op(O.i32_wrap_i64);
                        b.set(L_B);
                        b.op(O.i32_wrap_i64);
                        b.set(L_A);
                        b.get(L_B);
                        b.op(O.i32_eqz);
                        b.blockStart(O.if_, wasm.I32);
                        b.i32c(0);
                        b.op(O.else_);
                        if (opc == 3) {
                            b.get(L_B);
                            b.i32c(-1);
                            b.op(O.i32_eq);
                            b.blockStart(O.if_, wasm.I32);
                            b.i32c(0);
                            b.get(L_A);
                            b.op(O.i32_sub);
                            b.op(O.else_);
                            b.get(L_A);
                            b.get(L_B);
                            b.op(O.i32_div_s);
                            b.op(O.end);
                        } else {
                            b.get(L_A);
                            b.get(L_B);
                            b.op(O.i32_div_u);
                        }
                        b.op(O.end);
                        e.setW(o.rd);
                    }
                } else {
                    const kind = opc - 8;
                    e.getX(o.rn);
                    if (sf) {
                        e.getX(o.rm);
                        b.op(switch (kind) {
                            0 => O.i64_shl,
                            1 => O.i64_shr_u,
                            2 => O.i64_shr_s,
                            else => O.i64_rotr,
                        });
                        e.setX(o.rd);
                    } else {
                        b.op(O.i32_wrap_i64);
                        e.getX(o.rm);
                        b.op(O.i32_wrap_i64);
                        b.op(switch (kind) {
                            0 => O.i32_shl,
                            1 => O.i32_shr_u,
                            2 => O.i32_shr_s,
                            else => O.i32_rotr,
                        });
                        e.setW(o.rd);
                    }
                }
            },
            .three => {
                const op31 = o.a & 7;
                const o0 = o.a & 8 != 0;
                const sf = o.a & 16 != 0;
                if (op31 == 0) {
                    e.getX(o.ra);
                    e.getX(o.rn);
                    e.getX(o.rm);
                    b.op(O.i64_mul);
                    b.op(if (o0) O.i64_sub else O.i64_add);
                    if (!sf) {
                        b.i64c(0xffff_ffff);
                        b.op(O.i64_and);
                    }
                    e.setX(o.rd);
                } else if (op31 == 1 or op31 == 5) {
                    e.getX(o.ra);
                    e.getX(o.rn);
                    b.op(O.i32_wrap_i64);
                    b.op(if (op31 == 1) O.i64_extend_i32_s else O.i64_extend_i32_u);
                    e.getX(o.rm);
                    b.op(O.i32_wrap_i64);
                    b.op(if (op31 == 1) O.i64_extend_i32_s else O.i64_extend_i32_u);
                    b.op(O.i64_mul);
                    b.op(if (o0) O.i64_sub else O.i64_add);
                    e.setX(o.rd);
                } else e.fallback(pc, k);
            },
            else => e.fallback(pc, k),
        }
        return false;
    }
};
inline fn ones(k: u32) u64 {
    return if (k >= 64) ~@as(u64, 0) else (@as(u64, 1) << @intCast(k)) - 1;
}

/// what an op reads and writes; an op the interpreter runs names what it may touch, and the
/// kinds that can touch anything say so
fn rwOf(o: *const Op) RW {
    return switch (o.kind) {
        .nop, .clrex, .fault, .vldrlit => .{ .r = 0, .w = 0 },
        .bcond => .{ .r = 0, .w = 0, .fr = true },
        .adr, .ldrlit => .{ .r = 0, .w = bit(o.rd) },
        .movw => .{ .r = if (o.a & 3 == 3) bit(o.rd) else 0, .w = bit(o.rd) },
        .cbz, .tbz => .{ .r = bit(o.rd), .w = 0 },
        .b => .{ .r = 0, .w = if (o.a != 0) bit(30) else 0 },
        .br => .{ .r = bit(o.rn), .w = if (o.a == 1) bit(30) else 0 },
        .ldp => blk: {
            const wb: u32 = if (o.a & 1 != 0) bit(o.rn) else 0;
            const pair = bit(o.rd) | bit(o.rm);
            break :blk if (o.a & 4 != 0) .{ .r = bit(o.rn), .w = pair | wb } else .{ .r = bit(o.rn) | pair, .w = wb };
        },
        .ldst => blk: {
            const load = o.b & 3 != 0 and !(o.b >> 2 == 3 and o.b & 3 == 2);
            const wb: u32 = if (o.a == 1 or o.a == 2) bit(o.rn) else 0;
            const base = bit(o.rn) | (if (o.a == 3) bit(o.rm) else 0);
            break :blk if (load) .{ .r = base, .w = bit(o.rd) | wb } else .{ .r = base | bit(o.rd), .w = wb };
        },
        .addsub => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd), .fw = o.a & 2 != 0 },
        .logic => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd), .fw = o.a & 3 == 3 },
        .bfm => .{ .r = bit(o.rn) | (if (o.a & 3 == 1) bit(o.rd) else 0), .w = bit(o.rd) },
        .extr, .two => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd) },
        .one => .{ .r = bit(o.rn), .w = bit(o.rd) },
        .three => .{ .r = bit(o.rn) | bit(o.rm) | bit(o.ra), .w = bit(o.rd) },
        .adc => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd), .fr = true, .fw = o.a & 2 != 0 },
        .ccmp => .{ .r = bit(o.rn) | bit(o.rm), .w = 0, .fr = true, .fw = true },
        .csel => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd), .fr = true },
        .excl => blk: {
            const m = bit(o.rd) | bit(o.rd + 1) | bit(o.rn) | bit(o.rm) | bit(o.rm + 1) | bit(o.ra);
            break :blk .{ .r = m, .w = m };
        },
        .atomic => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd) },
        .mrs => .{ .r = 0, .w = bit(o.rd), .fr = o.imm == 0x5a10 },
        .msr => .{ .r = bit(o.rd), .w = 0, .fw = o.imm == 0x5a10 },
        .vmem => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rn) },
        .simd => simdRw(@truncate(o.imm)),
        .svc, .raw => ALL,
    };
}
/// the SIMD&FP space touches a general register only through the conversions, the general
/// moves and the general-register lane copies, and NZCV only through the compares and selects
fn simdRw(w: u32) RW {
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast((w >> 5) & 31);
    if (w & 0x5f00_0000 == 0x1e00_0000) {
        // the fixed-point and integer conversions: SCVTF/UCVTF (opcode 2, 3) and FMOV to a V
        // register (7) read the general register, the rest write it
        if (w & 0x5f20_0000 == 0x1e00_0000 or w & 0x5f20_fc00 == 0x1e20_0000) {
            const opcode = (w >> 16) & 7;
            return if (opcode == 2 or opcode == 3 or opcode == 7) .{ .r = bit(rn), .w = 0 } else .{ .r = 0, .w = bit(rd) };
        }
        if (w & 0x5f20_3c00 == 0x1e20_2000) return .{ .r = 0, .w = 0, .fw = true };
        if (w & 0x5f20_0c00 == 0x1e20_0400) return .{ .r = 0, .w = 0, .fr = true, .fw = true };
        if (w & 0x5f20_0c00 == 0x1e20_0c00) return .{ .r = 0, .w = 0, .fr = true };
        return .{ .r = 0, .w = 0 };
    }
    // DUP and INS from a general register read it; SMOV and UMOV write one
    if (w & 0x9fe0_8400 == 0x0e00_0400 and w & 0x800 != 0) return if (w & 0x2000 != 0) .{ .r = 0, .w = bit(rd) } else .{ .r = bit(rn), .w = 0 };
    return .{ .r = 0, .w = 0 };
}
inline fn bit(n: u8) u32 {
    return @as(u32, 1) << @intCast(n & 31);
}

/// emit the region's function body into `b`
fn emitRegion(b: *Buf, r: *Region, page: *cpu.Page) void {
    const wide = r.isa == .a64;
    var e = Emit{ .b = b, .r = r, .page = page, .blk = 0, .used = 0, .written = 0, .wcur = 0, .rw = if (wide) ALL else ALL32, .exit_depth = 0, .chain_depth = 0, .top_depth = 0, .nest = 0 };
    const n = r.nblocks;
    // what each block writes, and what may have been written before it is entered: the union
    // over its predecessors, to a fixed point (an entry from the dispatcher has written nothing)
    var W: [MAX_BLOCKS]u32 = undefined;
    var wb: [MAX_BLOCKS]u32 = undefined;
    if (wide) {
        for (r.blocks[0..n], 0..) |blk, i| {
            W[i] = 0;
            wb[i] = 0;
            var pc = blk.pc;
            var j: u32 = 0;
            while (j < blk.n) : (j += 1) {
                const rw = rwOf(&page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2]);
                W[i] |= rw.w;
                e.used |= rw.r | rw.w;
                pc += 4;
            }
            e.written |= W[i];
        }
        var changed = true;
        while (changed) {
            changed = false;
            for (r.blocks[0..n], 0..) |blk, i| {
                const out = wb[i] | W[i];
                for ([_]i32{ blk.taken, blk.fall }) |t| if (t >= 0) {
                    const j: usize = @intCast(t);
                    if (wb[j] | out != wb[j]) {
                        wb[j] |= out;
                        changed = true;
                    }
                };
            }
        }
    } else {
        e.used = 0x7fff;
        e.written = 0x7fff;
        @memset(wb[0..n], 0x7fff);
    }
    // locals: 32 registers, 4 i32 flags, 4 i64 temps, 6 i32 temps, ic and its limit
    b.u(5);
    b.u(32);
    b.byte(if (wide) wasm.I64 else wasm.I32);
    b.u(4);
    b.byte(wasm.I32);
    b.u(4);
    b.byte(wasm.I64);
    b.u(6);
    b.byte(wasm.I32);
    b.u(2);
    b.byte(wasm.I64);
    e.loadRegs(e.used);
    e.loadFlags();
    b.get(L_CPU);
    b.memop(O.i64_load, OFF_IC);
    b.set(L_IC);
    b.get(L_CPU);
    b.memop(O.i64_load, OFF_LIMIT);
    b.set(L_LIMIT);
    b.get(L_ENTRY);
    b.set(L_NEXT);
    b.blockStart(O.block, wasm.VOID); // exit: a status
    b.blockStart(O.block, wasm.VOID); // chain: a pc
    b.blockStart(O.loop, wasm.VOID); // top
    var i: u32 = n;
    while (i > 0) : (i -= 1) b.blockStart(O.block, wasm.VOID);
    b.get(L_NEXT);
    b.op(O.br_table);
    b.u(n);
    i = 0;
    while (i < n) : (i += 1) b.u(i);
    b.u(0);
    i = 0;
    while (i < n) : (i += 1) {
        b.op(O.end); // block i's label: its body follows
        e.blk = i;
        e.top_depth = n - 1 - i;
        e.chain_depth = n - i;
        e.exit_depth = n - i + 1;
        e.wcur = wb[i];
        const blk = r.blocks[i];
        b.get(L_CPU);
        b.i32c(@bitCast(blk.pc));
        b.memop(O.i32_store, OFF_BPC);
        var pc = blk.pc;
        var j: u32 = 0;
        var ended = false;
        while (j < blk.n) : (j += 1) {
            const len: u32 = if (r.isa == .thumb and (mem.ptr(u16, pc).* & 0xf800) != 0xf000) 2 else 4;
            const o = &page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2];
            if (wide) {
                e.rw = rwOf(o);
                e.wcur |= e.rw.w;
            }
            if (pc -% fb_lo < fb_hi -% fb_lo) {
                e.fallback(pc, j + 1);
                ended = false;
            } else switch (r.isa) {
                .a64 => ended = e.emitOp(o, pc, j + 1),
                .arm => ended = jit32.emitArm(&e, pc, j + 1),
                .thumb => ended = jit32.emitThumb(&e, pc, j + 1),
            }
            pc += len;
            if (ended) break;
        }
        if (!ended) e.transfer(blk.fall, if (r.isa == .thumb) pc | 1 else pc, blk.n);
    }
    b.op(O.end); // loop
    b.op(O.end); // chain
    e.storeIc();
    if (chain) chainTo(&e);
    b.get(L_RET);
    b.op(O.return_);
    b.op(O.end); // exit
    e.spillRegs(e.written);
    e.spillFlags();
    e.storeIc();
    b.get(L_RET);
    b.op(O.end); // function
}
/// the epilogue's hand-off: a pc in L_RET whose block has a region, within the budget, is entered
/// by tail call; anything else returns to the dispatcher
fn chainTo(e: *Emit) void {
    const b = e.b;
    b.blockStart(O.block, wasm.VOID);
    b.get(L_RET);
    b.i32c(STATUS_MAX);
    b.op(O.i32_lt_u);
    b.brIf(0);
    b.get(L_IC);
    b.get(L_LIMIT);
    b.op(O.i64_ge_s);
    b.brIf(0);
    b.get(L_RET);
    b.i32c(abi.PAGE_SHIFT - 2);
    b.op(O.i32_shr_u);
    b.i32c(-4);
    b.op(O.i32_and);
    b.memop(O.i32_load, cpu.DECODED);
    b.tee(L_A);
    b.op(O.i32_eqz);
    b.brIf(0);
    b.get(L_A);
    b.get(L_RET);
    b.i32c(if (e.r.isa == .a64) abi.PAGE_SIZE - 1 else abi.PAGE_SIZE - 2);
    b.op(O.i32_and);
    b.i32c(1);
    b.op(O.i32_shl);
    b.op(O.i32_add);
    b.memop(O.i32_load, OFF_SLOT);
    b.tee(L_B);
    b.op(O.i32_eqz);
    b.brIf(0);
    if (e.r.isa != .a64) {
        // the interworking target's T bit, as the dispatcher's bx would set it
        b.get(L_CPU);
        b.get(L_CPU);
        b.memop(O.i32_load, OFF_CPSR);
        b.i32c(~@as(i32, 1 << 5));
        b.op(O.i32_and);
        b.get(L_RET);
        b.i32c(1);
        b.op(O.i32_and);
        b.i32c(5);
        b.op(O.i32_shl);
        b.op(O.i32_or);
        b.memop(O.i32_store, OFF_CPSR);
    }
    b.get(L_CPU);
    b.get(L_B);
    b.i32c(255);
    b.op(O.i32_and);
    b.get(L_B);
    b.i32c(8);
    b.op(O.i32_shr_u);
    b.op(O.return_call_indirect);
    b.u(0);
    b.u(0);
    b.op(O.end);
}

/// build one module holding a function per pending request; returns the byte length
export fn jit_emit(out: u32, cap: u32) u32 {
    if (in_flight) return 0;
    var b = Buf.init(out, cap);
    nregions = 0;
    // discover first: a request whose page has gone, or that yields nothing, is dropped
    var q: u32 = 0;
    while (q < nrequests) : (q += 1) {
        const pc = requests[q];
        const page = cpu.decodedPage(pc >> abi.PAGE_SHIFT) orelse continue;
        const r = &regions[nregions];
        r.* = .{ .entry = pc, .page = pc >> abi.PAGE_SHIFT, .epoch = page.epoch, .isa = request_isa[q], .nblocks = 0, .blocks = undefined };
        _ = blockFor(r, pc);
        if (discover(r, page)) nregions += 1;
    }
    nrequests = 0;
    if (nregions == 0) return 0;
    b.bytes(&[_]u8{ 0, 'a', 's', 'm', 1, 0, 0, 0 });
    // type section: 0 (i32,i32)->i32 region, 1 (i32,i32,i32)->i32 exec, 2 (i32,i64)->i32 tx, 3 (i32,i32)->i32 store
    b.byte(1);
    const type_len = b.reserve();
    const type_start = b.len;
    b.u(3);
    b.bytes(&[_]u8{ 0x60, 2, wasm.I32, wasm.I32, 1, wasm.I32 });
    b.bytes(&[_]u8{ 0x60, 3, wasm.I32, wasm.I32, wasm.I32, 1, wasm.I32 });
    b.bytes(&[_]u8{ 0x60, 2, wasm.I32, wasm.I64, 1, wasm.I32 });
    b.patch(type_len, b.len - type_start);
    // import section: memory, the core's table (for the hand-off), exec, tx, store, exec32
    b.byte(2);
    const imp_len = b.reserve();
    const imp_start = b.len;
    b.u(6);
    importName(&b, "memory");
    b.bytes(&[_]u8{ 0x02, 0x00, 1 });
    importName(&b, "__indirect_function_table");
    b.bytes(&[_]u8{ 0x01, 0x70, 0x00, 0 });
    importName(&b, "exec");
    b.bytes(&[_]u8{ 0x00, 1 });
    importName(&b, "tx");
    b.bytes(&[_]u8{ 0x00, 2 });
    importName(&b, "store");
    b.bytes(&[_]u8{ 0x00, 0 });
    importName(&b, "exec32");
    b.bytes(&[_]u8{ 0x00, 0 });
    b.patch(imp_len, b.len - imp_start);
    // function section
    b.byte(3);
    b.u(1 + nregions);
    b.u(nregions);
    var i: u32 = 0;
    while (i < nregions) : (i += 1) b.u(0);
    // export section: r0..rN
    b.byte(7);
    const exp_len = b.reserve();
    const exp_start = b.len;
    b.u(nregions);
    i = 0;
    while (i < nregions) : (i += 1) {
        var name: [8]u8 = undefined;
        var len: u32 = 0;
        name[0] = 'r';
        len = 1;
        var v = i;
        var digits: [8]u8 = undefined;
        var nd: u32 = 0;
        if (v == 0) {
            digits[0] = '0';
            nd = 1;
        }
        while (v > 0) : (v /= 10) {
            digits[nd] = @intCast('0' + v % 10);
            nd += 1;
        }
        while (nd > 0) : (nd -= 1) {
            name[len] = digits[nd - 1];
            len += 1;
        }
        b.u(len);
        b.bytes(name[0..len]);
        b.byte(0x00);
        b.u(N_IMPORTS + i);
    }
    b.patch(exp_len, b.len - exp_start);
    // code section
    b.byte(10);
    const code_len = b.reserve();
    const code_start = b.len;
    b.u(nregions);
    i = 0;
    while (i < nregions) : (i += 1) {
        const body_len = b.reserve();
        const body_start = b.len;
        const r = &regions[i];
        const page = cpu.decodedPage(r.page) orelse unreachable;
        emitRegion(&b, r, page);
        b.patch(body_len, b.len - body_start);
    }
    b.patch(code_len, b.len - code_start);
    if (b.overflow) {
        stats.skipped += nregions;
        nregions = 0;
        return 0;
    }
    in_flight = true;
    stats.batches += 1;
    stats.bytes += b.len;
    return b.len;
}
fn importName(b: *Buf, name: []const u8) void {
    b.u(3);
    b.bytes("env");
    b.u(@intCast(name.len));
    b.bytes(name);
}
