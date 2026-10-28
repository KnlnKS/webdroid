const jit = @import("jit.zig");
const jitvec = @import("jitvec.zig");
const wasm = @import("wasm.zig");
const bt = @import("bits.zig");
const vreg = @import("jitreg.zig");
const is = bt.is;
const bits = bt.bits;
const Emit = jit.Emit(true);
const O = wasm.Op;
const S = wasm.Simd;
const sv = wasm.simd;
const vget = vreg.vget;
const vput = vreg.vput;

/// Advanced SIMD scalar: lane 0 of the vector form with Q set, the rest of Vd cleared, for the forms whose
/// lane 0 depends on no other lane and that set no FPSR.QC; DUP (element) and the pairwise forms directly
pub fn emitScalar(e: *Emit, w: u32) bool {
    const b = e.b;
    const rd: u8 = @intCast(w & 31);
    const rn: u8 = @intCast(bits(w, 5, 5));
    const U = bits(w, 29, 1) != 0;
    const size = bits(w, 22, 2);
    const fv = size & 2 != 0;
    const f: u1 = @intCast(size & 1);
    if (is(w, 0xffe0_fc00, 0x5e00_0400)) {
        const imm5 = bits(w, 16, 5);
        if (imm5 & 15 == 0) return false;
        const esz: u32 = @ctz(imm5);
        vget(e, rn);
        b.emit(.{ sv(S.extract_u[esz]), @as(u8, @intCast(imm5 >> @intCast(esz + 1))) });
        vreg.vputScalar(e, rd, esz == 3, false);
        return true;
    }
    if (is(w, 0xdf3e_0c00, 0x5e30_0800)) {
        const opcode = bits(w, 12, 5);
        if (!U) {
            if (opcode != 27 or size != 3) return false;
            for (0..2) |i| {
                vget(e, rn);
                b.emit(.{ sv(S.extract_s[3]), @as(u8, @intCast(i)) });
            }
            b.emit(.{O.i64_add});
            vreg.vputScalar(e, rd, true, false);
            return true;
        }
        if (opcode != 12 and opcode != 13 and opcode != 15 or opcode == 13 and fv) return false;
        for (0..2) |i| {
            vget(e, rn);
            b.emit(.{ sv(S.fextract[f]), @as(u8, @intCast(i)) });
        }
        // FMAXP and FMINP (opcode 15) and their NM forms (12) take the scalar FMAX family's semantics
        if (opcode == 13) b.emit(.{wasm.F.add[f]}) else b.call(jit.F_FMAX32 + 4 * @as(u32, f) + @as(u32, if (opcode == 15) 0 else 2) + @intFromBool(fv));
        vreg.vputScalar(e, rd, f == 1, true);
        return true;
    }
    var bytes: usize = 8;
    if (is(w, 0xdf20_0400, 0x5e20_0400)) {
        const opcode = bits(w, 11, 5);
        if (opcode >= 24) {
            if (!(opcode == 28 or opcode == 27 and !U or opcode == 26 and U and fv)) return false;
            bytes = @as(usize, 4) << f;
        } else if (size != 3 or !(opcode == 6 or opcode == 7 or opcode == 16 or opcode == 17)) return false;
    } else if (is(w, 0xdf3e_0c00, 0x5e20_0800)) {
        const opcode = bits(w, 12, 5);
        if (opcode >= 12 and opcode <= 14 and fv or opcode == 27 and fv or opcode == 29 and !fv) {
            bytes = @as(usize, 4) << f;
        } else if (size != 3 or opcode != 11) return false;
    } else if (is(w, 0xdf80_0400, 0x5f00_0400) and bits(w, 19, 4) != 0) {
        const opcode = bits(w, 11, 5);
        const immh = bits(w, 19, 4);
        if (opcode == 31 and immh >> 2 == 1) {
            bytes = 4;
        } else if (immh < 8 or !(opcode <= 6 and opcode & 1 == 0 or opcode == 8 and U or opcode == 10)) return false;
    } else if (is(w, 0xdf00_0400, 0x5f00_0000)) {
        const opcode = bits(w, 12, 4);
        if (!(opcode == 9 and !U and fv or (opcode == 1 or opcode == 5) and size == 2)) return false;
        bytes = @as(usize, 4) << f;
    } else return false;
    if (!jitvec.emitVector(e, w & ~@as(u32, 0x1000_0000))) return false;
    vget(e, rd);
    vreg.keepLow(e, bytes);
    vput(e, rd, true);
    return true;
}
