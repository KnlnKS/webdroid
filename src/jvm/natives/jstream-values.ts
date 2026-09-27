import { JObj } from "../runtime";

/** a stream stage: its already-drained elements (numbers for int/double, bigint for long) */
export class JStream extends JObj { a: unknown[] = []; }
export class JIntStream extends JObj { a: number[] = []; }
export class JLongStream extends JObj { a: bigint[] = []; }
export class JDoubleStream extends JObj { a: number[] = []; }
export const mkStream = (a: unknown[]) => { const s = new JStream(); s.a = a; return s; };
export const mkIntStream = (a: number[]) => { const s = new JIntStream(); s.a = a; return s; };
export const mkLongStream = (a: bigint[]) => { const s = new JLongStream(); s.a = a; return s; };
export const mkDoubleStream = (a: number[]) => { const s = new JDoubleStream(); s.a = a; return s; };
