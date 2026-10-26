// Opaque handles a native library hands the guest for host objects. A pointer handle is a small zeroed
// guest allocation, for APIs whose handles are pointers the guest may dereference (Vulkan's dispatchable
// objects keep the loader's dispatch table there) or compare as addresses; a counted handle is a number.

import { mem } from "./mem.ts";
import { PTR } from "./host.ts";

type Class<T> = abstract new (...args: never[]) => T;
export class Handles<T> {
  private readonly objects = new Map<number, T>();
  private readonly allocated = new Set<number>();
  private next = 0x1000;
  private readonly what: string;
  constructor(what: string) { this.what = what; }
  /** a new pointer handle of `bytes` zeroed bytes for `o`; 0 when the guest heap is full */
  alloc(o: T, bytes = PTR): number {
    const h = mem.malloc(bytes);
    if (!h) return 0;
    mem.memset(h, 0, bytes);
    this.objects.set(h, o); this.allocated.add(h);
    return h;
  }
  /** a new counted handle for `o` */
  add(o: T): number { this.objects.set(++this.next, o); return this.next; }
  /** the object `h` names, of class `as` when given; a stale or foreign handle is the caller's undefined
   *  behaviour, which faults here */
  get<U extends T = T>(h: number, as?: Class<U>): U {
    const o = this.objects.get(h);
    if (o === undefined || as && !(o instanceof as)) throw new Error(`${this.what}: no ${as?.name ?? "object"} for handle 0x${h.toString(16)}`);
    return o as U;
  }
  /** the object `h` names, if any (0 names none) */
  find<U extends T = T>(h: number, as?: Class<U>): U | undefined {
    const o = h ? this.objects.get(h) : undefined;
    return as && !(o instanceof as) ? undefined : o as U | undefined;
  }
  /** ends `h`, freeing a pointer handle's allocation; the object it named */
  delete(h: number): T | undefined {
    const o = this.objects.get(h);
    if (o === undefined) return undefined;
    this.objects.delete(h);
    if (this.allocated.delete(h)) mem.free(h);
    return o;
  }
  values(): IterableIterator<T> { return this.objects.values(); }
}
