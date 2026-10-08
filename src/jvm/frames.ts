import { lexicalFrames } from "./stack-format";
export { lexicalFrames } from "./stack-format";
import type { Runtime } from "./runtime";

const ids = new WeakMap<Runtime, number>(), owners = new Map<number, WeakRef<Runtime>>();
const released = new FinalizationRegistry<number>(id => owners.delete(id));
let next = 0;

function ownerId(owner: Runtime): number {
  let id = ids.get(owner);
  if (id === undefined) {
    ids.set(owner, id = ++next); owners.set(id, new WeakRef(owner)); released.register(owner, id);
  }
  return id;
}

/** WebKit stacks use lexical names and omit new Function source URLs. Bind before parsing. */
export function frameCode(owner: Runtime, source: string, name: string): string {
  return lexicalFrames ? source.replace("function " + name + "(", "function " + name + "$R" + ownerId(owner) + "(") : source;
}
/** A cached body can execute in several loaders; its DEX id cannot identify its Runtime. */
export function nameFrame<F extends Function>(owner: Runtime, fn: F, name = fn.name): F {
  Object.defineProperty(fn, "name", { value: name.replace(/\$R\d+$/, "") + "$R" + ownerId(owner), configurable: true });
  return fn;
}

export function frameOwner(name: string): Runtime | undefined {
  const id = /\$R(\d+)\b/.exec(name)?.[1];
  return id === undefined ? undefined : owners.get(+id)?.deref();
}
