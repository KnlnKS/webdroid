import { JObj } from "../runtime";

export class JIntStream extends JObj { a: number[] = []; }
export const mkIntStream = (a: number[]) => { const stream = new JIntStream(); stream.a = a; return stream; };
