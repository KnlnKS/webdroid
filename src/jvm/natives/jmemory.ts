import { mem } from "../../native/mem";
import { rt, JObj, type NativeSpec } from "../runtime";

function physical(address: number | bigint): number {
  const va = typeof address === "bigint" ? BigInt.asUintN(64, address) : BigInt(address >>> 0);
  return mem.txVa(va);
}

function reverseInt(value: number): number {
  return ((value >>> 24) | ((value >>> 8) & 0xff00) | ((value & 0xff00) << 8) | (value << 24)) | 0;
}

function reverseLong(value: bigint): bigint {
  let input = BigInt.asUintN(64, value);
  let output = 0n;
  for (let i = 0; i < 8; i++) {
    output = (output << 8n) | (input & 0xffn);
    input >>= 8n;
  }
  return BigInt.asIntN(64, output);
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
  return swap ? reverseInt(value) : value;
}

function peekLong(address: number | bigint, swap: number): bigint {
  const value = mem.ld64(physical(address));
  return swap ? reverseLong(value) : value;
}

function pokeByte(address: number | bigint, value: number): void {
  mem.st8(physical(address), value);
}

function pokeInt(address: number | bigint, value: number, swap: number): void {
  mem.st32(physical(address), swap ? reverseInt(value) : value);
}

function pokeLong(address: number | bigint, value: bigint, swap: number): void {
  mem.st64(physical(address), swap ? reverseLong(value) : value);
}

function peekByteArray(address: number | bigint, output: Int8Array | null, offset: number, length: number): void {
  const bytes = checkArray(output, offset, length);
  if (length) bytes.set(mem.bytes(physical(address), length), offset);
}

function pokeByteArray(address: number | bigint, input: Int8Array | null, offset: number, length: number): void {
  const bytes = checkArray(input, offset, length);
  if (length) mem.write(physical(address), new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length));
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
