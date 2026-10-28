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

// A batch holds the process's one JS thread 8–21 ms (emit, module compile, lazy function compiles),
// so startup code entered a few dozen times stays interpreted.
pub const HEAT = abi.JIT_HEAT;
const MAX_BLOCKS = 40;
const MAX_INSTR = 640;
const MAX_REGIONS = 64;
/// calls a region runs as host calls, nested, within the host's stack
const MAX_DEPTH = 32;
/// A module's function types, by index. A region's: (cpu, entry block, ret_to, depth) -> the pc to go
/// on at, or a RegionExit.
const Ty = enum(u8) { ii_i, iii_i, ff_f, dd_d, ddd_d, region };
const TYPES = [_][]const u8{
    &.{ 0x60, 2, wasm.I32, wasm.I32, 1, wasm.I32 },
    &.{ 0x60, 3, wasm.I32, wasm.I32, wasm.I32, 1, wasm.I32 },
    &.{ 0x60, 2, wasm.F32, wasm.F32, 1, wasm.F32 },
    &.{ 0x60, 2, wasm.F64, wasm.F64, 1, wasm.F64 },
    &.{ 0x60, 3, wasm.F64, wasm.F64, wasm.F64, 1, wasm.F64 },
    &.{ 0x60, 4, wasm.I32, wasm.I32, wasm.I32, wasm.I32, 1, wasm.I32 },
};
const T_REGION = @intFromEnum(Ty.region);

pub const L_CPU = 0;
const L_ENTRY = 1;
/// the continuation of the innermost call this region runs within, and how many calls nest there
const L_RET_TO = 2;
const L_DEPTH = 3;
// The locals, in the groups of one type emitRegionAs declares.
pub const L_X = L_DEPTH + 1;
pub const L_N = L_X + 32;
pub const L_Z = L_N + 1;
pub const L_C = L_N + 2;
pub const L_V = L_N + 3;
pub const L_T0 = L_N + 4;
pub const L_T1 = L_T0 + 1;
pub const L_T2 = L_T0 + 2;
pub const L_T3 = L_T0 + 3;
pub const L_A = L_T0 + 4;
pub const L_B = L_A + 1;
pub const L_R = L_A + 2;
pub const L_NEXT = L_A + 3;
pub const L_RET = L_A + 4;
pub const L_SC = L_A + 5;
pub const L_IC = L_A + 6;
pub const L_LIMIT = L_IC + 1;
pub const L_F0 = L_IC + 2;
pub const L_F1 = L_F0 + 1;
pub const L_FA64 = L_F0 + 2;
pub const L_FB64 = L_FA64 + 1;
pub const L_FR64 = L_FA64 + 2;
pub const L_FA32 = L_FA64 + 3;
pub const L_FB32 = L_FA32 + 1;
pub const L_FR32 = L_FA32 + 2;
pub const L_VA = L_FA32 + 3;
pub const L_VB = L_VA + 1;
pub const L_VC = L_VA + 2;
/// A64's V registers
pub const L_VREG = L_VA + 3;
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
const F_EXEC32 = 1;
pub const F_FMAX32 = 2;
pub const F_FMA64 = 10;
const F_IT32 = 11;
pub const F_ESTIMATE32 = 12;
const N_IMPORTS = 13;
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
/// arm_neon.neonMisc runs it.
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
    // jit_install packs the block index into the low byte of page.slot, the table slot above it, and
    // a slot's entries are counted in a byte (cpu.refs).
    assert(MAX_BLOCKS < 256);
}

const OFF_X = @offsetOf(Cpu, "x");
const OFF_CPSR = @offsetOf(Cpu, "cpsr");
const OFF_IC = @offsetOf(Cpu, "ic");
const OFF_LIMIT = @offsetOf(Cpu, "ic_limit");
const OFF_EXCL = @offsetOf(Cpu, "excl");
const OFF_TLS = @offsetOf(Cpu, "tls");
const OFF_SLOT = @offsetOf(cpu.Page, "slot");
/// bit 0: the engine has tail calls; bit 1: the host's memory is shared
var chain: bool = false;
var shared: bool = false;
export fn jit_config(c: u32) void {
    chain = c & 1 != 0;
    shared = c & 2 != 0;
}

pub const Isa = enum(u8) { a64 = 0, arm = 1, thumb = 2 };
/// epoch: its page's when it was scanned; installation and cross-page edges validate it.
/// cont: the block a call that ends it goes on at when the callee returns.
pub const Block = struct { pc: u32, epoch: u32, n: u32, taken: i32, fall: i32, exits: bool, cont: i32 = -1 };
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
/// Enters region i's blocks in a free table slot and returns it, for the host to link the region there:
/// 0 when a block's page changed since it was compiled, or no block has an instruction. A full table
/// is flushed first (cpu.freeSlot), uninstalling every region, this batch's earlier ones included.
export fn jit_install(i: u32) u32 {
    abi.require(i < nregions, "jit_install: region index out of range");
    const r = &regions[i];
    for (r.blocks[0..r.nblocks]) |b| if ((blockPage(b) orelse return 0).epoch != b.epoch) return 0;
    // An empty block only exits to its own pc, so installing one would hand that pc straight back
    // to a region that cannot advance it.
    for (r.blocks[0..r.nblocks]) |b| {
        if (b.n != 0) break;
    } else return 0;
    const slot = cpu.freeSlot();
    for (r.blocks[0..r.nblocks], 0..) |b, k| if (b.n != 0) {
        cpu.setSlot(&blockPage(b).?.slot[(b.pc & (abi.PAGE_SIZE - 1)) >> 1], (slot << 8) | @as(u32, @intCast(k)));
    };
    regions_installed += 1;
    return slot;
}
export fn jit_done() void {
    in_flight = false;
    nregions = 0;
}

/// whether the interpreter has entered pc or a region holds it
fn observed(page: *cpu.Page, pc: u32) bool {
    const at = (pc & (abi.PAGE_SIZE - 1)) >> 1;
    return page.heat[at] != 0 or page.slot[at] != 0;
}
fn blockPage(b: Block) ?*cpu.Page {
    return cpu.decodedPage(b.pc >> abi.PAGE_SHIFT);
}
/// Blocks may lie on any page the interpreter has decoded. Each block stays within its page;
/// a Thumb instruction that straddles pages is left to the interpreter.
pub fn blockFor(r: *Region, pc: u32) i32 {
    for (r.blocks[0..r.nblocks], 0..) |b, i| if (b.pc == pc) return @intCast(i);
    if (r.nblocks >= MAX_BLOCKS) return -1;
    const page = cpu.decodedPage(pc >> abi.PAGE_SHIFT) orelse return -1;
    // A decoded page may contain cold branch targets. Cross it only at an observed entry,
    // rather than increasing ARM32's register and code footprint for paths that never ran.
    if (r.isa != .a64 and (pc ^ r.entry) >> abi.PAGE_SHIFT != 0 and !observed(page, pc)) return -1;
    r.blocks[r.nblocks] = .{ .pc = pc, .epoch = page.epoch, .n = 0, .taken = -2, .fall = -2, .exits = false };
    r.nblocks += 1;
    return @intCast(r.nblocks - 1);
}
/// A call brings in its continuation rather than its callee, which runs in a region of its own,
/// once a return has reached it: what follows a call that never returns is data or other code.
pub fn addCall(r: *Region, i: u32, next: u32) void {
    const page = cpu.decodedPage(next >> abi.PAGE_SHIFT) orelse return;
    if (observed(page, next)) r.blocks[i].cont = blockFor(r, next);
}
fn scanA64(r: *Region, i: u32, page: *cpu.Page, pc: u32) jit32.Scan {
    const o = a64.opAt(page, pc);
    const next = pc + 4;
    const ends = switch (o.kind) {
        // ISB must redispatch after a store invalidates the active region's source page.
        .nop => mem.ld(u32, pc) & 0xfffff0ff == 0xd50330df,
        .b => blk: {
            if (o.a != 0) addCall(r, i, next) else r.blocks[i].taken = blockFor(r, @truncate(o.imm));
            break :blk true;
        },
        .bcond, .cbz, .tbz => blk: {
            r.blocks[i].taken = blockFor(r, @truncate(o.imm));
            r.blocks[i].fall = blockFor(r, next);
            break :blk true;
        },
        .br => blk: {
            if (o.a == 1) addCall(r, i, next);
            break :blk true;
        },
        .svc, .fault => true,
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
            // An instruction straddling pages depends on both pages' epochs: leave it to the interpreter.
            if ((pc & (abi.PAGE_SIZE - 1)) == abi.PAGE_SIZE - 2 and ilen(.thumb, pc) == 4) {
                r.blocks[i].fall = -1;
                break;
            }
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
    return r.blocks[0].n != 0;
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
        /// the registers the region reads or writes, which its locals hold from the prologue on
        used: u32 = 0,
        /// those it writes, which the epilogue stores
        dirty: u32 = 0,
        rw: RW,
        chain_depth: u32,
        nest: u32,
        pk: Pend = .none,
        term: bool = false,
        lin: [MAX_BLOCKS]u4 = undefined,
        pw: bool = false,
        pdirty: u4 = 0,
        vloaded: u32 = 0,
        /// the ITSTATE of the compiled IT body being emitted, which a hand-back gives the interpreter
        it: u8 = 0,
        /// b.nwrites when the instruction at pc began
        wstart: u32 = 0,
        vcachedWrite: bool = false,

        const A = @import("jitaccess.zig").Access(wide);
        pub const checkAddress = A.checkAddress;
        pub const checkLowAddress = A.checkLowAddress;
        pub const address = A.address;
        pub const storeCheck = A.storeCheck;
        pub const rangeCheck = A.rangeCheck;
        pub const storeTo = A.storeTo;
        pub const loadFrom = A.loadFrom;

        /// the instruction at pc begins
        pub fn begin(e: *Self, pc: u32) void {
            e.pc = pc;
            e.wstart = e.b.nwrites;
        }
        pub fn ifv(e: *Self) void {
            e.ifOf(wasm.VOID);
        }
        /// an `if` of result type `ty`, which endif closes
        pub fn ifOf(e: *Self, ty: u8) void {
            e.b.blockStart(O.if_, ty);
            e.nest += 1;
        }
        /// an `if` whose body runs rarely (a hand-back or exit), which the engine lays out of line
        pub fn coldIf(e: *Self) void {
            e.b.unlikely();
            e.ifv();
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
        fn addSP(e: *Self, n: u8, imm: u64) void {
            e.getSP(n);
            e.b.emit(.{ c64(@bitCast(imm)), O.i64_add });
            e.setSP(n);
        }
        /// a pre-index's new base, the untranslated address address() left in L_T0, or a post-index's
        fn ldstWriteback(e: *Self, o: *const Op) void {
            if (o.a == 2) {
                e.b.get(L_T0);
                e.setSP(o.rn);
            } else if (o.a == 1) e.addSP(o.rn, o.imm);
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
        /// the used registers from memory into their locals, or the dirty ones back; neither is a
        /// use of a register by the region's code
        fn moveRegs(e: *Self, comptime dir: enum { load, store }) void {
            const watched = e.b.nwatch;
            defer e.b.nwatch = watched;
            e.b.nwatch = 0;
            const mask = if (dir == .load) e.used else e.dirty;
            var n: u8 = 0;
            while (n < 32) : (n += 1) if (mask & bit(n) != 0) {
                const off = OFF_X + 8 * @as(u32, n);
                if (dir == .load) e.b.emit(.{ get(L_CPU), mo(W(wide, O.i32_load), off), set(L_X + n) }) else e.b.emit(.{ get(L_CPU), get(L_X + n), mo(W(wide, O.i32_store), off) });
            };
        }
        /// A call out of the region keeps no register local live across it, which would make the
        /// engine spill that local at every definition: the written ones are stored before and all
        /// reloaded after, which a helper that executes an instruction needs anyway.
        pub fn callOut(e: *Self, f: u32) void {
            e.moveRegs(.store);
            e.b.call(f);
            e.moveRegs(.load);
        }
        /// NZCV and, on ARM32, the T bit of this region's state: a chain from a region of the other
        /// state leaves it stale until here, where anything that reads it next comes after
        fn spillFlags(e: *Self) void {
            e.b.emit(.{ get(L_CPU), get(L_CPU), mo(O.i32_load, OFF_CPSR), c32(if (wide) 0x0fff_ffff else 0x0fff_ffdf), O.i32_and });
            if (!wide and e.r.isa == .thumb) e.b.emit(.{ c32(1 << 5), O.i32_or });
            e.b.emit(.{ get(L_N), c32(31), O.i32_shl, O.i32_or, get(L_Z), c32(30), O.i32_shl, O.i32_or, get(L_C), c32(29), O.i32_shl, O.i32_or, get(L_V), c32(28), O.i32_shl, O.i32_or, mo(O.i32_store, OFF_CPSR) });
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
        /// to the region's one epilogue, which spills the flag locals: a pending compare's flags
        /// are written to them first, without settling it for the code that goes on past this exit
        pub fn exit(e: *Self) void {
            e.writePending();
            e.b.br(e.chain_depth + 1 + e.nest);
        }
        fn writePending(e: *Self) void {
            if (e.pdirty != 0) {
                if (wide and e.pw) e.flagsOf(true, e.pk, e.pdirty) else e.flagsOf(false, e.pk, e.pdirty);
            }
        }
        /// A branch out of the region to `pc` chains from here rather than from the shared epilogue:
        /// the lookup reads constant addresses, and the engine predicts each site's indirect call
        /// from that site alone.
        fn leave(e: *Self, pc: u32) void {
            const b = e.b;
            if (!chain) return e.exitTo(pc);
            e.moveRegs(.store);
            e.spillFlags();
            e.storeIc();
            b.emit(.{ O.block, wasm.VOID, get(L_IC), get(L_LIMIT), O.i64_ge_s, wasm.brIf(0), get(L_RET_TO), c32(@bitCast(pc)), O.i32_eq, wasm.brIf(0) });
            slotOf(b, wide, pc);
            callSlot(b, null);
            b.emit(.{ O.end, c32(@bitCast(pc)), O.return_ });
        }
        pub fn exitTo(e: *Self, pc: u32) void {
            e.b.emit(.{ c32(@bitCast(pc)), set(L_RET) });
            e.exit();
        }
        pub fn exitToInterpreter(e: *Self, pc: u32, k: u32) void {
            e.settle(15);
            e.countIc(k);
            e.b.emit(.{ get(L_CPU), c64(pc & ~@as(u32, 1)), mo(O.i64_store, @offsetOf(cpu.Cpu, "pc")), c32(@intFromEnum(cpu.RegionExit.jump)), set(L_RET) });
            e.exit();
        }
        pub fn transfer(e: *Self, target: i32, pc: u32, k: u32) void {
            e.settle(e.edge(target));
            e.countIc(k);
            if (target < 0) return e.leave(pc);
            const to = e.r.blocks[@intCast(target)];
            // A store may since have dropped the page the target was compiled from.
            if ((to.pc ^ e.r.blocks[e.blk].pc) >> abi.PAGE_SHIFT != 0) {
                e.stale(to);
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
        /// whether the page block `to` was compiled from has since been dropped or changed
        fn stale(e: *Self, to: Block) void {
            const page = @intFromPtr(blockPage(to).?);
            e.b.emit(.{ c32(0), mo(O.i32_load, cpu.DECODED + (to.pc >> abi.PAGE_SHIFT) * 4), c32(@bitCast(page)), O.i32_ne,
                c32(0), mo(O.i32_load, page + @offsetOf(cpu.Page, "epoch")), c32(@bitCast(to.epoch)), O.i32_ne, O.i32_or });
        }
        /// A call to `target`, or to L_RET's address when null, runs the callee's region as a host
        /// call with the continuation `ret` as its ret_to, which the regions it chains to pass on
        /// and return at: the host's call and return then predict the guest's, and the region goes
        /// on at its continuation block. Without a region for the callee, budget or depth it leaves.
        pub fn call(e: *Self, target: ?u32, ret: u32, k: u32) void {
            const b = e.b;
            e.settle(15);
            e.countIc(k);
            if (target) |t| b.emit(.{ c32(@bitCast(t)), set(L_RET) });
            const c = e.r.blocks[e.blk].cont;
            if (c < 0 or e.r.blocks[@intCast(c)].n == 0) return e.exit();
            const to = e.r.blocks[@intCast(c)];
            e.moveRegs(.store);
            e.spillFlags();
            e.storeIc();
            b.emit(.{ O.block, wasm.VOID });
            e.nest += 1;
            slotOf(b, wide, null);
            b.emit(.{ get(L_IC), get(L_LIMIT), O.i64_ge_s, wasm.brIf(0), get(L_DEPTH), c32(MAX_DEPTH), O.i32_ge_u, wasm.brIf(0) });
            callSlot(b, ret);
            b.set(L_RET);
            // Anywhere else, or code the callee rewrote, is the outer frames' to go on at: they hold
            // no state the callee's regions have not stored.
            b.emit(.{ get(L_RET), c32(@bitCast(ret)), O.i32_ne });
            e.stale(to);
            b.byte(O.i32_or);
            b.unlikely();
            b.emit(.{ O.if_, wasm.VOID, get(L_RET), O.return_, O.end });
            e.moveRegs(.load);
            e.loadFlags(e.lin[@intCast(c)]);
            b.emit(.{ get(L_CPU), mo(O.i64_load, OFF_IC), set(L_IC) });
            e.vloaded = 0;
            const blk: i32 = @intCast(e.blk);
            if (c > blk) b.br(@as(u32, @intCast(c - blk - 1)) + e.nest) else {
                b.emit(.{ c32(c), set(L_NEXT) });
                b.br(e.chain_depth - 1 + e.nest);
            }
            e.nest -= 1;
            b.byte(O.end);
            e.exit();
        }
        /// exit to pc if the condition on the stack holds
        fn guardedExit(e: *Self, pc: u32) void {
            e.coldIf();
            // The exit may settle flags the target does not read; the path past it reads none.
            const term = e.term;
            e.term = true;
            e.exitTo(pc);
            e.term = term;
            e.endif();
        }
        pub fn fallback(e: *Self, pc: u32, k: u32) void {
            const b = e.b;
            if (e.rw.fr | e.rw.fw != 0) {
                e.settle(15);
                e.spillFlags();
            }
            if (wide) b.emit(.{ get(L_CPU), c32(@bitCast(mem.ld(u32, pc))), c32(@bitCast(pc)) }) else b.emit(.{ get(L_CPU), c32(@bitCast(pc)) });
            e.callOut(if (wide) F_EXEC else F_EXEC32);
            b.set(L_R);
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
            e.spillFlags();
            e.countIc(k - 1);
            e.storeIc();
            b.emit(.{ get(L_CPU), c32(@bitCast(pc)), c32(@bitCast(end)) });
            e.callOut(F_IT32);
            b.set(L_R);
            e.loadFlags(15);
            e.eager(15);
            b.emit(.{ get(L_CPU), mo(O.i64_load, OFF_IC), set(L_IC), get(L_R) });
            e.ifv();
            b.emit(.{ get(L_R), set(L_RET) });
            e.exit();
            e.endif();
        }
        /// to the interpreter at this instruction, which repeats its access and faults, translates
        /// or invalidates as the access needs: the epilogue stores the registers' locals, so the
        /// instruction must write none before its last check (a store's writeback comes after it)
        pub fn interpretHere(e: *Self) void {
            assert(e.b.nwrites == e.wstart);
            e.writePending();
            if (e.it != 0) {
                const it: u32 = e.it;
                e.b.emit(.{ get(L_CPU), get(L_CPU), mo(O.i32_load, OFF_CPSR), c32(~@as(i32, 0x3f << 10 | 3 << 25)), O.i32_and, c32(@intCast((it >> 2) << 10 | (it & 3) << 25)), O.i32_or, mo(O.i32_store, OFF_CPSR) });
            }
            e.b.emit(.{ c32(@bitCast(e.pc)), set(L_RET) });
            e.b.br(e.chain_depth + e.nest);
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
                    if (o.a == 0) {
                        e.transfer(e.r.blocks[e.blk].taken, @truncate(o.imm), k);
                        return true;
                    }
                    b.i64c(pc + 4);
                    e.setX(30);
                    e.call(@truncate(o.imm), pc + 4, k);
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
                    if (o.a != 1) {
                        e.countIc(k);
                        e.exit();
                        return true;
                    }
                    b.i64c(pc + 4);
                    e.setX(30);
                    e.call(null, pc + 4, k);
                    return true;
                },
                .ldrlit => if (o.b <= 2) {
                    b.emit(.{ c32(0), mo(if (o.b == 1) O.i64_load else LD[2][o.b >> 1], @truncate(o.imm)) });
                    e.setX(o.rd);
                },
                .ldp => {
                    const kind = o.a & 3;
                    const opc = o.a >> 3;
                    const load = o.a & 4 != 0;
                    const writeback = kind == 1 or kind == 3;
                    e.getSP(o.rn);
                    if (kind != 1 and o.imm != 0) b.emit(.{ c64(@bitCast(o.imm)), O.i64_add });
                    e.address();
                    const sz: u32 = if (opc == 2) 3 else 2;
                    if (!load) e.rangeCheck(0, @as(u32, 2) << @intCast(sz));
                    // a load's base before its destinations, a store's after its sources
                    if (writeback and load) e.addSP(o.rn, o.imm);
                    for ([_]u8{ o.rd, o.rm }, 0..) |t, i| {
                        const off = (@as(u32, 1) << @intCast(sz)) * @as(u32, @intCast(i));
                        if (load) {
                            b.emit(.{ get(L_A), mo(LD[sz][@intFromBool(opc == 1)], off) });
                            e.setX(t);
                        } else {
                            b.get(L_A);
                            e.getX(t);
                            b.memop(ST[sz], off);
                        }
                    }
                    if (writeback and !load) e.addSP(o.rn, o.imm);
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
                    e.address();
                    if (opc == 0 or (size == 3 and opc == 2)) {
                        e.storeCheck(0, @as(u32, 1) << size);
                        b.get(L_A);
                        e.getX(o.rd);
                        b.memop(ST[size], 0);
                        e.ldstWriteback(o);
                    } else {
                        b.emit(.{ get(L_A), mo(LD[size][@intFromBool(opc != 1)], 0) });
                        if (opc == 3 and size < 3) b.emit(.{ c64(0xffff_ffff), O.i64_and });
                        // before the destination, which may be the base
                        e.ldstWriteback(o);
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
                            e.rangeCheck(0, 2 * step);
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
    var e = Emit(wide){ .b = b, .r = r, .blk = 0, .rw = if (wide) ALL else ALL32, .chain_depth = 0, .nest = 0 };
    const n = r.nblocks;
    var base: [MAX_BLOCKS]u32 = undefined;
    var fr: [MAX_INSTR]u4 = undefined;
    var fk: [MAX_INSTR]u4 = undefined;
    var t: u32 = 0;
    for (r.blocks[0..n], 0..) |blk, i| {
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
            assert(t < fr.len);
            fr[t] = rw.fr;
            fk[t] = if (rw.cond) 0 else rw.fw;
            t += 1;
            pc += ilen(isa, pc);
        }
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
    // The registers the region uses live in locals from the prologue to the epilogue, which stores
    // those it writes; a helper that executes an instruction gets them stored first. The emitters
    // name registers only through their locals (XZR is a constant), so emitting each block once into
    // a buffer that keeps nothing finds them.
    var dry = Buf.init(abi.LOW, 0);
    dry.watch = L_X;
    dry.nwatch = if (wide) 32 else 15;
    var d = e;
    d.b = &dry;
    for (0..n) |i| emitBlock(isa, &d, @intCast(i));
    e.used = dry.reads | dry.writes;
    e.dirty = dry.writes;
    b.emit(.{ if (wide) @as(u8, 10) else 9, L_N - L_X, if (wide) wasm.I64 else wasm.I32, L_T0 - L_N, wasm.I32, L_A - L_T0, wasm.I64, L_IC - L_A, wasm.I32, L_F0 - L_IC, wasm.I64, L_FA64 - L_F0, wasm.F64, L_FA32 - L_FA64, wasm.I64, L_VA - L_FA32, wasm.I32, L_VREG - L_VA, wasm.V128 });
    if (wide) b.emit(.{ 32, wasm.V128 });
    b.watch = L_X;
    b.nwatch = if (wide) 32 else 15;
    // run_slice passes the running Cpu, which is always CPU_CUR: as a constant it folds into offsets
    b.emit(.{ c32(abi.CPU_CUR), set(L_CPU) });
    e.loadFlags(live);
    e.moveRegs(.load);
    b.emit(.{ get(L_CPU), mo(O.i64_load, OFF_IC), set(L_IC), get(L_CPU), mo(O.i64_load, OFF_LIMIT), set(L_LIMIT), get(L_ENTRY), set(L_NEXT), O.block, wasm.VOID, O.block, wasm.VOID, O.loop, wasm.VOID });
    for (0..n) |_| b.blockStart(O.block, wasm.VOID);
    b.emit(.{ get(L_NEXT), O.br_table });
    b.u(n);
    for (0..n) |i| b.u(i);
    b.u(0);
    for (0..n) |i| {
        b.byte(O.end);
        emitBlock(isa, &e, @intCast(i));
    }
    // an instruction the interpreter takes over from, its pc in L_RET
    b.emit(.{ wasm.Br{ .depth = 2 }, O.end, O.end, get(L_CPU), get(L_RET), O.i64_extend_i32_u, mo(O.i64_store, @offsetOf(Cpu, "pc")), c32(@intFromEnum(cpu.RegionExit.interpret)), set(L_RET), O.end });
    e.moveRegs(.store);
    e.spillFlags();
    e.storeIc();
    if (chain) chainTo(b, wide);
    b.emit(.{ get(L_RET), O.end });
}
fn emitBlock(comptime isa: Isa, e: *Emit(isa == .a64), i: u32) void {
    const wide = isa == .a64;
    const blk = e.r.blocks[i];
    e.blk = i;
    e.chain_depth = e.r.nblocks - i;
    e.pk = .none;
    e.pdirty = 0;
    e.vloaded = 0;
    const page = blockPage(blk).?;
    var pc = blk.pc;
    var j: u32 = 0;
    var ended = false;
    while (j < blk.n) : (j += 1) {
        e.begin(pc);
        const len = ilen(isa, pc);
        const o = &page.ops[(pc & (abi.PAGE_SIZE - 1)) >> 2];
        if (wide) e.rw = rwOf(o);
        if (forcedFallback(pc)) {
            if (wide) e.rw = ALL;
            e.fallback(pc, j + 1);
            ended = false;
        } else ended = switch (isa) {
            .a64 => e.emitOp(o, pc, j + 1),
            .arm => jit32.emitArm(e, pc, j + 1),
            .thumb => jit32.emitThumb(e, pc, j + 1),
        };
        pc += len;
        if (ended) break;
    }
    if (!ended) e.transfer(blk.fall, if (isa == .thumb) pc | 1 else pc, blk.n);
}
/// The page.slot entry of the region holding `pc`, or L_RET's address when null, into L_B (its table
/// slot above its block), or out of the enclosing block when none does. A known pc reads constant
/// addresses.
fn slotOf(b: *Buf, comptime wide: bool, pc: ?u32) void {
    const mask = if (wide) abi.PAGE_SIZE - 1 else abi.PAGE_SIZE - 2;
    if (pc) |p| b.emit(.{ c32(0), mo(O.i32_load, cpu.DECODED + (p >> abi.PAGE_SHIFT) * 4), tee(L_A), O.i32_eqz, wasm.brIf(0), get(L_A), mo(O.i32_load, OFF_SLOT + ((p & mask) << 1)) }) else b.emit(.{ get(L_RET), c32(abi.PAGE_SHIFT - 2), O.i32_shr_u, c32(-4), O.i32_and, mo(O.i32_load, cpu.DECODED), tee(L_A), O.i32_eqz, wasm.brIf(0), get(L_A), get(L_RET), c32(mask), O.i32_and, c32(1), O.i32_shl, O.i32_add, mo(O.i32_load, OFF_SLOT) });
    b.emit(.{ tee(L_B), O.i32_eqz, wasm.brIf(0) });
}
/// The region in L_B's slot at its block: a tail call within this region's call, or a call one
/// deeper whose continuation is `ret`.
fn callSlot(b: *Buf, ret: ?u32) void {
    b.emit(.{ get(L_CPU), get(L_B), c32(255), O.i32_and });
    if (ret) |r| b.emit(.{ c32(@bitCast(r)), get(L_DEPTH), c32(1), O.i32_add }) else b.emit(.{ get(L_RET_TO), get(L_DEPTH) });
    b.emit(.{ get(L_B), c32(8), O.i32_shr_u, if (ret != null) O.call_indirect else O.return_call_indirect, T_REGION, 0 });
}
/// A status, or the continuation of the call that runs this region, returns; another pc goes on
/// in its region within the budget.
fn chainTo(b: *Buf, comptime wide: bool) void {
    b.emit(.{ O.block, wasm.VOID, get(L_RET), c32(abi.LOW), O.i32_lt_u, wasm.brIf(0), get(L_RET), get(L_RET_TO), O.i32_eq, wasm.brIf(0), get(L_IC), get(L_LIMIT), O.i64_ge_s, wasm.brIf(0) });
    slotOf(b, wide, null);
    callSlot(b, null);
    b.byte(O.end);
}

fn importFn(b: *Buf, name: []const u8, ty: Ty) void {
    b.u(3);
    b.bytes("env");
    b.u(@intCast(name.len));
    b.bytes(name);
    b.emit(.{ 0, @intFromEnum(ty) });
}
export fn jit_emit(out: u32, cap: u32) u32 {
    if (in_flight) return 0;
    nregions = 0;
    var q: u32 = 0;
    while (q < nrequests) : (q += 1) {
        const pc = requests[q];
        // A block that heated while its function's entry waited here is already in that region.
        if (inBatch(pc)) continue;
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
fn inBatch(pc: u32) bool {
    for (regions[0..nregions]) |*r| for (r.blocks[0..r.nblocks]) |b| if (b.pc == pc and b.n != 0) return true;
    return false;
}
fn emitModule(b: *Buf, n: u32) void {
    const window = mem.hasWindow();
    b.bytes(&[_]u8{ 0, 'a', 's', 'm', 1, 0, 0, 0, 1 });
    const type_len = b.reserve();
    const type_start = b.len;
    b.u(TYPES.len);
    inline for (TYPES) |t| b.bytes(t);
    b.patch(type_len, b.len - type_start);
    b.byte(2);
    const imp_len = b.reserve();
    const imp_start = b.len;
    b.u(2 + N_IMPORTS + @as(u32, @intFromBool(window)));
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
    importFn(b, "exec", .iii_i);
    importFn(b, "exec32", .ii_i);
    inline for ([_][]const u8{ "32", "64" }, [_]Ty{ .ff_f, .dd_d }) |sfx, ty| inline for (FP_NAMES) |nm| importFn(b, nm ++ sfx, ty);
    importFn(b, "fma64", .ddd_d);
    importFn(b, "it32", .iii_i);
    importFn(b, "estimate32", .ii_i);
    if (window) {
        // the pool that window pages show (window.ts), up to WINDOW_SIZE
        b.u(3);
        b.bytes("env");
        b.u(4);
        b.bytes("pool");
        b.bytes(if (shared) &[_]u8{ 0x02, 0x03, 0, 0xff, 0xff, 0x01 } else &[_]u8{ 0x02, 0x01, 0, 0xff, 0xff, 0x01 });
    }
    b.patch(imp_len, b.len - imp_start);
    b.byte(3);
    b.u(1 + n);
    b.u(n);
    for (0..n) |_| b.byte(T_REGION);
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
    const code = b.len;
    b.byte(10);
    const code_len = b.reserve();
    const code_start = b.len;
    b.u(n);
    b.cold = &cold;
    b.ncold = 0;
    var body: [MAX_REGIONS]u32 = undefined;
    for (regions[0..n], 0..) |*r, i| {
        const body_len = b.reserve();
        body[i] = b.len;
        emitRegion(b, r);
        b.patch(body_len, b.len - body[i]);
    }
    b.patch(code_len, b.len - code_start);
    b.branchHints(code, body[0..n], N_IMPORTS);
}
var cold: [1 << 15]u32 = undefined;
