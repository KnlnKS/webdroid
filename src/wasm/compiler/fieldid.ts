// A field's id: its class id << 12 | its index in the class's fields, which Field.artFieldIndex, the accessor slots and Unsafe's
// offset table name it by. Ids stay below Unsafe's array base (1 << 30) for 2^18 classes; a field past index 4095 (in a large R$id)
// has none, and reflecting it raises an error rather than naming a field of the next class.
import { OP, type Code } from "./code.ts";

const BITS = 12;
export const FIELD_INDEX_MAX = (1 << BITS) - 1;
export const fieldIdOf = (cid: number, index: number): number => cid << BITS | index;
export const fieldClass = (id: number): number => id >>> BITS;
export const fieldIndex = (id: number): number => id & FIELD_INDEX_MAX;
/** the id in local `id`, split into locals `cid` and `index` */
export function splitFieldId(c: Code, id: number, cid: number, index: number): void {
  c.lget(id).i32(BITS).raw(OP.i32_shr_u).lset(cid).lget(id).i32(FIELD_INDEX_MAX).raw(OP.i32_and).lset(index);
}
/** pushes the id of the field `index` (an i32 local) of the class `cid` (an i32 local) */
export function emitFieldId(c: Code, cid: number, index: number): void {
  c.lget(cid).i32(BITS).raw(OP.i32_shl).lget(index).raw(OP.i32_or);
}
