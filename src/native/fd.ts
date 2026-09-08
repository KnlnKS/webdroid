// One descriptor namespace shared by files, pipes, and relay-backed sockets.

const claimed = new Set<number>([0, 1, 2]);
let next = 3;

export function allocateFd(): number {
  while (claimed.has(next)) next++;
  const fd = next++;
  claimed.add(fd);
  return fd;
}

export function releaseFd(fd: number): void {
  if (fd >= 0 && claimed.delete(fd)) next = Math.min(next, fd);
}

export function reserveFd(fd: number): void {
  if (fd >= 0) claimed.add(fd);
}
