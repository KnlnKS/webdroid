const jit = @import("jit.zig");
const wasm = @import("wasm.zig");
const a64 = @import("a64.zig");
const bt = @import("bits.zig");
const is = bt.is;
const bits = bt.bits;
const Emit = jit.Emit(true);
const O = wasm.Op;
const S = wasm.Simd;
const get = wasm.get;
const c64 = wasm.c64;
const mo = wasm.mo;
const sv = wasm.simd;
const vm = wasm.vm;
const L_A = jit.L_A;
const vreg = @import("jitreg.zig");
const vget = vreg.vget;
const vput = vreg.vput;
/// integer loads of 1 << size bytes into the i32 or i64 a lane takes
const LANE_LD = [4]u8{ O.i32_load8_u, O.i32_load16_u, O.i32_load, O.i64_load };

fn emitVlane(e: *Emit, w: u32) bool {
    const b = e.b;
    const rt: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    const q = bits(w, 30, 1);
    const Ld = bits(w, 22, 1) != 0;
    const post = bits(w, 23, 1) != 0;
    const opcode = bits(w, 13, 3);
    const Sb = bits(w, 12, 1);
    const size = bits(w, 10, 2);
    const regs = 1 + bits(w, 21, 1) + (opcode & 1) * 2;
    var esz: u32 = undefined;
    var idx: u32 = 0;
    if (opcode >= 6) {
        if (!Ld or Sb != 0) return false;
        esz = size;
    } else {
        const scale = opcode >> 1;
        esz = if (scale == 0) 0 else if (scale == 1) 1 else if (size & 1 != 0) 3 else 2;
        idx = switch (esz) {
            0 => (q << 3) | (Sb << 2) | size,
            1 => (q << 2) | (Sb << 1) | (size >> 1),
            2 => (q << 1) | Sb,
            else => q,
        };
    }
    e.getSP(rn);
    e.address();
    if (opcode < 6 and !Ld) e.rangeCheck(0, @as(u32, @intCast(regs)) << @intCast(esz));
    for (0..regs) |i| {
        const t: u8 = @intCast((rt + i) & 31);
        const off: u32 = @as(u32, @intCast(i)) << @intCast(esz);
        if (opcode >= 6) {
            b.emit(.{ get(L_A), vm(S.load8_splat + @as(u8, @intCast(esz)), off) });
            vput(e, t, q != 0);
        } else if (Ld) {
            vget(e, t);
            b.emit(.{ get(L_A), mo(LANE_LD[esz], off), sv(S.replace[esz]), @as(u8, @intCast(idx)) });
            vput(e, t, true);
        } else {
            b.get(L_A);
            vget(e, t);
            b.emit(.{ vm(S.store8_lane + @as(u8, @intCast(esz)), off), @as(u8, @intCast(idx)) });
        }
    }
    if (post) {
        e.getSP(rn);
        if (rm == 31) b.i64c(@as(i64, @intCast(regs)) << @intCast(esz)) else e.getX(rm);
        b.byte(O.i64_add);
        e.setSP(rn);
    }
    return true;
}

/// Vt's load of 1 << sz bytes at `off` from the address on the stack, the bytes above them cleared
fn vloadFrom(e: *Emit, t: u8, off: u32, sz: u32) void {
    if (sz < 2) {
        e.b.memop(LANE_LD[sz], off);
        return vreg.vputScalar(e, t, false, false);
    }
    e.b.emit(.{vm(switch (sz) {
        2 => S.load32_zero,
        3 => S.load64_zero,
        else => S.load,
    }, off)});
    vput(e, t, true);
}
fn vload(e: *Emit, t: u8, off: u32, sz: u32) void {
    e.b.get(L_A);
    vloadFrom(e, t, off, sz);
}
/// the store of V`t` at L_A + off, which its caller's storeCheck or rangeCheck covers
fn vstore(e: *Emit, t: u8, off: u32, sz: u32) void {
    const b = e.b;
    b.get(L_A);
    vget(e, t);
    if (sz == 4) {
        b.emit(.{vm(S.store, off)});
        return;
    }
    b.emit(.{ vm(S.store8_lane + @as(u8, @intCast(sz)), off), 0 });
}
pub fn emitVldrlit(e: *Emit, o: *const a64.Op) void {
    e.b.i32c(0);
    vloadFrom(e, o.rd, @truncate(o.imm), 2 + o.b);
}
pub fn emitVmem(e: *Emit, w: u32, pc: u32, k: u32) void {
    const b = e.b;
    const rt: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const rm: u8 = @intCast(bits(w, 16, 5));
    if (is(w, 0xbfbf0000, 0x0c000000) or is(w, 0xbfa00000, 0x0c800000)) {
        const q = bits(w, 30, 1) != 0;
        const size = bits(w, 10, 2);
        if (bits(w, 12, 4) == 8 and (q or size < 3)) {
            const es: usize = @as(usize, 1) << @intCast(size);
            const count: usize = (if (q) @as(usize, 16) else 8) / es;
            e.getSP(rn);
            e.address();
            if (bits(w, 22, 1) != 0) {
                for (0..2) |reg| {
                    var lanes: [16]u8 = [_]u8{0} ** 16;
                    for (0..count) |i| for (0..es) |j| {
                        lanes[i * es + j] = @intCast((2 * i + reg) * es + j);
                    };
                    b.emit(.{ get(L_A), vm(S.load, 0), get(L_A), vm(S.load, if (q) 16 else 0), sv(S.shuffle) });
                    b.bytes(&lanes);
                    vput(e, @intCast((rt + reg) & 31), q);
                }
            } else {
                e.rangeCheck(0, if (q) 32 else 16);
                for (0..if (q) @as(usize, 2) else 1) |chunk| {
                    const off: u32 = @intCast(chunk * 16);
                    var lanes: [16]u8 = undefined;
                    for (0..16) |i| {
                        const pos = chunk * 16 + i;
                        const element = pos / (2 * es);
                        const reg = (pos / es) & 1;
                        lanes[i] = @intCast(reg * 16 + element * es + pos % es);
                    }
                    b.get(L_A);
                    vget(e, rt);
                    vget(e, (rt + 1) & 31);
                    b.emit(.{sv(S.shuffle)});
                    b.bytes(&lanes);
                    b.emit(.{vm(S.store, off)});
                }
            }
            if (bits(w, 23, 1) != 0) {
                e.getSP(rn);
                if (rm == 31) b.i64c(if (q) 32 else 16) else e.getX(rm);
                b.byte(O.i64_add);
                e.setSP(rn);
            }
            return;
        }
        const regs: u32 = switch (bits(w, 12, 4)) {
            7 => 1,
            10 => 2,
            6 => 3,
            2 => 4,
            else => return e.fallback(pc, k),
        };
        const sz: u32 = 3 + bits(w, 30, 1);
        const width = @as(u32, 1) << @intCast(sz);
        e.getSP(rn);
        e.address();
        if (bits(w, 22, 1) == 0) e.rangeCheck(0, regs * width);
        for (0..regs) |i| {
            const t: u8 = @intCast((rt + i) & 31);
            const off = @as(u32, @intCast(i)) * width;
            if (bits(w, 22, 1) != 0) vload(e, t, off, sz) else vstore(e, t, off, sz);
        }
        if (bits(w, 23, 1) != 0) {
            e.getSP(rn);
            if (rm == 31) b.i64c(regs * width) else e.getX(rm);
            b.byte(O.i64_add);
            e.setSP(rn);
        }
        return;
    }
    if (is(w, 0xbf9f0000, 0x0d000000) or is(w, 0xbf800000, 0x0d800000)) {
        if (!emitVlane(e, w)) e.fallback(pc, k);
        return;
    }
    if (is(w, 0x3a000000, 0x28000000)) {
        const opc = bits(w, 30, 2);
        if (opc == 3) return e.fallback(pc, k);
        const Ld = bits(w, 22, 1) != 0;
        const sz = 2 + opc;
        const width = @as(u32, 1) << @intCast(sz);
        const off: i64 = bt.sx(i64, bits(w, 15, 7), 7) * width;
        const kind = bits(w, 23, 2);
        const rt2: u8 = @intCast(bits(w, 10, 5));
        e.getSP(rn);
        if (kind != 1 and off != 0) b.emit(.{ c64(off), O.i64_add });
        e.address();
        if (Ld) {
            vload(e, rt, 0, sz);
            vload(e, rt2, width, sz);
        } else {
            e.rangeCheck(0, 2 * width);
            vstore(e, rt, 0, sz);
            vstore(e, rt2, width, sz);
        }
        if (kind == 1 or kind == 3) {
            e.getSP(rn);
            b.emit(.{ c64(off), O.i64_add });
            e.setSP(rn);
        }
        return;
    }
    const size = bits(w, 30, 2);
    const opc = bits(w, 22, 2);
    if (opc & 2 != 0 and size != 0) return e.fallback(pc, k);
    const scale: u32 = if (opc & 2 != 0) 4 else size;
    const unsigned = is(w, 0x3b000000, 0x39000000);
    const reg = is(w, 0x3b200c00, 0x38200800);
    const kind = if (unsigned or reg) 0 else bits(w, 10, 2);
    if (kind == 2) return e.fallback(pc, k);
    e.getSP(rn);
    var post: i64 = 0;
    if (unsigned) {
        const imm = bits(w, 10, 12) << @intCast(scale);
        if (imm != 0) b.emit(.{ c64(imm), O.i64_add });
    } else if (reg) {
        e.getX(rm);
        switch (bits(w, 13, 3)) {
            2 => b.emit(.{ c64(0xffff_ffff), O.i64_and }),
            6 => b.byte(O.i64_extend32_s),
            else => {},
        }
        if (bits(w, 12, 1) != 0 and scale != 0) b.emit(.{ c64(scale), O.i64_shl });
        b.byte(O.i64_add);
    } else {
        const imm9 = bt.sx(i64, bits(w, 12, 9), 9);
        if (kind == 1) post = imm9 else if (imm9 != 0) b.emit(.{ c64(imm9), O.i64_add });
    }
    e.address();
    if (opc & 1 != 0) vload(e, rt, 0, scale) else {
        e.storeCheck(0, @as(u32, 1) << @intCast(scale));
        vstore(e, rt, 0, scale);
    }
    // address() leaves a pre-index's new base in L_T0
    if (kind == 3) {
        b.get(jit.L_T0);
        e.setSP(rn);
    } else if (post != 0) {
        e.getSP(rn);
        b.emit(.{ c64(post), O.i64_add });
        e.setSP(rn);
    }
}
