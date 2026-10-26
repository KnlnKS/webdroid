// The host's faults on guest code's behalf, which the core's imports and every native module raise.
export class NativeFault extends Error {
  pc = 0;
}
/** a host access through a guest pointer to nothing mapped: copy_from_user's EFAULT under a
 *  system call, the guest's own SIGSEGV under a libc function that reads it in user space */
export class BadAddress extends NativeFault {
  readonly addr: bigint;
  constructor(addr: bigint, message: string) { super(message); this.addr = addr; }
}
