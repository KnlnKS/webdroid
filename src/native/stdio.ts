// stdio + the fd table over the JVM vfs: FILE structs live in guest memory (bionic __sFILE layout)
// so the getc/putc macros and __srget refills work; /proc/cpuinfo and /proc/meminfo are synthesized.
export {};
