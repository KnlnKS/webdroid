// bionic (32-bit ARM) libc surface: strings, memory, time, ctype, math, process stubs, sockets
// that fail honestly. Struct layouts live in LAYOUT. stdio is in stdio.ts, printf/scanf in printf.ts.

/** bionic 32-bit ARM struct offsets/sizes (one block, see CONTRACT). */
export const LAYOUT = {
  FILE_SIZE: 84, F_P: 0, F_R: 4, F_W: 8, F_FLAGS: 12, F_FILE: 14, F_BF_BASE: 16, F_BF_SIZE: 20, F_LBFSIZE: 24, F_COOKIE: 28,
  STAT_SIZE: 104, ST_INO32: 12, ST_MODE: 16, ST_NLINK: 20, ST_UID: 24, ST_GID: 28, ST_SIZE: 48, ST_BLKSIZE: 56, ST_BLOCKS: 64,
  ST_ATIME: 72, ST_MTIME: 80, ST_CTIME: 88, ST_INO: 96,
  DIRENT_SIZE: 276, D_INO: 0, D_OFF: 8, D_RECLEN: 16, D_TYPE: 18, D_NAME: 19,
  TM_SIZE: 44, UTSNAME_FIELD: 65, JMPBUF_SIZE: 256,
} as const;

export function libcInit(): void { throw new Error("TODO libcInit"); }
