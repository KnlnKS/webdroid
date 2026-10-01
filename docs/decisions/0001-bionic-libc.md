# 0001: 64-bit processes run the reference build's bionic

Status: adopted 2026-10-01 (plan §3 Stage E1). Measurements and failure mechanisms are in the
implementation history's "Stage E1: the reference build's bionic as guest code" entry.

## Decision

Every arm64-v8a process runs the reference build's `libdl`, `libc`, `libm`, `libc++`, `liblog`
and `libz` as guest code over a Linux syscall layer (`src/native/syscall.ts`, `unix.ts`), with
`src/native/bionic.ts` doing the dynamic linker's share of startup. The host keeps:
- the core's memory and string primitives (`memcpy`, `memmove`, `memset`, `memcmp`, `memchr`,
  `strlen`, `strnlen`, `strcmp`, `strncmp`, `__memcpy_chk`);
- the heap, installed through bionic's malloc dispatch table;
- `clock_gettime`'s svc, served in the core as the vDSO serves it;
- the boundary libraries HLE stays for (plan §3 Stage E3): EGL/GLES, audio, media and DRM.

armeabi-v7a processes keep the HLE libc: the reference build ships no 32-bit bionic (§0.4).

## Why

The comparison (plan §3 Stage E1) ran both libcs on the same bundle, headless with one job:
- Correctness gates on the adopted tree (458d17d6) equal the HLE baseline (33b23028): `bun run
  test`, smoke, the quick e2e gate (7/7 twice), every `--full` flow's depth and score, the corpus
  (33/33 draw, no required native, no missing syscall, no libc warning or abort in any console),
  and conform luni-io/luni-nio-file/luni-net at their baselines.
- Live flows: Lichess and YouTube pass at least as often as on the HLE (YouTube interleaved 4/4
  vs 1/4, its known playback flake); TikTok wedges at the same steps in both.
- Frame rates: Among Us's menu 22.7-23.2 GL frames/s vs 20.5-20.7 with less than half the host
  calls; the latency gate unchanged (its apps are Java-only; Mihon's cold dark tap fails in both).
- The matrix found host bugs the HLE had masked, all fixed for both libcs: stack arguments of
  host functions read from the wrong plane, `mremap`, writable task `comm`, `openat` with
  O_DIRECTORY on a missing path, and the property area.

bionic is the device's own libc, so formatting, parsing, locale, stdio, time zones, FORTIFY,
fdsan, pthread and signal semantics, DNS through netd and logging through logd are exact rather
than approximated. It exposed kernel and VFS gaps the HLE had hidden (`/proc/self/task`,
`/proc/self/maps`, stack guards, Top Byte Ignore), which are now fixed for both libcs.

## Costs and follow-ups

- Per call from guest code, formatting, mutexes and libm cost more than the HLE's
  core-served versions (snprintf 2.0-2.5 µs vs 0.78, mutex 68 ns vs 22, sin+exp 180 ns vs 37).
  No measured app showed it. A faster path is core performance on bionic's own code, or §4.7
  intrinsics differentially tested against bionic, each justified by a measured frame or tap.
- Unsupported: fork/vfork (ENOSYS, so popen and system fail), dlclose unloading, AF_INET6 and
  AF_UNIX sockets other than logd and netd.
- Offsets into bionic's private structures are this build's (`bionic.ts`); a new reference build
  must recheck them against its libc.so.
