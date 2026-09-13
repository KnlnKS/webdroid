import { gl, setGL } from "../android/gl";
import type { EglContext } from "../android/glview";

export const glSurfaces = { current: null as EglContext | null };

const contexts = new WeakMap<object, EglContext>();
let activeOwner: object | null = null;
let activeContext: EglContext | null = null;

export function bindEglCurrent(owner: object, context: EglContext | null): void {
  if (context) contexts.set(owner, context);
  else contexts.delete(owner);
  activeOwner = owner;
  activeContext = context;
  glSurfaces.current = context;
  setGL(context?.gl ?? null);
}

export function activateEglCurrent(owner: object): EglContext | null {
  if (activeOwner === owner && glSurfaces.current === activeContext && gl === (activeContext?.gl ?? null)) return activeContext;
  const context = contexts.get(owner) ?? null;
  activeOwner = owner;
  activeContext = context;
  glSurfaces.current = context;
  setGL(context?.gl ?? null);
  return context;
}

export function boundEglCurrent(owner: object): EglContext | null {
  return contexts.get(owner) ?? null;
}
