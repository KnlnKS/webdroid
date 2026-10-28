const std = @import("std");
const assert = std.debug.assert;

// The guest address map and the rules the core shares with the host, which scripts/generated.ts also
// gives TS (src/native/core-abi.gen.ts): every `pub const` here must be an integer expression JS
// evaluates alike.
pub const PAGE_SHIFT = 12;
pub const PAGE_SIZE: u32 = 1 << PAGE_SHIFT;
/// The first 64 KiB is never mapped: a null-ish pointer faults instead of reading zeros.
pub const LOW: u32 = 0x1_0000;
/// The running thread's Cpu, in that never-mapped first 64 KiB: run_slice copies a thread's state in
/// and out, so a JIT region addresses it at constant offsets the engine folds into its accesses.
pub const CPU_CUR: u32 = 0x1000;
// Every fixed region sits at the bottom, each starting where the last ended. Above them the malloc
// arena, mappings, ELF images and (ARM64) the planes' pool units share the pages, each taking the
// lowest free run, so the memory grows from 256 MiB only as far as pages are in use, within the
// process address space its first native image sets: 2 GiB for ARM32, or the whole 32-bit space a
// wasm memory can back for ARM64 (mem.init from setA64).
pub const STACK_BASE: u32 = 0x0010_0000;
/// Thread stacks, 1 MiB and a 64 KiB guard gap each: 60 of them, then arena pages.
pub const STACK_END: u32 = STACK_BASE + 0x0400_0000;
/// Host-owned guest data: __sF, _ctype_, JNI tables, static strings, program headers.
pub const HOST_DATA: u32 = STACK_END;
pub const HOST_DATA_END: u32 = HOST_DATA + 0x0008_0000;
/// Host-call trampolines, 8 bytes per slot.
pub const TRAMP_BASE: u32 = HOST_DATA_END;
pub const TRAMP_END: u32 = TRAMP_BASE + 0x0007_0000;
/// The lr Cpu.call plants; reaching it as pc ends the call. The last trampoline slot, never defined.
pub const RET_SENTINEL: u32 = TRAMP_END - 8;
/// The core's page tables and JIT buffer (mem.zig, cpu.zig, jit.zig).
pub const KERN_BASE: u32 = TRAMP_END;
pub const KERN_END: u32 = KERN_BASE + 0x00c0_0000;
pub const ARENA_BASE: u32 = KERN_END;
pub const MEM_SIZE_INITIAL: u32 = 0x1000_0000;
pub const MEM_SIZE_A32: u32 = 0x8000_0000;
/// 4 GiB less a page: the whole 32-bit space a WebAssembly memory can back.
pub const MEM_SIZE_A64: u32 = 0xffff_0000;
/// An ARM32 process's addresses from its memory's end up are a window onto the pool its processes
/// share (src/native/shm.ts): each shared mapping there shows a run of a region's pool pages.
pub const WINDOW: u32 = MEM_SIZE_A32;
pub const WINDOW_SIZE: u32 = MEM_SIZE_A64 - WINDOW;
/// page_flags of a page no guest store lands on directly: the core's own data, a stack's guard gap,
/// pages not yet backed, and every page of the window, whose bytes the host serves
pub const PAGE_GUARD: u32 = 2;
/// page_flags of a window page a mapping shows, and of one mprotect left without access
pub const PAGE_MAPPED: u32 = 4;
pub const PAGE_NOACCESS: u32 = 8;
/// page_flags of a page mprotect left without PROT_WRITE, in a process's own memory or the window
pub const PAGE_READONLY: u32 = 16;
/// page_flags of a page the host watches: the first store to it clears the flag (cpu.code_write), so the
/// host learns which pages changed since it last set it (host-visible Vulkan memory, vulkan/submit.ts)
pub const PAGE_WATCH: u32 = 32;
pub const STACK_SIZE: u32 = 0x10_0000;
pub const STACK_GUARD: u32 = 0x1_0000;

// A page-indexed table is indexed by `address >> PAGE_SHIFT` for an arbitrary u32, not by a count
// derived from the live memory size, so a wild address lands inside the table rather than in the
// next one. That is why these are sized for the whole 32-bit space and not for MEM_SIZE_A64.
pub const PAGE_INDEX_MAX: u32 = 1 << (32 - PAGE_SHIFT);
/// One host-call trampoline per 8 bytes of the trampoline span.
pub const TRAMP_SLOTS: u32 = (TRAMP_END - TRAMP_BASE) / 8;
/// Entries in the host's `__indirect_function_table`, the core's own below JIT_SLOT0 and JIT regions' above.
pub const JIT_SLOTS: u32 = 1 << 18;
pub const JIT_SLOT0: u32 = 8192;
/// what a region returns to hand the instruction at the Cpu's pc to the interpreter (cpu.RegionExit),
/// as a lane's table slot does until the lane links the slot's region (lanes.ts)
pub const REGION_INTERPRET: u32 = 4;
/// Instruction forms the JIT's fallback census tells apart (cpu.zig), a power of two.
pub const FALLBACK_FORMS: u32 = 1 << 10;

// The kernel region, one table after another. Each base is the previous base plus what the
// previous table needs, so widening an entry moves everything after it instead of overwriting it;
// the owning module asserts its own element size against the span it was given.
pub const KERN_PAGES: u32 = KERN_BASE;
pub const KERN_PAGE_FLAGS: u32 = KERN_PAGES + PAGE_INDEX_MAX * 1;
pub const KERN_BIG_LEN: u32 = KERN_PAGE_FLAGS + PAGE_INDEX_MAX * 1;
pub const KERN_DECODED: u32 = KERN_BIG_LEN + PAGE_INDEX_MAX * 4;
pub const KERN_SLOT_FN: u32 = KERN_DECODED + PAGE_INDEX_MAX * 4;
pub const KERN_REFS: u32 = KERN_SLOT_FN + 0x4_0000;
pub const KERN_REFS_END: u32 = KERN_REFS + JIT_SLOTS * 1;
/// The JIT's emit buffer, carved off the top of the kernel region.
pub const JIT_BUF: u32 = KERN_END - 0x0010_0000;

/// The entries of a block before the JIT takes it, the most its u8 heat holds (jit.zig).
pub const JIT_HEAT = 255;
/// clock_gettime: REALTIME, REALTIME_COARSE and REALTIME_ALARM read the wall clock; every other
/// clock is the guest's uptime, Java's System.nanoTime (libc.zig, kernel.ts clockTime).
pub const WALL_CLOCKS: u32 = (1 << 0) | (1 << 5) | (1 << 8);

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
    assert(KERN_SLOT_FN + TRAMP_SLOTS <= KERN_REFS);
    assert(KERN_REFS_END <= JIT_BUF);
    assert(JIT_BUF < KERN_END);
    // Every guest address is a page index this table can hold, in either ABI.
    assert(MEM_SIZE_A64 >> PAGE_SHIFT <= PAGE_INDEX_MAX);
}
