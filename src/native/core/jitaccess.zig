//! A region's guest memory accesses: the checks that keep an access inline, and the hand-back to
//! the interpreter (Emit.interpretHere) for anything they do not cover, which repeats the access
//! and faults, translates or invalidates as it needs.
const abi = @import("abi.zig");
const mem = @import("mem.zig");
const jit = @import("jit.zig");
const wasm = @import("wasm.zig");
const O = wasm.Op;
const get = wasm.get;
const set = wasm.set;
const tee = wasm.tee;
const c32 = wasm.c32;
const c64 = wasm.c64;
const mo = wasm.mo;
const L_A = jit.L_A;
const L_B = jit.L_B;
const L_R = jit.L_R;
const L_T0 = jit.L_T0;
const L_NEXT = jit.L_NEXT;
const L_RET = jit.L_RET;
const FLAGS_BASE = @intFromPtr(mem.page_flags);

pub fn Access(comptime wide: bool) type {
    return struct {
        const Emit = jit.Emit(wide);

        /// L_A goes to the interpreter below LOW, past ARM32's 2 GiB (signed, as arm.addr) or, with
        /// a nonzero mask, when misaligned.
        pub fn checkAddress(e: *Emit, align_mask: u32) void {
            const b = e.b;
            b.emit(.{ get(L_A), c32(abi.LOW), O.i32_lt_s });
            if (align_mask != 0) b.emit(.{ get(L_A), c32(@intCast(align_mask)), O.i32_and, O.i32_or });
            interpretIf(e);
        }
        pub fn checkLowAddress(e: *Emit) void {
            checkAddress(e, 0);
        }
        /// The A64 address on the stack into L_A: one whose bits 32-55 are clear is its own offset,
        /// one inside a plane's committed prefix is translated inline, and any other goes to the
        /// interpreter. The untranslated address stays in L_T0.
        pub fn address(e: *Emit) void {
            const b = e.b;
            b.emit(.{ tee(L_T0), c64(8), O.i64_shl, c64(40), O.i64_shr_u, O.i32_wrap_i64, tee(L_B) });
            e.ifOf(wasm.I32);
            b.emit(.{ get(L_B), c32(255), O.i32_and, c32(2), O.i32_shl, set(L_NEXT), get(L_T0), O.i32_wrap_i64, get(L_NEXT), mo(O.i32_load, @intFromPtr(&mem.L)), O.i32_sub, tee(L_R), get(L_NEXT), mo(O.i32_load, @intFromPtr(&mem.S)), O.i32_ge_u, get(L_B), c32(255), O.i32_gt_u, O.i32_or });
            interpretIf(e);
            b.emit(.{ get(L_NEXT), mo(O.i32_load, @intFromPtr(&mem.P)), get(L_R), O.i32_add, O.else_, get(L_T0), O.i32_wrap_i64 });
            e.endif();
            b.emit(.{ tee(L_A), c32(abi.LOW), O.i32_lt_u });
            interpretIf(e);
        }
        /// A code, guard or read-only page under a store of `size` bytes at L_A + off takes it to
        /// the interpreter.
        pub fn storeCheck(e: *Emit, off: u32, size: u32) void {
            guardStore(e, off, size, null);
        }
        /// as storeCheck, for the contiguous stores of `size` bytes from L_A + off
        pub fn rangeCheck(e: *Emit, off: u32, size: u32) void {
            rangeFlags(e, off, size);
            interpretIf(e);
        }
        /// ARM32's store of L_R at L_A + off by store opcode `o`, through the window where a window
        /// page is flagged.
        pub fn storeTo(e: *Emit, o: u8, off: u32) void {
            guardStore(e, off, accessSize(o), o);
        }
        /// ARM32's load at L_A + off by load opcode `o`: below LOW only a window page can be read.
        pub fn loadFrom(e: *Emit, o: u8, off: u32) void {
            const b = e.b;
            b.emit(.{ get(L_A), c32(abi.LOW), O.i32_lt_s });
            b.unlikely();
            e.ifOf(wasm.I32);
            windowAccess(e, o, off, accessSize(o), false);
            b.byte(O.else_);
            b.emit(.{ get(L_A), mo(o, off) });
            e.endif();
        }

        fn interpretIf(e: *Emit) void {
            e.coldIf();
            e.interpretHere();
            e.endif();
        }
        /// The store check: a store of 2, 4 or 8 bytes stays on its first page unless misaligned, so
        /// that page's flags and the misalignment decide it inline and the last page's only out of
        /// line. A flagged store goes to the interpreter, or with `window` (ARM32's store of L_R by
        /// that opcode) through the window, and is stored inline otherwise.
        fn guardStore(e: *Emit, off: u32, size: u32, window: ?u8) void {
            const b = e.b;
            const approx = size == 2 or size == 4 or size == 8;
            if (approx) {
                storeAddress(e, off);
                pageFlags(e);
                b.emit(.{ tee(L_RET), get(storeAt(off)), c32(@intCast(size - 1)), O.i32_and, O.i32_or });
            } else rangeFlags(e, off, size);
            e.coldIf();
            if (approx) {
                b.emit(.{ get(storeAt(off)), c32(@intCast(size - 1)), O.i32_add });
                pageFlags(e);
                b.emit(.{ get(L_RET), O.i32_or });
                e.ifv();
            }
            if (window) |o| windowAccess(e, o, off, size, true) else e.interpretHere();
            if (window) |o| {
                if (approx) {
                    b.byte(O.else_);
                    store(e, o, off);
                    e.endif();
                }
                b.byte(O.else_);
                store(e, o, off);
            } else if (approx) e.endif();
            e.endif();
        }
        /// L_R at the L_A + off a check left in storeAt: a sum past 4 GiB wraps there to a guard
        /// page, so the check has passed only where it equals the memarg's.
        fn store(e: *Emit, o: u8, off: u32) void {
            e.b.emit(.{ get(storeAt(off)), get(L_R), mo(o, 0) });
        }
        /// The value (a load) or the store of L_R at window address L_A + off, inline: a call here
        /// would make the engine spill the registers around the inline access the window path
        /// branches from. The page flags let it reach the first and last bytes' pages, so one run of
        /// the pool (window.ts), at the offset the window table gives, which a realm whose pool came
        /// after the module has none of. Anything else is the interpreter's.
        fn windowAccess(e: *Emit, o: u8, off: u32, size: u32, is_store: bool) void {
            const b = e.b;
            if (!mem.hasWindow()) return e.interpretHere();
            const mask: i32 = @intCast(abi.PAGE_MAPPED | abi.PAGE_NOACCESS | (if (is_store) abi.PAGE_READONLY else 0));
            b.emit(.{ get(L_A), c32(@bitCast(off)), O.i32_add, tee(L_NEXT) });
            pageFlags(e);
            b.emit(.{ c32(mask), O.i32_and, c32(abi.PAGE_MAPPED), O.i32_ne });
            if (size > 1) {
                b.emit(.{ get(L_NEXT), c32(@intCast(size - 1)), O.i32_add });
                pageFlags(e);
                b.emit(.{ c32(mask), O.i32_and, c32(abi.PAGE_MAPPED), O.i32_ne, O.i32_or });
            }
            // the table's word offset from a shift of its own, which leaves pageFlags' to fold
            b.emit(.{ get(L_NEXT), c32(abi.PAGE_SHIFT - 2), O.i32_shr_u, c32((mem.WINDOW_PAGES - 1) << 2), O.i32_and, c32(0), mo(O.i32_load, @intFromPtr(&mem.window_table)), O.i32_add, mo(O.i32_load, 0),
                get(L_NEXT), c32(abi.PAGE_SIZE - 1), O.i32_and, O.i32_add, tee(L_RET), c32(@intCast(size)), O.i32_add, O.memory_size, 1, c32(16), O.i32_shl, O.i32_gt_u, O.i32_or });
            interpretIf(e);
            b.get(L_RET);
            if (is_store) b.get(L_R);
            b.emit(.{wasm.Mo{ .op = o, .off = 0, .mem = 1 }});
        }
        /// the page flags of the first and last bytes of `size` at L_A + off, ORed
        fn rangeFlags(e: *Emit, off: u32, size: u32) void {
            const b = e.b;
            storeAddress(e, off);
            pageFlags(e);
            if (size > 1) {
                b.emit(.{ get(storeAt(off)), c32(@intCast(size - 1)), O.i32_add });
                pageFlags(e);
                b.byte(O.i32_or);
            }
        }
        fn storeAddress(e: *Emit, off: u32) void {
            if (off != 0) e.b.emit(.{ get(L_A), c32(@bitCast(off)), O.i32_add, tee(L_NEXT) }) else e.b.get(L_A);
        }
        fn storeAt(off: u32) u32 {
            return if (off != 0) L_NEXT else L_A;
        }
        /// The page flags of the address on the stack. The table's base is an i32 add rather than a
        /// memarg offset, so the engine folds the shift into it where no other use shares the shift.
        fn pageFlags(e: *Emit) void {
            e.b.emit(.{ c32(abi.PAGE_SHIFT), O.i32_shr_u, c32(@intCast(FLAGS_BASE)), O.i32_add, mo(O.i32_load8_u, 0) });
        }
    };
}

fn accessSize(o: u8) u32 {
    return switch (o) {
        O.i32_load8_s, O.i32_load8_u, O.i32_store8 => 1,
        O.i32_load16_s, O.i32_load16_u, O.i32_store16 => 2,
        else => 4,
    };
}
