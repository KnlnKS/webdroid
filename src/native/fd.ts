// One descriptor namespace shared by files, pipes, and relay-backed sockets.

const claimed = new Set<number>([0, 1, 2]);
let next = 3;

/** the lowest unclaimed descriptor at or above `min` */
export function allocateFd(min = 0): number {
  while (claimed.has(next)) next++;
  let fd = Math.max(next, min);
  while (claimed.has(fd)) fd++;
  if (fd === next) next++;
  claimed.add(fd);
  return fd;
}

export function releaseFd(fd: number): void {
  if (fd >= 0 && claimed.delete(fd)) next = Math.min(next, fd);
}

export function reserveFd(fd: number): void {
  if (fd >= 0) claimed.add(fd);
}
