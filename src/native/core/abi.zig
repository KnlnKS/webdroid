const std = @import("std");
const assert = std.debug.assert;

pub const PAGE_SHIFT = 12;
pub const PAGE_SIZE: u32 = 1 << PAGE_SHIFT;
pub const LOW: u32 = 0x1_0000;
pub const STACK_BASE: u32 = 0x0010_0000;
pub const STACK_END: u32 = STACK_BASE + 0x0400_0000;
pub const HOST_DATA: u32 = STACK_END;
pub const HOST_DATA_END: u32 = HOST_DATA + 0x0008_0000;
pub const TRAMP_BASE: u32 = HOST_DATA_END;
pub const TRAMP_END: u32 = TRAMP_BASE + 0x0007_0000;
pub const RET_SENTINEL: u32 = TRAMP_END - 8;
pub const KERN_BASE: u32 = TRAMP_END;
pub const KERN_END: u32 = KERN_BASE + 0x00c0_0000;
pub const ARENA_BASE: u32 = KERN_END;
pub const MEM_SIZE_INITIAL: u32 = 0x1000_0000;
pub const MEM_SIZE_A32: u32 = 0x8000_0000;
pub const MEM_SIZE_A64: u32 = 0xffff_0000;
pub const POOL_BASE: u32 = 0xa000_0000;
pub const STACK_SIZE: u32 = 0x10_0000;
pub const STACK_GUARD: u32 = 0x1_0000;

// A page-indexed table is indexed by `address >> PAGE_SHIFT` for an arbitrary u32, not by a count
// derived from the live memory size, so a wild address lands inside the table rather than in the
// next one. That is why these are sized for the whole 32-bit space and not for MEM_SIZE_A64.
pub const PAGE_INDEX_MAX: u32 = 1 << (32 - PAGE_SHIFT);
/// One host-call trampoline per 8 bytes of the trampoline span.
pub const TRAMP_SLOTS: u32 = (TRAMP_END - TRAMP_BASE) / 8;
/// Entries in the host's `__indirect_function_table`; src/native/core.ts spells it TABLE_SIZE.
pub const JIT_SLOTS: u32 = 1 << 18;

// The kernel region, one table after another. Each base is the previous base plus what the
// previous table needs, so widening an entry moves everything after it instead of overwriting it;
// the owning module asserts its own element size against the span it was given.
pub const KERN_PAGES: u32 = KERN_BASE;
pub const KERN_PAGE_FLAGS: u32 = KERN_PAGES + PAGE_INDEX_MAX * 1;
pub const KERN_BIG_LEN: u32 = KERN_PAGE_FLAGS + PAGE_INDEX_MAX * 1;
pub const KERN_DECODED: u32 = KERN_BIG_LEN + PAGE_INDEX_MAX * 4;
pub const KERN_SLOT_FN: u32 = KERN_DECODED + PAGE_INDEX_MAX * 4;
pub const KERN_DEAD: u32 = KERN_SLOT_FN + 0x4_0000;
pub const KERN_DEAD_END: u32 = KERN_DEAD + JIT_SLOTS * 1;
/// The JIT's emit buffer, carved off the top of the kernel region; src/native/abi.ts spells it too.
pub const JIT_BUF: u32 = KERN_END - 0x0010_0000;

/// A check that survives ReleaseFast, which is the build that ships. `assert` is the right tool
/// for an invariant the core owns -- it costs nothing here and the ReleaseSafe build the tests run
/// still catches it -- but an argument arriving from the host is not ours to assume, and these
/// entry points are called once per bind or per region install, never in a loop.
pub inline fn require(ok: bool, comptime what: []const u8) void {
    if (!ok) @panic(what);
}

comptime {
    assert(LOW % PAGE_SIZE == 0);
    assert(STACK_BASE >= LOW);
    assert(MEM_SIZE_A32 < MEM_SIZE_A64);
    assert(ARENA_BASE < MEM_SIZE_A32);
    // The tables are the only thing between KERN_BASE and the emit buffer, and the emit buffer is
    // the only thing between them and KERN_END.
    assert(KERN_SLOT_FN + TRAMP_SLOTS <= KERN_DEAD);
    assert(KERN_DEAD_END <= JIT_BUF);
    assert(JIT_BUF < KERN_END);
    // Every guest address is a page index this table can hold, in either ABI.
    assert(MEM_SIZE_A64 >> PAGE_SHIFT <= PAGE_INDEX_MAX);
}
