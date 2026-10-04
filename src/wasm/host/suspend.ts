import type { HostFn } from "../link/hostapi";

/** How the host function `wrapped` of native `spec` is installed as a Wasm import: as it is, so a native that answers a Promise is reported as suspended. */
export function adaptImport(_spec: { id: string; fn: HostFn }, wrapped: HostFn): HostFn {
  return wrapped;
}
