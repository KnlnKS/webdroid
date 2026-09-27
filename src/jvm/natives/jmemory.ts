import { mem } from "../../native/mem";
import { rt, JObj, type NativeSpec } from "../runtime";
import { u8 } from "../abi";
import { reverseBytes32, reverseBytes64 } from "./jlang";

function physical(address: number | bigint): number {
  const va = typeof address === "bigint" ? BigInt.asUintN(64, address) : BigInt(address >>> 0);
  return mem.txVa(va);
}

function checkArray(bytes: Int8Array | null, offset: number, length: number): Int8Array {
  if (bytes === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (offset < 0 || length < 0 || offset > bytes.length - length) {
    throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
  }
  return bytes;
}

function peekByte(address: number | bigint): number {
  return mem.ld8s(physical(address));
}

function peekInt(address: number | bigint, swap: number): number {
  const value = mem.ld32(physical(address));
  return swap ? reverseBytes32(value) : value;
}

function peekLong(address: number | bigint, swap: number): bigint {
  const value = mem.ld64(physical(address));
  return swap ? reverseBytes64(value) : value;
}

function pokeByte(address: number | bigint, value: number): void {
  mem.st8(physical(address), value);
}

function pokeInt(address: number | bigint, value: number, swap: number): void {
  mem.st32(physical(address), swap ? reverseBytes32(value) : value);
}

function pokeLong(address: number | bigint, value: bigint, swap: number): void {
  mem.st64(physical(address), swap ? reverseBytes64(value) : value);
}

function peekByteArray(address: number | bigint, output: Int8Array | null, offset: number, length: number): void {
  const bytes = checkArray(output, offset, length);
  if (length) bytes.set(mem.bytes(physical(address), length), offset);
}

function pokeByteArray(address: number | bigint, input: Int8Array | null, offset: number, length: number): void {
  const bytes = checkArray(input, offset, length);
  if (length) mem.write(physical(address), u8(bytes, offset, length));
}

const methods: NonNullable<NativeSpec["methods"]> = {};
for (const addressType of ["I", "J"]) {
  methods[`static peekByte(${addressType})B`] = peekByte;
  methods[`static peekInt(${addressType}Z)I`] = peekInt;
  methods[`static peekLong(${addressType}Z)J`] = peekLong;
  methods[`static pokeByte(${addressType}B)V`] = pokeByte;
  methods[`static pokeInt(${addressType}IZ)V`] = pokeInt;
  methods[`static pokeLong(${addressType}JZ)V`] = pokeLong;
  methods[`static peekByteArray(${addressType}[BII)V`] = peekByteArray;
  methods[`static pokeByteArray(${addressType}[BII)V`] = pokeByteArray;
}

rt.register({ name: "libcore/io/Memory", ctor: class extends JObj {}, methods });
