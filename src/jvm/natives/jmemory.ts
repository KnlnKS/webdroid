import { mem } from "../../native/mem";
import { rt, JObj, type NativeSpec } from "../runtime";
import { u8 } from "../abi";
import { reverseBytes32, reverseBytes64 } from "./jlang";

function physical(address: bigint): number {
  return mem.txVa(BigInt.asUintN(64, address));
}

function checkArray(bytes: Int8Array | null, offset: number, length: number): Int8Array {
  if (bytes === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (offset < 0 || length < 0 || offset > bytes.length - length) {
    throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
  }
  return bytes;
}

function peekByte(address: bigint): number {
  return mem.ld8s(physical(address));
}

function peekInt(address: bigint, swap: number): number {
  const value = mem.ld32(physical(address));
  return swap ? reverseBytes32(value) : value;
}

function peekLong(address: bigint, swap: number): bigint {
  const value = mem.ld64(physical(address));
  return swap ? reverseBytes64(value) : value;
}

function pokeByte(address: bigint, value: number): void {
  mem.st8(physical(address), value);
}

function pokeInt(address: bigint, value: number, swap: number): void {
  mem.st32(physical(address), swap ? reverseBytes32(value) : value);
}

function pokeLong(address: bigint, value: bigint, swap: number): void {
  mem.st64(physical(address), swap ? reverseBytes64(value) : value);
}

function peekByteArray(address: bigint, output: Int8Array | null, offset: number, length: number): void {
  const bytes = checkArray(output, offset, length);
  if (length) bytes.set(mem.bytes(physical(address), length), offset);
}

function pokeByteArray(address: bigint, input: Int8Array | null, offset: number, length: number): void {
  const bytes = checkArray(input, offset, length);
  if (length) mem.write(physical(address), u8(bytes, offset, length));
}

const methods: NonNullable<NativeSpec["methods"]> = {
  "static peekByte(J)B": peekByte,
  "static peekInt(JZ)I": peekInt,
  "static peekLong(JZ)J": peekLong,
  "static pokeByte(JB)V": pokeByte,
  "static pokeInt(JIZ)V": pokeInt,
  "static pokeLong(JJZ)V": pokeLong,
  "static peekByteArray(J[BII)V": peekByteArray,
  "static pokeByteArray(J[BII)V": pokeByteArray,
};

rt.register({ name: "libcore/io/Memory", ctor: class extends JObj {}, methods });
