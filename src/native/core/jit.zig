const std = @import("std");
const abi = @import("abi.zig");
const mem = @import("mem.zig");
const cpu = @import("cpu.zig");
const a64 = @import("a64.zig");
const wasm = @import("wasm.zig");
const jit32 = @import("jit32.zig");
const jitfp = @import("jitfp.zig");
const jitmem = @import("jitmem.zig");
const fp = @import("fp.zig");
const bt = @import("bits.zig");
const assert = std.debug.assert;
const Cpu = cpu.Cpu;
const Op = a64.Op;
const Buf = wasm.Buf;
const O = wasm.Op;
const W = wasm.W;
const get = wasm.get;
const set = wasm.set;
const tee = wasm.tee;
const c32 = wasm.c32;
const c64 = wasm.c64;
const mo = wasm.mo;
const call = wasm.call;
const bit = bt.bit;
const bits = bt.bits;

pub const HEAT = 48;
const MAX_BLOCKS = 40;
const MAX_INSTR = 640;
const MAX_REGIONS = 64;

pub const L_CPU = 0;
const L_ENTRY = 1;
pub const L_X = 2;
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
pub const L_F0 = 50;
pub const L_F1 = 51;
pub const L_FA64 = 52;
pub const L_FB64 = 53;
pub const L_FR64 = 54;
pub const L_FA32 = 55;
pub const L_FB32 = 56;
pub const L_FR32 = 57;
pub const L_VA = 58;
pub const L_VB = 59;
pub const L_VC = 60;
pub const L_VREG = 61;
pub const FN: u4 = 8;
pub const FZ: u4 = 4;
pub const FC: u4 = 2;
pub const FV: u4 = 1;
pub const Pend = enum(u8) { none, add, sub, adc, logic, nz };
pub fn condReads(cc: u8) u4 {
    return switch (cc >> 1) {
        0 => FZ,
        1 => FC,
        2 => FN,
        3 => FV,
        4 => FC | FZ,
        5 => FN | FV,
        6 => FZ | FN | FV,
        else => 0,
    };
}
const F_EXEC = 0;
const F_STORE = 1;
const F_EXEC32 = 2;
pub const F_FMAX32 = 3;
pub const F_FMA64 = 11;
const F_IT32 = 12;
const F_TX = 13;
pub const F_ESTIMATE32 = 14;
const N_IMPORTS = 15;
const FP_NAMES = [_][]const u8{ "fmax", "fmin", "fmaxnm", "fminnm" };
fn fpThunk(comptime F: type, comptime k: u2) *const fn (F, F) callconv(.c) F {
    return &struct {
        fn g(a: F, b: F) callconv(.c) F {
            return switch (k) {
                0 => fp.fmax(F, a, b),
                1 => fp.fmin(F, a, b),
                2 => fp.fnm(F, a, b, true),
                else => fp.fnm(F, a, b, false),
            };
        }
    }.g;
}
fn fma64(a: f64, b: f64, c: f64) callconv(.c) f64 {
    return fp.fma(f64, a, b, c);
}
/// One lane of ARM32 VRECPE.F32 (or VRSQRTE.F32 when `sqrt`), standardized on both sides as
/// arm.neonMisc runs it.
fn estimate32(x: u32, sqrt: u32) callconv(.c) u32 {
    const v = fp.standard32(@bitCast(x));
    return @bitCast(fp.standard32(if (sqrt != 0) fp.rsqrte(f32, v) else fp.recpe(f32, v)));
}
comptime {
    for ([_]type{ f32, f64 }, [_][]const u8{ "32", "64" }) |F, sfx| for (0..4) |k| @export(fpThunk(F, @intCast(k)), .{ .name = "jit_" ++ FP_NAMES[k] ++ sfx });
    @export(&fma64, .{ .name = "jit_fma64" });
    @export(&estimate32, .{ .name = "jit_estimate32" });
}
comptime {
    // jit_install packs the block index into the low byte of page.slot, the table slot above it.
    assert(MAX_BLOCKS <= 256);
}

const OFF_X = @offsetOf(Cpu, "x");
const OFF_CPSR = @offsetOf(Cpu, "cpsr");
const OFF_IC = @offsetOf(Cpu, "ic");
const OFF_LIMIT = @offsetOf(Cpu, "ic_limit");
const OFF_BPC = @offsetOf(Cpu, "bpc");
const OFF_EXIT = @offsetOf(Cpu, "exit");
const OFF_FAULT_WORD = @offsetOf(Cpu, "fault_word");
const OFF_FAULT_ADDR = @offsetOf(Cpu, "fault_addr");
const OFF_EXCL = @offsetOf(Cpu, "excl");
const OFF_TLS = @offsetOf(Cpu, "tls");
const OFF_SLOT = @offsetOf(cpu.Page, "slot");
const FLAGS_BASE = @intFromPtr(mem.page_flags);
/// bit 0: the engine has tail calls; bit 1: the host's memory is shared
var chain: bool = false;
var shared: bool = false;
export fn jit_config(c: u32) void {
    chain = c & 1 != 0;
    shared = c & 2 != 0;
}

pub const Isa = enum(u8) { a64 = 0, arm = 1, thumb = 2 };
/// epoch: its page's when it was scanned; an A64 region spans the pages its blocks are on
pub const Block = struct { pc: u32, epoch: u32, n: u32, taken: i32, fall: i32, exits: bool };
pub const Region = struct {
    entry: u32,
    isa: Isa,
    nblocks: u32,
    blocks: [MAX_BLOCKS]Block,
};
var regions: [MAX_REGIONS]Region = undefined;
var nregions: u32 = 0;
var requests: [MAX_REGIONS]u32 = undefined;
var request_isa: [MAX_REGIONS]Isa = undefined;
var nrequests: u32 = 0;
var in_flight: bool = false;
pub var regions_installed: u32 = 0;

pub fn request(pc: u32, isa: Isa) bool {
    if (nrequests >= MAX_REGIONS) return false;
    for (requests[0..nrequests]) |r| if (r == pc) return true;
    requests[nrequests] = pc;
    request_isa[nrequests] = isa;
    nrequests += 1;
    return true;
}
var fb_lo: u32 = 0;
var fb_hi: u32 = 0;
export fn jit_fallback(lo: u32, hi: u32) void {
    fb_lo = lo;
    fb_hi = hi;
}
pub fn forcedFallback(pc: u32) bool {
    return pc -% fb_lo < fb_hi -% fb_lo;
}
export fn jit_pending() u32 {
    return if (in_flight) 0 else nrequests;
}
export fn jit_count() u32 {
    return nregions;
}
export fn jit_entry(i: u32) u32 {
    abi.require(i < nregions, "jit_entry: region index out of range");
    return regions[i].entry;
}
export fn jit_stat() u32 {
    return regions_installed;
}
export fn jit_install(i: u32, slot: u32) void {
    abi.require(i < nregions, "jit_install: region index out of range");
    // The slot is packed above the block index here and read back as an index into cpu.zig's dead
    // map, which is sized for the host's table.
    abi.require(slot < abi.JIT_SLOTS, "jit_install: table slot out of range");
    const r = &regions[i];
    for (r.blocks[0..r.nblocks]) |b| if ((blockPage(b) orelse return).epoch != b.epoch) return;
    // An empty block only exits to its own pc, so installing one would hand that pc straight back
    // to a region that cannot advance it.
    for (r.blocks[0..r.nblocks], 0..) |b, k| if (b.n != 0) {
        blockPage(b).?.slot[(b.pc & (abi.PAGE_SIZE - 1)) >> 1] = (slot << 8) | @as(u32, @intCast(k));
    };
    regions_installed += 1;
}
export fn jit_done() void {
    in_flight = false;
    nregions = 0;
}

fn blockPage(b: Block) ?*cpu.Page {
    return cpu.decodedPage(b.pc >> abi.PAGE_SHIFT);
}
/// A64 blocks may lie on any page the interpreter has decoded, which is all code that has run;
/// ARM and Thumb stay on the entry's page, where a Thumb instruction cannot straddle into the next.
pub fn blockFor(r: *Region, pc: u32) i32 {
    for (r.blocks[0..r.nblocks], 0..) |b, i| if (b.pc == pc) return @intCast(i);
    if (r.nblocks >= MAX_BLOCKS or (r.isa != .a64 and (pc ^ r.entry) >> abi.PAGE_SHIFT != 0)) return -1;
    const page = cpu.decodedPage(pc >> abi.PAGE_SHIFT) orelse return -1;
    r.blocks[r.nblocks] = .{ .pc = pc, .epoch = page.epoch, .n = 0, .taken = -2, .fall = -2, .exits = false };
    r.nblocks += 1;
    return @intCast(r.nblocks - 1);
}
fn scanA64(r: *Region, i: u32, page: *cpu.Page, pc: u32) jit32.Scan {
    const o = a64.opAt(page, pc);
    const next = pc + 4;
    const ends = switch (o.kind) {
        // ISB must redispatch after a store invalidates the active region's source page.
        .nop => mem.ld(u32, pc) & 0xfffff0ff == 0xd50330df,
        .b => blk: {
            r.blocks[i].taken = blockFor(r, @truncate(o.imm));
            break :blk true;
        },
        .bcond, .cbz, .tbz => blk: {
            r.blocks[i].taken = blockFor(r, @truncate(o.imm));
            r.blocks[i].fall = blockFor(r, next);
            break :blk true;
        },
        .br, .svc, .fault => true,
        else => false,
    };
    return .{ .len = 4, .ends = ends };
}
fn discover(r: *Region) bool {
    var total: u32 = 0;
    var i: u32 = 0;
    // Scanning a block registers its successors, so r.nblocks grows underneath this loop. Stopping
    // on the budget here and not only inside the inner loop is what keeps the instructions across
    // every block down to MAX_INSTR: a block reached after it is exhausted keeps blockFor's n = 0
    // and emits nothing, and jit_install leaves its pc to the interpreter.
    while (i < r.nblocks and total < MAX_INSTR) : (i += 1) {
        var pc = r.blocks[i].pc;
        const page = blockPage(r.blocks[i]).?;
        var n: u32 = 0;
        while (true) {
            const s = switch (r.isa) {
                .a64 => scanA64(r, i, page, pc),
                .arm => jit32.scanArm(r, i, page, pc),
                .thumb => jit32.scanThumb(r, i, page, pc),
            };
            n += 1;
            total += 1;
            pc += s.len;
            if (s.ends or n >= MAX_INSTR or total >= MAX_INSTR or (pc & (abi.PAGE_SIZE - 1)) == 0) {
                if (!s.ends) r.blocks[i].fall = if (total < MAX_INSTR) blockFor(r, pc) else -1;
                r.blocks[i].exits = s.ends and r.blocks[i].taken == -2;
                break;
            }
        }
        r.blocks[i].n = n;
    }
    // The blocks registered after that hold no instructions, so entering one leaves the region:
    // the flags a predecessor still keeps pending must be settled on that edge as on any exit.
    for (r.blocks[i..r.nblocks]) |*b| b.exits = true;
    return r.nblocks > 0;
}

pub const RW = struct { r: u32, w: u32, fr: u4 = 0, fw: u4 = 0, cond: bool = false };
const ALL = RW{ .r = 0xffff_ffff, .w = 0xffff_ffff, .fr = 15, .fw = 15 };
pub const ALL32 = RW{ .r = 0x7fff, .w = 0x7fff, .fr = 15, .fw = 15 };
pub const LD = [4][2]u8{
    .{ O.i64_load8_u, O.i64_load8_s },
    .{ O.i64_load16_u, O.i64_load16_s },
    .{ O.i64_load32_u, O.i64_load32_s },
    .{ O.i64_load, O.i64_load },
};
pub const ST = [4]u8{ O.i64_store8, O.i64_store16, O.i64_store32, O.i64_store };
const Regs = struct { a: u32, b: u32, r: u32, t: u32 };
inline fn regs(comptime wide: bool) Regs {
    return if (wide) .{ .a = L_T0, .b = L_T1, .r = L_T2, .t = L_T3 } else .{ .a = L_A, .b = L_B, .r = L_R, .t = L_NEXT };
}
pub inline fn fregs(comptime wide: bool) Regs {
    return if (wide) .{ .a = L_FA64, .b = L_FB64, .r = L_FR64, .t = L_T3 } else .{ .a = L_FA32, .b = L_FB32, .r = L_FR32, .t = L_NEXT };
}
inline fn cmpOp(comptime wide: bool, op32: u8) u8 {
    return if (wide) op32 + 0x0b else op32;
}
fn topBit(b: *Buf, comptime wide: bool) void {
    if (wide) b.emit(.{ c64(63), O.i64_shr_u, O.i32_wrap_i64 }) else b.emit(.{ c32(31), O.i32_shr_u });
}
inline fn cW(comptime wide: bool, v: i32) if (wide) wasm.C64 else wasm.C32 {
    return if (wide) c64(v) else c32(v);
}

fn swapAdjacent(b: *Buf, comptime wide: bool, comptime shift: u6) void {
    const pattern: u64 = switch (shift) {
        1 => 0x5555_5555_5555_5555,
        2 => 0x3333_3333_3333_3333,
        4 => 0x0f0f_0f0f_0f0f_0f0f,
        8 => 0x00ff_00ff_00ff_00ff,
        16 => 0x0000_ffff_0000_ffff,
        32 => 0x0000_0000_ffff_ffff,
        else => unreachable,
    };
    const tmp = regs(wide).t;
    b.tee(tmp);
    if (wide) b.i64c(@bitCast(pattern)) else b.i32c(@bitCast(@as(u32, @truncate(pattern))));
    b.emit(.{ W(wide, O.i32_and), cW(wide, shift), W(wide, O.i32_shl), get(tmp), cW(wide, shift), W(wide, O.i32_shr_u) });
    if (wide) b.i64c(@bitCast(pattern)) else b.i32c(@bitCast(@as(u32, @truncate(pattern))));
    b.emit(.{ W(wide, O.i32_and), W(wide, O.i32_or) });
}

fn emitOne(b: *Buf, comptime wide: bool, op: u8) void {
    switch (op) {
        0 => {
            inline for ([_]u6{ 1, 2, 4, 8, 16 }) |shift| swapAdjacent(b, wide, shift);
            if (wide) swapAdjacent(b, wide, 32);
        },
        1, 2, 3 => {
            swapAdjacent(b, wide, 8);
            if (op >= 2) swapAdjacent(b, wide, 16);
            if (op == 3 and wide) swapAdjacent(b, wide, 32);
        },
        4 => b.byte(W(wide, O.i32_clz)),
        5 => {
            const tmp = regs(wide).t;
            b.tee(tmp);
            b.emit(.{ get(tmp), cW(wide, if (wide) 63 else 31), W(wide, O.i32_shr_s), W(wide, O.i32_xor), W(wide, O.i32_clz), cW(wide, 1), W(wide, O.i32_sub) });
        },
        else => unreachable,
    }
}

pub fn Emit(comptime wide: bool) type {
    return struct {
        const Self = @This();
        b: *Buf,
        r: *Region,
        blk: u32,
        pc: u32 = 0,
        used: u32,
        written: u32,
        wcur: u32,
        rw: RW,
        chain_depth: u32,
        nest: u32,
        pk: Pend = .none,
        term: bool = false,
        lin: [MAX_BLOCKS]u4 = undefined,
        pw: bool = false,
        pdirty: u4 = 0,
        vloaded: u32 = 0,
        vcachedWrite: bool = false,

        pub fn ifv(e: *Self) void {
            e.b.blockStart(O.if_, wasm.VOID);
            e.nest += 1;
        }
        pub fn ifc(e: *Self, mask: u4) void {
            e.settle(mask);
            e.ifv();
        }
        pub fn branch(e: *Self, tpc: u32, fpc: u32, k: u32) void {
            const blk = e.r.blocks[e.blk];
            const pk = e.pk;
            const pw = e.pw;
            const pdirty = e.pdirty;
            e.ifv();
            e.term = true;
            e.transfer(blk.taken, tpc, k);
            e.b.byte(O.else_);
            e.pk = pk;
            e.pw = pw;
            e.pdirty = pdirty;
            e.transfer(blk.fall, fpc, k);
            e.term = false;
            e.endif();
            e.pk = .none;
            e.pdirty = 0;
        }
        fn kindMask(kind: Pend) u4 {
            return switch (kind) {
                .logic => if (wide) 15 else 14,
                .nz => 12,
                else => 15,
            };
        }
        fn flagsOf(e: *Self, comptime w: bool, kind: Pend, mask: u4) void {
            const R = fregs(w);
            const b = e.b;
            if (mask & FN != 0) {
                b.get(R.r);
                topBit(b, w);
                b.set(L_N);
            }
            if (mask & FZ != 0) b.emit(.{ get(R.r), W(w, O.i32_eqz), set(L_Z) });
            if (mask & FC != 0) switch (kind) {
                .add => b.emit(.{ get(R.r), get(R.a), W(w, O.i32_lt_u), set(L_C) }),
                .sub => b.emit(.{ get(R.a), get(R.b), W(w, O.i32_ge_u), set(L_C) }),
                .adc => b.emit(.{ get(R.a), get(R.b), W(w, O.i32_add), tee(R.t), get(R.a), W(w, O.i32_lt_u), get(R.r), get(R.t), W(w, O.i32_lt_u), O.i32_or, set(L_C) }),
                .logic => if (wide) b.emit(.{ c32(0), set(L_C) }) else b.emit(.{ get(L_SC), set(L_C) }),
                .nz, .none => {},
            };
            if (mask & FV != 0) switch (kind) {
                .add, .adc, .sub => {
                    b.emit(.{ get(R.a), get(if (kind == .sub) R.b else R.r), W(w, O.i32_xor), get(if (kind == .sub) R.a else R.b), get(R.r), W(w, O.i32_xor), W(w, O.i32_and) });
                    topBit(b, w);
                    b.set(L_V);
                },
                .logic => if (wide) b.emit(.{ c32(0), set(L_V) }),
                .nz, .none => {},
            };
        }
        pub fn pre(e: *Self, kind: Pend) void {
            e.settle(~kindMask(kind));
        }
        pub fn pend(e: *Self, comptime w: bool, kind: Pend) void {
            e.pk = kind;
            e.pw = w;
            e.pdirty = kindMask(kind);
            if (e.nest != 0) e.emitPending(e.pdirty);
        }
        fn emitPending(e: *Self, m: u4) void {
            if (wide and e.pw) e.flagsOf(true, e.pk, m) else e.flagsOf(false, e.pk, m);
            e.drop(m);
        }
        pub fn settle(e: *Self, mask: u4) void {
            const m = mask & e.pdirty;
            if (m == 0) return;
            assert(e.nest == 0 or e.term);
            e.emitPending(m);
        }
        fn drop(e: *Self, mask: u4) void {
            e.pdirty &= ~mask;
            if (e.pdirty == 0) e.pk = .none;
        }
        pub fn eager(e: *Self, mask: u4) void {
            e.settle(~mask);
            e.drop(mask);
        }
        fn fuse(e: *Self, comptime w: bool, cc: u8) bool {
            const R = fregs(w);
            const b = e.b;
            switch (cc >> 1) {
                0 => b.emit(.{ get(R.r), W(w, O.i32_eqz) }),
                2 => {
                    b.get(R.r);
                    topBit(b, w);
                },
                1 => switch (e.pk) {
                    .sub => b.emit(.{ get(R.a), get(R.b), cmpOp(w, O.i32_ge_u) }),
                    .add => b.emit(.{ get(R.r), get(R.a), cmpOp(w, O.i32_lt_u) }),
                    else => return false,
                },
                4, 5, 6 => {
                    if (e.pk != .sub) return false;
                    b.emit(.{ get(R.a), get(R.b), cmpOp(w, switch (cc >> 1) {
                        4 => O.i32_gt_u,
                        5 => O.i32_ge_s,
                        else => O.i32_gt_s,
                    }) });
                },
                else => return false,
            }
            if (cc & 1 != 0) b.byte(O.i32_eqz);
            return true;
        }
        pub fn endif(e: *Self) void {
            e.b.byte(O.end);
            e.nest -= 1;
        }
        pub fn getX(e: *Self, n: u8) void {
            if (n == 31) e.b.i64c(0) else e.b.get(L_X + n);
        }
        pub fn getSP(e: *Self, n: u8) void {
            e.b.get(L_X + n);
        }
        pub fn setX(e: *Self, n: u8) void {
            if (n == 31) e.b.byte(O.drop) else e.b.set(L_X + n);
        }
        pub fn setSP(e: *Self, n: u8) void {
            e.b.set(L_X + n);
        }
        pub fn setW(e: *Self, n: u8) void {
            e.b.byte(O.i64_extend_i32_u);
            e.setX(n);
        }
        /// UMULH/SMULH: the high 64 bits of the 128-bit product, from 32-bit halves (Hacker's Delight mulhu)
        fn mulHigh(e: *Self, rd: u8, rn: u8, rm: u8, signed: bool) void {
            const b = e.b;
            const lo = c64(0xffff_ffff);
            e.getX(rn);
            b.set(L_T0);
            e.getX(rm);
            b.set(L_T1);
            b.emit(.{ get(L_T0), c64(32), O.i64_shr_u, get(L_T1), lo, O.i64_and, O.i64_mul, get(L_T0), lo, O.i64_and, get(L_T1), lo, O.i64_and, O.i64_mul, c64(32), O.i64_shr_u, O.i64_add, set(L_T2) });
            b.emit(.{ get(L_T0), c64(32), O.i64_shr_u, get(L_T1), c64(32), O.i64_shr_u, O.i64_mul, get(L_T2), c64(32), O.i64_shr_u, O.i64_add });
            b.emit(.{ get(L_T2), lo, O.i64_and, get(L_T0), lo, O.i64_and, get(L_T1), c64(32), O.i64_shr_u, O.i64_mul, O.i64_add, c64(32), O.i64_shr_u, O.i64_add });
            if (signed) b.emit(.{ get(L_T1), get(L_T0), c64(63), O.i64_shr_s, O.i64_and, O.i64_sub, get(L_T0), get(L_T1), c64(63), O.i64_shr_s, O.i64_and, O.i64_sub });
            e.setX(rd);
        }
        pub fn countIc(e: *Self, k: u32) void {
            e.b.emit(.{ get(L_IC), c64(k), O.i64_add, set(L_IC) });
        }
        fn storeIc(e: *Self) void {
            e.b.emit(.{ get(L_CPU), get(L_IC), mo(O.i64_store, OFF_IC) });
        }
        fn spillRegs(e: *Self, mask: u32) void {
            var n: u8 = 0;
            while (n < 32) : (n += 1) if (mask & bit(n) != 0) e.b.emit(.{ get(L_CPU), get(L_X + n), mo(W(wide, O.i32_store), OFF_X + 8 * @as(u32, n)) });
        }
        fn loadRegs(e: *Self, mask: u32) void {
            var n: u8 = 0;
            while (n < 32) : (n += 1) if (mask & bit(n) != 0) e.b.emit(.{ get(L_CPU), mo(W(wide, O.i32_load), OFF_X + 8 * @as(u32, n)), set(L_X + n) });
        }
        fn spillFlags(e: *Self) void {
            e.b.emit(.{ get(L_CPU), get(L_CPU), mo(O.i32_load, OFF_CPSR), c32(0x0fff_ffff), O.i32_and, get(L_N), c32(31), O.i32_shl, O.i32_or, get(L_Z), c32(30), O.i32_shl, O.i32_or, get(L_C), c32(29), O.i32_shl, O.i32_or, get(L_V), c32(28), O.i32_shl, O.i32_or, mo(O.i32_store, OFF_CPSR) });
        }
        fn loadFlags(e: *Self, mask: u4) void {
            if (mask == 0) return;
            e.b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_CPSR), set(L_A) });
            if (mask & FN != 0) e.b.emit(.{ get(L_A), c32(31), O.i32_shr_u, set(L_N) });
            for ([_]u8{ 30, 29, 28 }, [_]u4{ FZ, FC, FV }, L_Z..L_V + 1) |s, f, l| if (mask & f != 0) e.b.emit(.{ get(L_A), c32(s), O.i32_shr_u, c32(1), O.i32_and, set(@intCast(l)) });
        }
        fn edge(e: *Self, t: i32) u4 {
            return if (t >= 0) e.lin[@intCast(t)] else 15;
        }
        /// to the epilogue, which spills the flag locals: a pending compare's flags are written to
        /// them first, without settling it for the code that goes on past this exit
        pub fn exit(e: *Self) void {
            if (e.pdirty != 0) {
                if (wide and e.pw) e.flagsOf(true, e.pk, e.pdirty) else e.flagsOf(false, e.pk, e.pdirty);
            }
            e.b.br(e.chain_depth + 1 + e.nest);
        }
        pub fn exitRet(e: *Self) void {
            e.settle(15);
            e.spillRegs(e.wcur);
            e.spillFlags();
            e.b.br(e.chain_depth + e.nest);
        }
        pub fn exitTo(e: *Self, pc: u32) void {
            e.b.emit(.{ c32(@bitCast(pc)), set(L_RET) });
            e.exitRet();
        }
        pub fn exitToInterpreter(e: *Self, pc: u32, k: u32) void {
            e.settle(15);
            e.spillRegs(e.wcur);
            e.spillFlags();
            e.countIc(k);
            e.b.emit(.{ get(L_CPU), c64(pc & ~@as(u32, 1)), mo(O.i64_store, @offsetOf(cpu.Cpu, "pc")) });
            e.exitStatus(1);
        }
        pub fn exitStatus(e: *Self, s: u32) void {
            e.b.emit(.{ c32(@intCast(s)), set(L_RET) });
            e.exit();
        }
        pub fn transfer(e: *Self, target: i32, pc: u32, k: u32) void {
            e.settle(e.edge(target));
            e.countIc(k);
            if (target < 0) return e.exitTo(pc);
            const to = e.r.blocks[@intCast(target)];
            if ((to.pc ^ e.r.blocks[e.blk].pc) >> abi.PAGE_SHIFT != 0) {
                // a store may since have dropped the page the target was compiled from
                const page = @intFromPtr(blockPage(to).?);
                e.b.emit(.{ c32(0), mo(O.i32_load, cpu.DECODED + (to.pc >> abi.PAGE_SHIFT) * 4), c32(@bitCast(page)), O.i32_ne,
                    c32(0), mo(O.i32_load, page + @offsetOf(cpu.Page, "epoch")), c32(@bitCast(to.epoch)), O.i32_ne, O.i32_or });
                e.guardedExit(pc);
            }
            const blk: i32 = @intCast(e.blk);
            // a later block's code follows the end of the block nested (target - blk - 1) out from here
            if (target > blk) return e.b.br(@as(u32, @intCast(target - blk - 1)) + e.nest);
            e.b.emit(.{ get(L_IC), get(L_LIMIT), O.i64_ge_s });
            e.guardedExit(pc);
            e.b.emit(.{ c32(target), set(L_NEXT) });
            e.b.br(e.chain_depth - 1 + e.nest);
        }
        /// exit to pc if the condition on the stack holds
        fn guardedExit(e: *Self, pc: u32) void {
            e.ifv();
            // The exit may settle flags the target does not read; the path past it reads none.
            const term = e.term;
            e.term = true;
            e.exitTo(pc);
            e.term = term;
            e.endif();
        }
        pub fn fallback(e: *Self, pc: u32, k: u32) void {
            const b = e.b;
            if (e.rw.fr | e.rw.fw != 0) e.settle(15);
            e.spillRegs(e.rw.r | e.rw.w);
            if (e.rw.fr | e.rw.fw != 0) e.spillFlags();
            if (wide) b.emit(.{ get(L_CPU), c32(@bitCast(mem.ld(u32, pc))), c32(@bitCast(pc)), call(F_EXEC), set(L_R) }) else b.emit(.{ get(L_CPU), c32(@bitCast(pc)), call(F_EXEC32), set(L_R) });
            e.loadRegs(e.rw.w);
            e.vloaded = 0;
            if (e.rw.fw != 0) {
                e.loadFlags(15);
                e.eager(15);
            }
            b.get(L_R);
            e.ifv();
            e.countIc(k);
            b.emit(.{ get(L_R), set(L_RET) });
            e.exit();
            e.endif();
        }
        pub fn fallbackIt(e: *Self, pc: u32, end: u32, k: u32) void {
            const b = e.b;
            e.settle(15);
            e.spillRegs(e.rw.r | e.rw.w);
            e.spillFlags();
            e.countIc(k - 1);
            e.storeIc();
            b.emit(.{ get(L_CPU), c32(@bitCast(pc)), c32(@bitCast(end)), call(F_IT32), set(L_R) });
            e.loadRegs(e.rw.w);
            e.loadFlags(15);
            e.eager(15);
            b.emit(.{ get(L_CPU), mo(O.i64_load, OFF_IC), set(L_IC), get(L_R) });
            e.ifv();
            b.emit(.{ get(L_R), set(L_RET) });
            e.exit();
            e.endif();
        }
        fn faultExit(e: *Self) void {
            e.b.emit(.{ get(L_CPU), c32(@bitCast(e.r.blocks[e.blk].pc)), mo(O.i32_store, OFF_BPC), get(L_CPU), c64(e.pc), mo(O.i64_store, @offsetOf(Cpu, "pc")) });
            e.exitStatus(2);
        }
        pub fn checkLowAddress(e: *Self) void {
            e.checkAddress(0);
        }
        /// L_A faults as bad_address below LOW, past ARM32's 2 GiB (signed, as arm.addr) or, with
        /// a nonzero mask, when misaligned.
        pub fn checkAddress(e: *Self, align_mask: u32) void {
            const b = e.b;
            b.emit(.{ get(L_A), c32(abi.LOW), O.i32_lt_s });
            if (align_mask != 0) b.emit(.{ get(L_A), c32(@intCast(align_mask)), O.i32_and, O.i32_or });
            e.ifv();
            b.emit(.{ get(L_CPU), c32(@intFromEnum(cpu.Fault.bad_address)), mo(O.i32_store, OFF_EXIT),
                get(L_CPU), c32(@bitCast(mem.ld(u32, e.pc))), mo(O.i32_store, OFF_FAULT_WORD),
                get(L_CPU), get(L_A), O.i64_extend_i32_u, mo(O.i64_store, OFF_FAULT_ADDR) });
            e.faultExit();
            e.endif();
        }
        pub fn address(e: *Self) void {
            const b = e.b;
            // Top Byte Ignore: Linux runs arm64 user space with TBI0, so a tag in bits 56-63 is not address
            b.emit(.{ c64(a64.TBI_MASK), O.i64_and, tee(L_T0), c64(32), O.i64_shr_u, O.i32_wrap_i64, tee(L_B), O.i32_eqz, O.if_, wasm.I32, get(L_T0), O.i32_wrap_i64, O.else_ });
            b.emit(.{ get(L_B), c32(255), O.i32_and, c32(2), O.i32_shl, set(L_NEXT), get(L_T0), O.i32_wrap_i64, get(L_NEXT), mo(O.i32_load, @intFromPtr(&mem.L)), O.i32_sub, tee(L_R), get(L_NEXT), mo(O.i32_load, @intFromPtr(&mem.S)), O.i32_lt_u, get(L_B), c32(256), O.i32_lt_u, O.i32_and, O.if_, wasm.I32, get(L_NEXT), mo(O.i32_load, @intFromPtr(&mem.P)), get(L_R), O.i32_add, O.else_, get(L_B), get(L_T0), O.i32_wrap_i64, call(F_TX), O.end, O.end, tee(L_A), c32(abi.LOW), O.i32_lt_u });
            e.ifv();
            b.emit(.{ get(L_CPU), c32(@intFromEnum(cpu.Fault.bad_address)), mo(O.i32_store, OFF_EXIT), get(L_CPU), c32(@bitCast(mem.ld(u32, e.pc))), mo(O.i32_store, OFF_FAULT_WORD), get(L_CPU), get(L_T0), mo(O.i64_store, OFF_FAULT_ADDR) });
            e.faultExit();
            e.endif();
        }
        pub fn storeCheck(e: *Self, off: u32, size: u32) void {
            const b = e.b;
            const a: u32 = if (off != 0) L_NEXT else L_A;
            if (off != 0) b.emit(.{ get(L_A), c32(@bitCast(off)), O.i32_add, set(L_NEXT) });
            b.emit(.{ get(a), c32(abi.PAGE_SHIFT), O.i32_shr_u, mo(O.i32_load8_u, FLAGS_BASE) });
            if (size > 1) b.emit(.{ get(a), c32(@intCast(size - 1)), O.i32_add, c32(abi.PAGE_SHIFT), O.i32_shr_u, mo(O.i32_load8_u, FLAGS_BASE), O.i32_or });
            e.ifv();
            b.emit(.{ get(L_CPU), get(a), c32(@intCast(size)), call(F_STORE) });
            e.ifv();
            e.faultExit();
            e.endif();
            e.endif();
        }
        pub fn cond(e: *Self, cc: u8) void {
            const b = e.b;
            if (e.pk != .none and cc < 14 and (if (wide and e.pw) e.fuse(true, cc) else e.fuse(false, cc))) return;
            e.settle(condReads(cc));
            switch (cc >> 1) {
                0 => b.get(L_Z),
                1 => b.get(L_C),
                2 => b.get(L_N),
                3 => b.get(L_V),
                4 => b.emit(.{ get(L_C), get(L_Z), O.i32_eqz, O.i32_and }),
                5 => b.emit(.{ get(L_N), get(L_V), O.i32_eq }),
                6 => b.emit(.{ get(L_Z), O.i32_eqz, get(L_N), get(L_V), O.i32_eq, O.i32_and }),
                else => return b.i32c(1),
            }
            if (cc & 1 != 0) b.byte(O.i32_eqz);
        }
        fn shiftOp(comptime w: bool, kind: u8) u8 {
            return switch (kind & 3) {
                0 => W(w, O.i32_shl),
                1 => W(w, O.i32_shr_u),
                2 => W(w, O.i32_shr_s),
                else => W(w, O.i32_rotr),
            };
        }
        fn operand2(e: *Self, o: *const Op) void {
            const b = e.b;
            switch (o.b) {
                0 => b.i64c(@bitCast(o.imm)),
                1 => {
                    const amt: i32 = @intCast(o.imm);
                    e.getX(o.rm);
                    if (o.a & 4 != 0) {
                        if (amt != 0) b.emit(.{ c64(amt), shiftOp(true, o.ra) });
                        if (o.ra & 4 != 0) b.emit(.{ c64(-1), O.i64_xor });
                    } else {
                        b.byte(O.i32_wrap_i64);
                        if (amt != 0) b.emit(.{ c32(amt), shiftOp(false, o.ra) });
                        if (o.ra & 4 != 0) b.emit(.{ c32(-1), O.i32_xor });
                        b.byte(O.i64_extend_i32_u);
                    }
                },
                else => {
                    e.getX(o.rm);
                    switch (o.ra) {
                        0 => b.emit(.{ c64(255), O.i64_and }),
                        1 => b.emit(.{ c64(65535), O.i64_and }),
                        2 => b.emit(.{ c64(0xffff_ffff), O.i64_and }),
                        4 => b.byte(O.i64_extend8_s),
                        5 => b.byte(O.i64_extend16_s),
                        6 => b.byte(O.i64_extend32_s),
                        else => {},
                    }
                    if (o.imm != 0) b.emit(.{ c64(@intCast(o.imm)), O.i64_shl });
                },
            }
        }
        fn arith(e: *Self, comptime w: bool, o: *const Op, sub: bool, carry: bool, flag: bool) void {
            const b = e.b;
            const R = if (flag) fregs(w) else regs(w);
            const kind: Pend = if (carry) .adc else if (sub) .sub else .add;
            if (flag) e.pre(kind);
            if (carry) {
                e.settle(FC);
                e.getX(o.rn);
                if (!w) b.byte(O.i32_wrap_i64);
                b.set(R.a);
                e.getX(o.rm);
                if (!w) b.byte(O.i32_wrap_i64);
                if (sub) b.emit(.{ cW(w, -1), W(w, O.i32_xor) });
                b.emit(.{ set(R.b), get(R.a), get(R.b), W(w, O.i32_add), get(L_C) });
                if (w) b.byte(O.i64_extend_i32_u);
                b.emit(.{ W(w, O.i32_add), tee(R.r) });
            } else {
                if (o.b == 1) e.getX(o.rn) else e.getSP(o.rn);
                if (!w) b.byte(O.i32_wrap_i64);
                b.set(R.a);
                e.operand2(o);
                if (!w) b.byte(O.i32_wrap_i64);
                b.emit(.{ set(R.b), get(R.a), get(R.b), if (sub) W(w, O.i32_sub) else W(w, O.i32_add), tee(R.r) });
            }
            if (flag or carry) {
                if (w) e.setX(o.rd) else e.setW(o.rd);
            } else {
                if (!w) b.byte(O.i64_extend_i32_u);
                e.setSP(o.rd);
            }
            if (flag) e.pend(w, kind);
        }
        fn divide(e: *Self, comptime w: bool, signed: bool) void {
            const b = e.b;
            const R = regs(w);
            if (!w) b.byte(O.i32_wrap_i64);
            b.set(R.b);
            if (!w) b.byte(O.i32_wrap_i64);
            b.emit(.{ set(R.a), get(R.b), W(w, O.i32_eqz), O.if_, if (w) wasm.I64 else wasm.I32, cW(w, 0), O.else_ });
            if (signed) b.emit(.{ get(R.b), cW(w, -1), W(w, O.i32_eq), O.if_, if (w) wasm.I64 else wasm.I32, cW(w, 0), get(R.a), W(w, O.i32_sub), O.else_, get(R.a), get(R.b), W(w, O.i32_div_s), O.end }) else b.emit(.{ get(R.a), get(R.b), W(w, O.i32_div_u) });
            b.byte(O.end);
        }
        fn emitOp(e: *Self, o: *const Op, pc: u32, k: u32) bool {
            const b = e.b;
            switch (o.kind) {
                .nop => {},
                .adr => {
                    b.i64c(@bitCast(o.imm));
                    e.setX(o.rd);
                },
                .addsub => if (o.a & 4 != 0) e.arith(true, o, o.a & 1 != 0, false, o.a & 2 != 0) else e.arith(false, o, o.a & 1 != 0, false, o.a & 2 != 0),
                .adc => if (o.a & 4 != 0) e.arith(true, o, o.a & 1 != 0, true, o.a & 2 != 0) else e.arith(false, o, o.a & 1 != 0, true, o.a & 2 != 0),
                .logic => {
                    const opc = o.a & 3;
                    const sf = o.a & 4 != 0;
                    if (opc == 3) e.pre(.logic);
                    e.getX(o.rn);
                    e.operand2(o);
                    b.byte(switch (opc) {
                        0, 3 => O.i64_and,
                        1 => O.i64_or,
                        else => O.i64_xor,
                    });
                    if (!sf) b.emit(.{ O.i32_wrap_i64, tee(if (opc == 3) L_FR32 else L_R), O.i64_extend_i32_u }) else if (opc == 3) b.tee(L_FR64);
                    if (opc == 3) {
                        e.setX(o.rd);
                        if (sf) e.pend(true, .logic) else e.pend(false, .logic);
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
                            b.emit(.{ c64(@bitCast(~(@as(u64, 0xffff) << sh) & (if (sf) ~@as(u64, 0) else 0xffff_ffff))), O.i64_and, c64(@bitCast(val)), O.i64_or });
                        },
                    }
                    e.setX(o.rd);
                },
                .bfm => {
                    const opc = o.a & 3;
                    const sf = o.a & 4 != 0;
                    const rot: u32 = o.b;
                    const wmask = o.imm;
                    const tmask = a64.replicate(bt.ones(o.rm), @as(u32, 1) << @intCast(o.a >> 3), if (sf) 64 else 32);
                    e.getX(o.rn);
                    if (!sf) {
                        b.byte(O.i32_wrap_i64);
                        if (rot != 0) b.emit(.{ c32(@intCast(rot)), O.i32_rotr });
                        b.byte(O.i64_extend_i32_u);
                    } else if (rot != 0) b.emit(.{ c64(rot), O.i64_rotr });
                    b.emit(.{ c64(@bitCast(wmask)), O.i64_and });
                    if (opc == 1) {
                        e.getX(o.rd);
                        b.emit(.{ c64(@bitCast(~wmask)), O.i64_and, O.i64_or });
                    }
                    b.emit(.{ c64(@bitCast(tmask)), O.i64_and, set(L_T2) });
                    if (opc == 0) {
                        e.getX(o.rn);
                        b.emit(.{ c64(63 - @as(i64, o.ra)), O.i64_shl, c64(63), O.i64_shr_s, c64(@bitCast(~tmask)), O.i64_and, get(L_T2), O.i64_or });
                    } else if (opc == 1) {
                        e.getX(o.rd);
                        b.emit(.{ c64(@bitCast(~tmask)), O.i64_and, get(L_T2), O.i64_or });
                    } else b.get(L_T2);
                    if (!sf) b.emit(.{ c64(0xffff_ffff), O.i64_and });
                    e.setX(o.rd);
                },
                .extr => {
                    const lsb: i32 = o.b;
                    e.getX(o.rm);
                    if (o.a != 0) {
                        if (lsb != 0) {
                            b.emit(.{ c64(lsb), O.i64_shr_u });
                            e.getX(o.rn);
                            b.emit(.{ c64(64 - lsb), O.i64_shl, O.i64_or });
                        }
                        e.setX(o.rd);
                    } else {
                        b.byte(O.i32_wrap_i64);
                        if (lsb != 0) {
                            b.emit(.{ c32(lsb), O.i32_shr_u });
                            e.getX(o.rn);
                            b.emit(.{ O.i32_wrap_i64, c32(32 - lsb), O.i32_shl, O.i32_or });
                        }
                        e.setW(o.rd);
                    }
                },
                .b => {
                    if (o.a != 0) {
                        b.i64c(pc + 4);
                        e.setX(30);
                    }
                    e.transfer(e.r.blocks[e.blk].taken, @truncate(o.imm), k);
                    return true;
                },
                .bcond, .cbz, .tbz => {
                    switch (o.kind) {
                        .bcond => e.cond(o.a),
                        .cbz => {
                            e.getX(o.rd);
                            if (o.a & 1 == 0) b.emit(.{ O.i32_wrap_i64, O.i32_eqz }) else b.byte(O.i64_eqz);
                            if (o.a & 2 != 0) b.byte(O.i32_eqz);
                        },
                        else => {
                            e.getX(o.rd);
                            b.emit(.{ c64(o.b), O.i64_shr_u, O.i32_wrap_i64, c32(1), O.i32_and });
                            if (o.a == 0) b.byte(O.i32_eqz);
                        },
                    }
                    e.branch(@truncate(o.imm), pc + 4, k);
                    return true;
                },
                .br => {
                    e.getX(o.rn);
                    b.emit(.{ O.i32_wrap_i64, set(L_RET) });
                    if (o.a == 1) {
                        b.i64c(pc + 4);
                        e.setX(30);
                    }
                    e.countIc(k);
                    e.exitRet();
                    return true;
                },
                .ldrlit => if (o.b <= 2) {
                    b.emit(.{ c32(0), mo(if (o.b == 1) O.i64_load else LD[2][o.b >> 1], @truncate(o.imm)) });
                    e.setX(o.rd);
                },
                .ldp => {
                    const kind = o.a & 3;
                    const opc = o.a >> 3;
                    e.getSP(o.rn);
                    if (kind != 1 and o.imm != 0) b.emit(.{ c64(@bitCast(o.imm)), O.i64_add });
                    e.address();
                    if (kind == 1 or kind == 3) {
                        e.getSP(o.rn);
                        b.emit(.{ c64(@bitCast(o.imm)), O.i64_add });
                        e.setSP(o.rn);
                    }
                    const sz: u32 = if (opc == 2) 3 else 2;
                    const load = o.a & 4 != 0;
                    const paired = !load and sz == 3;
                    if (paired) e.storeCheck(0, 16);
                    for ([_]u8{ o.rd, o.rm }, 0..) |t, i| {
                        const off = (@as(u32, 1) << @intCast(sz)) * @as(u32, @intCast(i));
                        if (load) {
                            b.emit(.{ get(L_A), mo(LD[sz][@intFromBool(opc == 1)], off) });
                            e.setX(t);
                        } else {
                            if (!paired) e.storeCheck(off, @as(u32, 1) << @intCast(sz));
                            b.get(L_A);
                            e.getX(t);
                            b.memop(ST[sz], off);
                        }
                    }
                },
                .ldst => {
                    const size: u5 = @intCast(o.b >> 2);
                    const opc = o.b & 3;
                    e.getSP(o.rn);
                    switch (o.a) {
                        0, 2 => if (o.imm != 0) b.emit(.{ c64(@bitCast(o.imm)), O.i64_add }),
                        3 => {
                            e.getX(o.rm);
                            switch (o.ra >> 1) {
                                2 => b.emit(.{ c64(0xffff_ffff), O.i64_and }),
                                6 => b.byte(O.i64_extend32_s),
                                else => {},
                            }
                            if (o.ra & 1 != 0 and size != 0) b.emit(.{ c64(size), O.i64_shl });
                            b.byte(O.i64_add);
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
                        b.emit(.{ c64(@bitCast(o.imm)), O.i64_add });
                        e.setSP(o.rn);
                    }
                    if (opc == 0 or (size == 3 and opc == 2)) {
                        e.storeCheck(0, @as(u32, 1) << size);
                        b.get(L_A);
                        e.getX(o.rd);
                        b.memop(ST[size], 0);
                    } else {
                        b.emit(.{ get(L_A), mo(LD[size][@intFromBool(opc != 1)], 0) });
                        if (opc == 3 and size < 3) b.emit(.{ c64(0xffff_ffff), O.i64_and });
                        e.setX(o.rd);
                    }
                },
                .ccmp => {
                    const kind: Pend = if (o.a & 1 != 0) .sub else .add;
                    e.cond(o.b);
                    e.eager(15);
                    b.blockStart(O.if_, wasm.VOID);
                    if (o.a & 4 != 0) {
                        e.getX(o.rn);
                        b.set(L_FA64);
                        if (o.a & 8 != 0) b.i64c(@bitCast(o.imm)) else e.getX(o.rm);
                        b.emit(.{ set(L_FB64), get(L_FA64), get(L_FB64), if (o.a & 1 != 0) O.i64_sub else O.i64_add, set(L_FR64) });
                        e.flagsOf(true, kind, 15);
                    } else {
                        e.getX(o.rn);
                        b.emit(.{ O.i32_wrap_i64, set(L_FA32) });
                        if (o.a & 8 != 0) b.i32c(@intCast(o.imm)) else {
                            e.getX(o.rm);
                            b.byte(O.i32_wrap_i64);
                        }
                        b.emit(.{ set(L_FB32), get(L_FA32), get(L_FB32), if (o.a & 1 != 0) O.i32_sub else O.i32_add, set(L_FR32) });
                        e.flagsOf(false, kind, 15);
                    }
                    b.byte(O.else_);
                    for ([_]u32{ L_N, L_Z, L_C, L_V }, 0..) |l, i| b.emit(.{ c32((o.ra >> @intCast(3 - i)) & 1), set(l) });
                    b.byte(O.end);
                },
                .csel => {
                    const opc = o.a & 1;
                    const op2 = (o.a >> 1) & 1;
                    e.getX(o.rn);
                    e.getX(o.rm);
                    if (opc == 0 and op2 == 1) b.emit(.{ c64(1), O.i64_add }) else if (opc == 1 and op2 == 0) b.emit(.{ c64(-1), O.i64_xor }) else if (opc == 1) b.emit(.{ set(L_T0), c64(0), get(L_T0), O.i64_sub });
                    e.cond(o.b);
                    b.byte(O.select);
                    if (o.a & 4 == 0) b.emit(.{ c64(0xffff_ffff), O.i64_and });
                    e.setX(o.rd);
                },
                .excl => {
                    const size: u2 = @intCast(o.a);
                    const o2 = o.b & 4 != 0;
                    const load = o.b & 2 != 0;
                    const o1 = o.b & 1 != 0;
                    if (o1 and !o2 and size < 2) {
                        e.fallback(pc, k);
                        return false;
                    }
                    e.getSP(o.rn);
                    e.address();
                    if (o1 and !o2) {
                        // LDXP/STXP: the pair beside the monitor, as the single-register forms
                        const step: u32 = if (size == 3) 8 else 4;
                        if (load) {
                            b.emit(.{ get(L_CPU), c32(1), mo(O.i32_store, OFF_EXCL), get(L_A), mo(LD[size][0], 0) });
                            e.setX(o.rd);
                            b.emit(.{ get(L_A), mo(LD[size][0], step) });
                            e.setX(o.ra);
                        } else {
                            b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_EXCL) });
                            e.ifv();
                            e.storeCheck(0, 2 * step);
                            b.get(L_A);
                            e.getX(o.rd);
                            b.memop(ST[size], 0);
                            b.get(L_A);
                            e.getX(o.ra);
                            b.memop(ST[size], step);
                            e.endif();
                            b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_EXCL), c32(1), O.i32_xor });
                            e.setW(o.rm);
                            b.emit(.{ get(L_CPU), c32(0), mo(O.i32_store, OFF_EXCL) });
                        }
                    } else if (o1) {
                        b.emit(.{ get(L_A), mo(LD[size][0], 0), set(L_T0), get(L_T0) });
                        e.getX(o.rm);
                        if (size < 3) b.emit(.{ c64(@bitCast((@as(u64, 1) << (@as(u6, 8) << size)) - 1)), O.i64_and });
                        b.byte(O.i64_eq);
                        e.ifv();
                        e.storeCheck(0, @as(u32, 1) << size);
                        b.get(L_A);
                        e.getX(o.rd);
                        b.memop(ST[size], 0);
                        e.endif();
                        b.get(L_T0);
                        e.setX(o.rm);
                    } else if (load) {
                        if (!o2) b.emit(.{ get(L_CPU), c32(1), mo(O.i32_store, OFF_EXCL) });
                        b.emit(.{ get(L_A), mo(LD[size][0], 0) });
                        e.setX(o.rd);
                    } else {
                        if (!o2) {
                            b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_EXCL) });
                            e.ifv();
                        }
                        e.storeCheck(0, @as(u32, 1) << size);
                        b.get(L_A);
                        e.getX(o.rd);
                        b.memop(ST[size], 0);
                        if (!o2) {
                            e.endif();
                            b.emit(.{ get(L_CPU), mo(O.i32_load, OFF_EXCL), c32(1), O.i32_xor });
                            e.setW(o.rm);
                            b.emit(.{ get(L_CPU), c32(0), mo(O.i32_store, OFF_EXCL) });
                        }
                    }
                },
                .mrs => if (o.imm == 0x5e82) {
                    b.emit(.{ get(L_CPU), mo(O.i64_load, OFF_TLS) });
                    e.setX(o.rd);
                } else e.fallback(pc, k),
                .one => {
                    e.getX(o.rn);
                    if (o.a & 8 != 0) {
                        emitOne(b, true, o.a & 7);
                        e.setX(o.rd);
                    } else {
                        b.byte(O.i32_wrap_i64);
                        emitOne(b, false, o.a & 7);
                        e.setW(o.rd);
                    }
                },
                .two => {
                    const opc = o.a & 63;
                    const sf = o.a & 64 != 0;
                    if (opc >= 16) {
                        e.fallback(pc, k);
                        return false;
                    }
                    e.getX(o.rn);
                    if (opc == 2 or opc == 3) {
                        e.getX(o.rm);
                        if (sf) e.divide(true, opc == 3) else e.divide(false, opc == 3);
                    } else if (sf) {
                        e.getX(o.rm);
                        b.byte(shiftOp(true, @intCast(opc - 8)));
                    } else {
                        b.byte(O.i32_wrap_i64);
                        e.getX(o.rm);
                        b.emit(.{ O.i32_wrap_i64, shiftOp(false, @intCast(opc - 8)) });
                    }
                    if (sf) e.setX(o.rd) else e.setW(o.rd);
                },
                .three => {
                    const op31 = o.a & 7;
                    const o0 = o.a & 8 != 0;
                    if (op31 == 0) {
                        e.getX(o.ra);
                        e.getX(o.rn);
                        e.getX(o.rm);
                        b.emit(.{ O.i64_mul, if (o0) O.i64_sub else O.i64_add });
                        if (o.a & 16 == 0) b.emit(.{ c64(0xffff_ffff), O.i64_and });
                        e.setX(o.rd);
                    } else if (op31 == 1 or op31 == 5) {
                        const ext: u8 = if (op31 == 1) O.i64_extend_i32_s else O.i64_extend_i32_u;
                        e.getX(o.ra);
                        e.getX(o.rn);
                        b.emit(.{ O.i32_wrap_i64, ext });
                        e.getX(o.rm);
                        b.emit(.{ O.i32_wrap_i64, ext, O.i64_mul, if (o0) O.i64_sub else O.i64_add });
                        e.setX(o.rd);
                    } else e.mulHigh(o.rd, o.rn, o.rm, op31 == 2);
                },
                .clrex => b.emit(.{ get(L_CPU), c32(0), mo(O.i32_store, OFF_EXCL) }),
                .simd => jitfp.emitSimd(e, @truncate(o.imm), pc, k),
                .vmem => jitmem.emitVmem(e, @truncate(o.imm), pc, k),
                .vldrlit => jitmem.emitVldrlit(e, o),
                else => e.fallback(pc, k),
            }
            return false;
        }
    };
}

fn rwOf(o: *const Op) RW {
    return switch (o.kind) {
        .nop, .clrex, .fault, .vldrlit => .{ .r = 0, .w = 0 },
        .bcond => .{ .r = 0, .w = 0, .fr = condReads(o.a) },
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
        .addsub => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd), .fw = if (o.a & 2 != 0) 15 else 0 },
        .logic => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd), .fw = if (o.a & 3 == 3) 15 else 0 },
        .bfm => .{ .r = bit(o.rn) | (if (o.a & 3 == 1) bit(o.rd) else 0), .w = bit(o.rd) },
        .extr, .two => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd) },
        .one => .{ .r = bit(o.rn), .w = bit(o.rd) },
        .three => .{ .r = bit(o.rn) | bit(o.rm) | bit(o.ra), .w = bit(o.rd) },
        .adc => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd), .fr = FC, .fw = if (o.a & 2 != 0) 15 else 0 },
        .ccmp => .{ .r = bit(o.rn) | bit(o.rm), .w = 0, .fr = condReads(o.b), .fw = 15 },
        .csel => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd), .fr = condReads(o.b) },
        .excl => blk: {
            const m = bit(o.rd) | bit(o.rd + 1) | bit(o.rn) | bit(o.rm) | bit(o.rm + 1) | bit(o.ra);
            break :blk .{ .r = m, .w = m };
        },
        .atomic => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rd) },
        .mrs => .{ .r = 0, .w = bit(o.rd), .fr = if (o.imm == 0x5a10) 15 else 0 },
        .msr => .{ .r = bit(o.rd), .w = 0, .fw = if (o.imm == 0x5a10) 15 else 0 },
        .vmem => .{ .r = bit(o.rn) | bit(o.rm), .w = bit(o.rn) },
        .simd => simdRw(@truncate(o.imm)),
        .svc, .raw => ALL,
    };
}
fn simdRw(w: u32) RW {
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast((w >> 5) & 31);
    if (w & 0x5f00_0000 == 0x1e00_0000) {
        if (w & 0x5f20_0000 == 0x1e00_0000 or w & 0x5f20_fc00 == 0x1e20_0000) {
            const opcode = (w >> 16) & 7;
            return if (opcode == 2 or opcode == 3 or opcode == 7) .{ .r = bit(rn), .w = 0 } else .{ .r = 0, .w = bit(rd) };
        }
        if (w & 0x5f20_3c00 == 0x1e20_2000) return .{ .r = 0, .w = 0, .fw = 15 };
        if (w & 0x5f20_0c00 == 0x1e20_0400) return .{ .r = 0, .w = 0, .fr = condReads(@intCast(bits(w, 12, 4))), .fw = 15 };
        if (w & 0x5f20_0c00 == 0x1e20_0c00) return .{ .r = 0, .w = 0, .fr = condReads(@intCast(bits(w, 12, 4))) };
        return .{ .r = 0, .w = 0 };
    }
    if (w & 0x9fe0_8400 == 0x0e00_0400 and w & 0x800 != 0) return if (w & 0x2000 != 0) .{ .r = 0, .w = bit(rd) } else .{ .r = bit(rn), .w = 0 };
    return .{ .r = 0, .w = 0 };
}

inline fn ilen(comptime isa: Isa, pc: u32) u32 {
    return if (isa == .thumb and (mem.ld(u16, pc) & 0xf800) < 0xe800) 2 else 4;
}
fn emitRegion(b: *Buf, r: *Region) void {
    switch (r.isa) {
        inline else => |isa| emitRegionAs(isa, b, r),
    }
}
fn emitRegionAs(comptime isa: Isa, b: *Buf, r: *Region) void {
    const wide = isa == .a64;
    var e = Emit(wide){ .b = b, .r = r, .blk = 0, .used = 0, .written = 0, .wcur = 0, .rw = if (wide) ALL else ALL32, .chain_depth = 0, .nest = 0 };
    const n = r.nblocks;
    var writes: [MAX_BLOCKS]u32 = undefined;
    var wb: [MAX_BLOCKS]u32 = undefined;
    var base: [MAX_BLOCKS]u32 = undefined;
    var fr: [MAX_INSTR]u4 = undefined;
    var fk: [MAX_INSTR]u4 = undefined;
    var t: u32 = 0;
    for (r.blocks[0..n], 0..) |blk, i| {
        writes[i] = 0;
        wb[i] = 0;
        base[i] = t;
        const page = blockPage(blk).?;
        var pc = blk.pc;
        var j: u32 = 0;
        while (j < blk.n) : (j += 1) {
            var rw = switch (isa) {
                .a64 => rwOf(&page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2]),
                .arm => jit32.rwArm(mem.ld(u32, pc)),
                .thumb => jit32.rwThumb(pc),
            };
            if (forcedFallback(pc)) rw = if (wide) ALL else ALL32;
            writes[i] |= rw.w;
            e.used |= rw.r | rw.w;
            assert(t < fr.len);
            fr[t] = rw.fr;
            fk[t] = if (rw.cond) 0 else rw.fw;
            t += 1;
            pc += ilen(isa, pc);
        }
        e.written |= writes[i];
    }
    var lin: [MAX_BLOCKS]u4 = [_]u4{0} ** MAX_BLOCKS;
    var changed = true;
    while (changed) {
        changed = false;
        var i: u32 = n;
        while (i > 0) {
            i -= 1;
            const blk = r.blocks[i];
            var l: u4 = if (blk.exits) 15 else 0;
            for ([_]i32{ blk.taken, blk.fall }) |x| l |= if (x >= 0) lin[@intCast(x)] else if (x == -1) 15 else 0;
            var j = blk.n;
            while (j > 0) {
                j -= 1;
                l = (l & ~fk[base[i] + j]) | fr[base[i] + j];
            }
            if (l != lin[i]) {
                lin[i] = l;
                changed = true;
            }
        }
    }
    e.lin = lin;
    var live: u4 = 0;
    for (lin[0..n]) |l| live |= l;
    if (wide) {
        changed = true;
        while (changed) {
            changed = false;
            for (r.blocks[0..n], 0..) |blk, i| {
                const out = wb[i] | writes[i];
                for ([_]i32{ blk.taken, blk.fall }) |x| if (x >= 0) {
                    const j: usize = @intCast(x);
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
    b.emit(.{ if (wide) @as(u8, 10) else 9, 32, if (wide) wasm.I64 else wasm.I32, 4, wasm.I32, 4, wasm.I64, 6, wasm.I32, 2, wasm.I64, 2, wasm.F64, 3, wasm.I64, 3, wasm.I32, 3, wasm.V128 });
    if (wide) b.emit(.{ 32, wasm.V128 });
    e.loadRegs(e.used);
    e.loadFlags(live);
    b.emit(.{ get(L_CPU), mo(O.i64_load, OFF_IC), set(L_IC), get(L_CPU), mo(O.i64_load, OFF_LIMIT), set(L_LIMIT), get(L_ENTRY), set(L_NEXT), O.block, wasm.VOID, O.block, wasm.VOID, O.loop, wasm.VOID });
    for (0..n) |_| b.blockStart(O.block, wasm.VOID);
    b.emit(.{ get(L_NEXT), O.br_table });
    b.u(n);
    for (0..n) |i| b.u(i);
    b.u(0);
    for (r.blocks[0..n], 0..) |blk, i| {
        b.byte(O.end);
        e.blk = @intCast(i);
        e.chain_depth = n - @as(u32, @intCast(i));
        e.wcur = wb[i];
        e.pk = .none;
        e.pdirty = 0;
        e.vloaded = 0;
        const page = blockPage(blk).?;
        var pc = blk.pc;
        var j: u32 = 0;
        var ended = false;
        while (j < blk.n) : (j += 1) {
            e.pc = pc;
            const len = ilen(isa, pc);
            const o = &page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2];
            if (wide) {
                e.rw = rwOf(o);
                e.wcur |= e.rw.w;
            }
            if (forcedFallback(pc)) {
                if (wide) e.rw = ALL;
                e.fallback(pc, j + 1);
                ended = false;
            } else ended = switch (isa) {
                .a64 => e.emitOp(o, pc, j + 1),
                .arm => jit32.emitArm(&e, pc, j + 1),
                .thumb => jit32.emitThumb(&e, pc, j + 1),
            };
            pc += len;
            if (ended) break;
        }
        if (!ended) e.transfer(blk.fall, if (isa == .thumb) pc | 1 else pc, blk.n);
    }
    b.emit(.{ O.end, O.end });
    e.storeIc();
    if (chain) chainTo(wide, &e);
    b.emit(.{ get(L_RET), O.return_, O.end });
    e.spillRegs(e.written);
    e.spillFlags();
    e.storeIc();
    b.emit(.{ get(L_RET), O.end });
}
fn chainTo(comptime wide: bool, e: *Emit(wide)) void {
    const b = e.b;
    b.emit(.{ O.block, wasm.VOID, get(L_RET), c32(abi.LOW), O.i32_lt_u, wasm.brIf(0), get(L_IC), get(L_LIMIT), O.i64_ge_s, wasm.brIf(0), get(L_RET), c32(abi.PAGE_SHIFT - 2), O.i32_shr_u, c32(-4), O.i32_and, mo(O.i32_load, cpu.DECODED), tee(L_A), O.i32_eqz, wasm.brIf(0), get(L_A), get(L_RET), c32(if (wide) abi.PAGE_SIZE - 1 else abi.PAGE_SIZE - 2), O.i32_and, c32(1), O.i32_shl, O.i32_add, mo(O.i32_load, OFF_SLOT), tee(L_B), O.i32_eqz, wasm.brIf(0) });
    if (!wide) b.emit(.{ get(L_CPU), get(L_CPU), mo(O.i32_load, OFF_CPSR), c32(~@as(i32, 1 << 5)), O.i32_and, get(L_RET), c32(1), O.i32_and, c32(5), O.i32_shl, O.i32_or, mo(O.i32_store, OFF_CPSR) });
    b.emit(.{ get(L_CPU), get(L_B), c32(255), O.i32_and, get(L_B), c32(8), O.i32_shr_u, O.return_call_indirect, 0, 0, O.end });
}

fn importFn(b: *Buf, name: []const u8, ty: u8) void {
    b.u(3);
    b.bytes("env");
    b.u(@intCast(name.len));
    b.bytes(name);
    b.emit(.{ 0, ty });
}
export fn jit_emit(out: u32, cap: u32) u32 {
    if (in_flight) return 0;
    nregions = 0;
    var q: u32 = 0;
    while (q < nrequests) : (q += 1) {
        const pc = requests[q];
        const r = &regions[nregions];
        r.* = .{ .entry = pc, .isa = request_isa[q], .nblocks = 0, .blocks = undefined };
        if (blockFor(r, pc) == 0 and discover(r)) nregions += 1;
    }
    nrequests = 0;
    // A batch too large for the buffer is halved until it fits; the regions left out go back on
    // the queue rather than waiting for their entries' heat to wrap around.
    var n = nregions;
    while (n != 0) : (n /= 2) {
        var b = Buf.init(out, cap);
        emitModule(&b, n);
        if (b.overflow) continue;
        for (regions[n..nregions]) |r| _ = request(r.entry, r.isa);
        nregions = n;
        in_flight = true;
        return b.len;
    }
    nregions = 0;
    return 0;
}
fn emitModule(b: *Buf, n: u32) void {
    b.bytes(&[_]u8{ 0, 'a', 's', 'm', 1, 0, 0, 0, 1 });
    const type_len = b.reserve();
    const type_start = b.len;
    b.bytes(&[_]u8{ 5, 0x60, 2, wasm.I32, wasm.I32, 1, wasm.I32, 0x60, 3, wasm.I32, wasm.I32, wasm.I32, 1, wasm.I32, 0x60, 2, wasm.F32, wasm.F32, 1, wasm.F32, 0x60, 2, wasm.F64, wasm.F64, 1, wasm.F64, 0x60, 3, wasm.F64, wasm.F64, wasm.F64, 1, wasm.F64 });
    b.patch(type_len, b.len - type_start);
    b.byte(2);
    const imp_len = b.reserve();
    const imp_start = b.len;
    b.u(2 + N_IMPORTS);
    b.u(3);
    b.bytes("env");
    b.u(6);
    b.bytes("memory");
    // the core's memory, as the host made it: a shared one declares its maximum (65535 pages)
    b.bytes(if (shared) &[_]u8{ 0x02, 0x03, 1, 0xff, 0xff, 0x03 } else &[_]u8{ 0x02, 0x00, 1 });
    b.u(3);
    b.bytes("env");
    b.u(25);
    b.bytes("__indirect_function_table");
    b.bytes(&[_]u8{ 0x01, 0x70, 0x00, 0 });
    importFn(b, "exec", 1);
    importFn(b, "store", 1);
    importFn(b, "exec32", 0);
    inline for ([_][]const u8{ "32", "64" }, 2..) |sfx, ty| inline for (FP_NAMES) |nm| importFn(b, nm ++ sfx, ty);
    importFn(b, "fma64", 4);
    importFn(b, "it32", 1);
    importFn(b, "tx", 0);
    importFn(b, "estimate32", 0);
    b.patch(imp_len, b.len - imp_start);
    b.byte(3);
    b.u(1 + n);
    b.u(n);
    for (0..n) |_| b.byte(0);
    b.byte(7);
    const exp_len = b.reserve();
    const exp_start = b.len;
    b.u(n);
    for (0..n) |i| {
        var name: [8]u8 = undefined;
        name[0] = 'r';
        const len = 1 + std.fmt.printInt(name[1..], i, 10, .lower, .{});
        b.u(len);
        b.bytes(name[0..len]);
        b.byte(0);
        b.u(N_IMPORTS + i);
    }
    b.patch(exp_len, b.len - exp_start);
    b.byte(10);
    const code_len = b.reserve();
    const code_start = b.len;
    b.u(n);
    for (regions[0..n]) |*r| {
        const body_len = b.reserve();
        const body_start = b.len;
        emitRegion(b, r);
        b.patch(body_len, b.len - body_start);
    }
    b.patch(code_len, b.len - code_start);
}
