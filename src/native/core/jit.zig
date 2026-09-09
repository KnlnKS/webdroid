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
const L_X = 2; // x0..x31 (x31 is sp)
const L_N = 34;
const L_Z = 35;
const L_C = 36;
const L_V = 37;
const L_T0 = 38;
const L_T1 = 39;
const L_T2 = 40;
const L_T3 = 41;
const L_A = 42;
const L_B = 43;
const L_R = 44;
const L_NEXT = 45;
const L_RET = 46;
// imported functions
const F_EXEC = 0; // exec_word(cpu, word, pc) -> status
const F_TX = 1; // tx_addr(cpu, addr i64) -> i32 (0: fault)
const F_STORE = 2; // on_store(cpu, addr) -> i32 (0 ok)
const N_IMPORTS = 3;
/// a region function's return: a status below this, else the next pc
pub const STATUS_MAX = 16;

const OFF_X = @offsetOf(Cpu, "x");
const OFF_CPSR = @offsetOf(Cpu, "cpsr");
const OFF_IC = @offsetOf(Cpu, "ic");
const OFF_LIMIT = @offsetOf(Cpu, "ic_limit");
const OFF_BPC = @offsetOf(Cpu, "bpc");
const OFF_EXCL = @offsetOf(Cpu, "excl");
const OFF_V = @offsetOf(Cpu, "v");
const FLAGS_BASE = abi.KERN_BASE + 0x10_0000;

const Block = struct { pc: u32, n: u32, taken: i32, fall: i32 };
const Region = struct {
    entry: u32,
    page: u32,
    epoch: u32,
    nblocks: u32,
    blocks: [MAX_BLOCKS]Block,
};
var regions: [MAX_REGIONS]Region = undefined;
var nregions: u32 = 0;
var requests: [MAX_REGIONS]u32 = undefined;
var nrequests: u32 = 0;
/// a batch handed to the host waits for its install; requests queue behind it
var in_flight: bool = false;
pub var stats = struct { regions: u32 = 0, batches: u32 = 0, skipped: u32 = 0, bytes: u32 = 0 }{};

pub fn request(pc: u32) void {
    if (nrequests >= MAX_REGIONS) return;
    for (requests[0..nrequests]) |r| if (r == pc) return;
    requests[nrequests] = pc;
    nrequests += 1;
}
export fn jit_pending() u32 {
    return if (in_flight) 0 else nrequests;
}
export fn jit_count() u32 {
    return nregions;
}
export fn jit_stat(i: u32) u32 {
    return switch (i) {
        0 => stats.regions,
        1 => stats.batches,
        2 => stats.skipped,
        else => stats.bytes,
    };
}
/// the region's blocks get the slot the host linked it into; a page dropped since emission keeps none
export fn jit_install(i: u32, slot: u32) void {
    const r = &regions[i];
    const page = cpu.decodedPage(r.page) orelse return;
    if (page.epoch != r.epoch) return;
    for (r.blocks[0..r.nblocks], 0..) |b, k| page.slot[(b.pc & (abi.PAGE_SIZE - 1)) >> 2] = (slot << 8) | @as(u32, @intCast(k));
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
fn blockFor(r: *Region, pc: u32) i32 {
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
fn discover(r: *Region, page: *cpu.Page) bool {
    var total: u32 = 0;
    var i: u32 = 0;
    while (i < r.nblocks) : (i += 1) {
        var pc = r.blocks[i].pc;
        var n: u32 = 0;
        while (true) {
            const o = opAt(page, pc);
            n += 1;
            total += 1;
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
                .br, .svc, .fault, .mrs, .msr, .excl, .atomic => true,
                else => false,
            };
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
const Emit = struct {
    b: *Buf,
    r: *Region,
    page: *cpu.Page,
    blk: u32,
    /// registers the region reads or writes, for the prologue and the spills
    used: u32,
    written: u32,
    /// the depth of the exit block and the loop from the current block body, and how many
    /// if-blocks the emitter is inside at the moment
    exit_depth: u32,
    top_depth: u32,
    nest: u32,

    fn ifv(e: *Emit) void {
        e.b.blockStart(O.if_, wasm.VOID);
        e.nest += 1;
    }
    fn endif(e: *Emit) void {
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
    fn loadIc(e: *Emit) void {
        e.b.get(L_CPU);
        e.b.memop(O.i64_load, OFF_IC);
    }
    /// ic += k
    fn countIc(e: *Emit, k: u32) void {
        e.b.get(L_CPU);
        e.loadIc();
        e.b.i64c(k);
        e.b.op(O.i64_add);
        e.b.memop(O.i64_store, OFF_IC);
    }
    fn spillRegs(e: *Emit) void {
        var n: u8 = 0;
        while (n < 32) : (n += 1) if (e.written & (@as(u32, 1) << @intCast(n)) != 0) {
            e.b.get(L_CPU);
            e.b.get(L_X + n);
            e.b.memop(O.i64_store, OFF_X + 8 * @as(u32, n));
        };
    }
    fn loadRegs(e: *Emit) void {
        var n: u8 = 0;
        while (n < 32) : (n += 1) if (e.used & (@as(u32, 1) << @intCast(n)) != 0) {
            e.b.get(L_CPU);
            e.b.memop(O.i64_load, OFF_X + 8 * @as(u32, n));
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
        const shifts = [_]u8{ 31, 30, 29, 28 };
        for (shifts, 0..) |s, i| {
            b.get(L_CPU);
            b.memop(O.i32_load, OFF_CPSR);
            b.i32c(s);
            b.op(O.i32_shr_u);
            b.i32c(1);
            b.op(O.i32_and);
            b.set(L_N + @as(u32, @intCast(i)));
        }
    }
    /// leave with `ret` already in L_RET
    fn exit(e: *Emit) void {
        e.b.br(e.exit_depth + e.nest);
    }
    fn exitTo(e: *Emit, pc: u32) void {
        e.b.i32c(@bitCast(pc));
        e.b.set(L_RET);
        e.exit();
    }
    fn exitStatus(e: *Emit, s: u32) void {
        e.b.i32c(@intCast(s));
        e.b.set(L_RET);
        e.exit();
    }
    /// go to a block of the region, or out to a pc; `k` instructions of the current block ran
    fn transfer(e: *Emit, target: i32, pc: u32, k: u32) void {
        e.countIc(k);
        if (target < 0) {
            e.exitTo(pc);
            return;
        }
        // the budget: leave at the boundary, the dispatcher decides
        e.loadIc();
        e.b.get(L_CPU);
        e.b.memop(O.i64_load, OFF_LIMIT);
        e.b.op(O.i64_ge_s);
        e.ifv();
        e.exitTo(pc);
        e.endif();
        e.b.i32c(target);
        e.b.set(L_NEXT);
        e.b.br(e.top_depth + e.nest);
    }
    /// the interpreter runs this word: everything spills first and reloads after
    fn fallback(e: *Emit, pc: u32, k: u32) void {
        const b = e.b;
        e.spillRegs();
        e.spillFlags();
        b.get(L_CPU);
        b.i32c(@bitCast(mem.ld32(pc)));
        b.i32c(@bitCast(pc));
        b.call(F_EXEC);
        b.tee(L_R);
        e.ifv();
        e.countIc(k);
        b.get(L_R);
        b.set(L_RET);
        e.exit();
        e.endif();
        e.loadRegs();
        e.loadFlags();
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
    fn storeCheck(e: *Emit, off: u32) void {
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
    fn cond(e: *Emit, cc: u8) void {
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
        b.get(L_T0);
        b.get(L_T2);
        b.op(O.i64_xor);
        b.get(L_T1);
        b.get(L_T2);
        b.op(O.i64_xor);
        b.op(O.i64_and);
        b.i64c(63);
        b.op(O.i64_shr_u);
        b.op(O.i32_wrap_i64);
        b.set(L_V);
    }
    fn flagsAdd32(e: *Emit, carry_in: bool, sub: bool) void {
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
        b.get(L_R);
        b.op(O.i32_xor);
        b.get(L_B);
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
                e.exit();
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

/// the registers an op touches, for the prologue and spills (conservative: every field that
/// can name a register)
fn regsOf(o: *const Op) u32 {
    return switch (o.kind) {
        .nop, .clrex, .bcond => 0,
        .b => if (o.a != 0) bit(30) else 0,
        .adr, .movw, .ldrlit, .cbz, .tbz => bit(o.rd),
        .br => bit(o.rn) | bit(30),
        .ldp => bit(o.rd) | bit(o.rm) | bit(o.rn),
        .three => bit(o.rd) | bit(o.rn) | bit(o.rm) | bit(o.ra),
        .addsub, .logic, .bfm, .extr, .ldst, .adc, .ccmp, .csel, .one, .two => bit(o.rd) | bit(o.rn) | bit(o.rm),
        // the interpreter runs these: it may touch anything
        else => 0xffff_ffff,
    };
}
inline fn bit(n: u8) u32 {
    return @as(u32, 1) << @intCast(n & 31);
}

/// emit the region's function body into `b`
fn emitRegion(b: *Buf, r: *Region, page: *cpu.Page) void {
    var e = Emit{ .b = b, .r = r, .page = page, .blk = 0, .used = 0, .written = 0, .exit_depth = 0, .top_depth = 0, .nest = 0 };
    for (r.blocks[0..r.nblocks]) |blk| {
        var pc = blk.pc;
        var i: u32 = 0;
        while (i < blk.n) : (i += 1) {
            const o = &page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2];
            const regs = regsOf(o);
            e.used |= regs;
            e.written |= regs;
            pc += 4;
        }
    }
    // an interpreter fallback may touch any register: the spill set is the whole file then
    // locals: 32 i64 registers, 4 i32 flags, 4 i64 temps, 5 i32 temps
    b.u(4);
    b.u(32);
    b.byte(wasm.I64);
    b.u(4);
    b.byte(wasm.I32);
    b.u(4);
    b.byte(wasm.I64);
    b.u(5);
    b.byte(wasm.I32);
    e.loadRegs();
    e.loadFlags();
    b.get(L_ENTRY);
    b.set(L_NEXT);
    const n = r.nblocks;
    b.blockStart(O.block, wasm.VOID); // exit
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
        e.exit_depth = n - i;
        const blk = r.blocks[i];
        b.get(L_CPU);
        b.i32c(@bitCast(blk.pc));
        b.memop(O.i32_store, OFF_BPC);
        var pc = blk.pc;
        var j: u32 = 0;
        var ended = false;
        while (j < blk.n) : (j += 1) {
            const o = &page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2];
            ended = e.emitOp(o, pc, j + 1);
            pc += 4;
            if (ended) break;
        }
        if (!ended) e.transfer(blk.fall, pc, blk.n);
    }
    b.op(O.end); // loop
    b.op(O.end); // exit
    e.spillRegs();
    e.spillFlags();
    b.get(L_RET);
    b.op(O.end); // function
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
        r.* = .{ .entry = pc, .page = pc >> abi.PAGE_SHIFT, .epoch = page.epoch, .nblocks = 0, .blocks = undefined };
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
    // import section: memory, exec, tx, store
    b.byte(2);
    const imp_len = b.reserve();
    const imp_start = b.len;
    b.u(4);
    importName(&b, "memory");
    b.bytes(&[_]u8{ 0x02, 0x00, 1 });
    importName(&b, "exec");
    b.bytes(&[_]u8{ 0x00, 1 });
    importName(&b, "tx");
    b.bytes(&[_]u8{ 0x00, 2 });
    importName(&b, "store");
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
