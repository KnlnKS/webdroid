// Descriptor ownership while Java decodes a Parcel: a scope owns the descriptors it was handed, and
// closes those still its own when it is released. A duplicate is its original's owner's too.
import { fdEvents, javaCloseFd, openFd } from "../native/fd.ts";

const leases = new Map<number, FdLease>();
export class FdScope {
  private leases = new Set<FdLease>();
  private closed = false;
  own(fd: number): FdLease {
    if (this.closed) throw new Error("Descriptor scope has been released");
    if (!openFd(fd)) throw new Error("Invalid scoped descriptor");
    const current = leases.get(fd);
    if (current?.owner === this) return current;
    const lease = new FdLease(fd, this);
    leases.set(fd, lease); this.leases.add(lease);
    return lease;
  }
  transfer(): void { for (const lease of this.leases) if (lease.owner === this) lease.owner = undefined; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lease of this.leases) if (lease.owner === this) lease.close();
    this.leases.clear();
  }
}
class FdLease {
  private number: number; owner: FdScope | undefined;
  private callbacks = new Set<() => void>();
  constructor(number: number, owner: FdScope | undefined) { this.number = number; this.owner = owner; }
  get fd(): number { return leases.get(this.number) === this && openFd(this.number) ? this.number : -1; }
  close(): void { if (this.fd >= 0) javaCloseFd(this.fd); }
  onClose(callback: () => void): void { this.callbacks.add(callback); }
  closed(): void { for (const callback of this.callbacks) callback(); this.callbacks.clear(); }
}
export const fdLease = (fd: number) => leases.get(fd);
const guarded = new WeakMap<object, FdLease>();
/** the descriptor a Java FileDescriptor holding `fd` may use: one a scope owns stays bound to that
 *  scope's lease, so once the scope closes it the Java object reads -1 (`closed` resets its int)
 *  rather than whatever later reuses the number */
export function guardJavaDescriptor<D extends object>(d: D, fd: number, closed: (d: D, fd: number) => void): number {
  const prior = guarded.get(d);
  if (prior && fd >= 0) return prior.fd;
  const lease = leases.get(fd);
  if (lease?.owner) { guarded.set(d, lease); lease.onClose(() => closed(d, fd)); }
  return fd;
}
export const unguardJavaDescriptor = (d: object) => { guarded.delete(d); };
/** Kernel grants are independent of temporary Java decoding ownership. */
export function detachFdScope(fd: number): void { const lease = leases.get(fd); if (lease) lease.owner = undefined; }
fdEvents.closed = (fd) => { const lease = leases.get(fd); leases.delete(fd); lease?.closed(); };
fdEvents.duplicated = (from, to) => { leases.get(from)?.owner?.own(to); };
