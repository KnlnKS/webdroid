import { curThread } from "../jvm/natives/jentry.ts";
import { gl, setGL, selectGL } from "../android/gl.ts";
import type { EglContext } from "../android/glsurface.ts";

export const glSurfaces = {
  get current(): EglContext | null { return contexts.get(curThread) ?? null; },
  set current(context: EglContext | null) { bindEglCurrent(curThread, context); },
};

const contexts = new WeakMap<object, EglContext>();
let activeOwner: object | null = null;
let activeContext: EglContext | null = null;

export function bindEglCurrent(owner: object, context: EglContext | null): void {
  if (context) contexts.set(owner, context);
  else contexts.delete(owner);
  activeOwner = owner;
  activeContext = context;
  setGL(context?.gl ?? null, owner);
}

export function activateEglCurrent(owner: object): EglContext | null {
  if (activeOwner === owner && gl === (activeContext?.gl ?? null)) return activeContext;
  const context = contexts.get(owner) ?? null;
  activeOwner = owner;
  activeContext = context;
  selectGL(context?.gl ?? null);
  return context;
}

export function boundEglCurrent(owner: object): EglContext | null {
  return contexts.get(owner) ?? null;
}
