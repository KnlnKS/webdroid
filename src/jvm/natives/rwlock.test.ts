import { expect, test } from "bun:test";
import "../../natives";
import { rt } from "../runtime";
import { curThread, JThread, newObj, setCurThread, vcall } from "./jlang";

async function lock() {
  rt.link("java/lang/Thread");
  const owner = await newObj("java/util/concurrent/locks/ReentrantReadWriteLock");
  return { owner, read: await vcall(owner, "readLock", "()Ljava/util/concurrent/locks/ReentrantReadWriteLock$ReadLock;"), write: await vcall(owner, "writeLock", "()Ljava/util/concurrent/locks/ReentrantReadWriteLock$WriteLock;") };
}
const acquire = (handle: unknown) => vcall(handle, "lock", "()V");
const release = (handle: unknown) => vcall(handle, "unlock", "()V");
const count = (owner: unknown, write = false) => vcall(owner, write ? "getWriteHoldCount" : "getReadHoldCount", "()I");

test("read/write handles retain per-thread counts through recycle-style upgrade and downgrade", async () => {
  const previous = curThread, a = new JThread(), b = new JThread();
  try {
    const { owner, read, write } = await lock(); setCurThread(a);
    expect(rt.iof(read, "java/util/concurrent/locks/ReentrantReadWriteLock$ReadLock")).toBe(1);
    expect(rt.iof(write, "java/util/concurrent/locks/ReentrantReadWriteLock$WriteLock")).toBe(1);
    expect(await vcall(owner, "readLock", "()Ljava/util/concurrent/locks/Lock;")).toBe(read);
    expect(await vcall(owner, "writeLock", "()Ljava/util/concurrent/locks/Lock;")).toBe(write);
    await acquire(read); await acquire(read); expect(await count(owner)).toBe(2);
    setCurThread(b); expect(await count(owner)).toBe(0); await acquire(read);
    expect(await vcall(owner, "getReadLockCount", "()I")).toBe(3);
    expect(await vcall(write, "tryLock", "()Z")).toBe(0);
    await release(read); await expect(release(read)).rejects.toBeDefined();
    setCurThread(a); const reads = await count(owner);
    for (let i = 0; i < reads; i++) await release(read);
    await acquire(write); await acquire(write); expect(await count(owner, true)).toBe(2);
    for (let i = 0; i < reads; i++) await acquire(read);
    await release(write); await release(write);
    expect(await count(owner, true)).toBe(0); expect(await count(owner)).toBe(2);
    await release(read); await release(read);
    expect(await vcall(owner, "getReadLockCount", "()I")).toBe(0);
  } finally { setCurThread(previous); }
});

test("contended writers wait for readers and retain the initiating thread across suspension", async () => {
  const previous = curThread, a = new JThread(), b = new JThread(), c = new JThread();
  try {
    const { owner, read, write } = await lock(); setCurThread(a); await acquire(read);
    setCurThread(b); let acquired = false;
    const waiting = acquire(write).then(() => { acquired = true; });
    await Promise.resolve(); expect(acquired).toBe(false);
    setCurThread(c); expect(await vcall(write, "tryLock", "()Z")).toBe(0);
    await expect(release(write)).rejects.toBeDefined();
    setCurThread(a); await release(read); await waiting;
    expect(await count(owner, true)).toBe(0);
    setCurThread(b); expect(await count(owner, true)).toBe(1); await release(write);
    expect(await vcall(owner, "isWriteLocked", "()Z")).toBe(0);
  } finally { setCurThread(previous); }
});

test("interrupted lock attempts clear interrupt state without acquiring or leaking waiters", async () => {
  const previous = curThread, a = new JThread(), b = new JThread();
  try {
    const { owner, read, write } = await lock(); setCurThread(a); await acquire(read);
    setCurThread(b); b.interrupted = 1;
    await expect(vcall(write, "lockInterruptibly", "()V")).rejects.toBeDefined();
    expect(b.interrupted).toBe(0);
    const waiting = vcall(write, "lockInterruptibly", "()V");
    const rejected = waiting.then(() => null, (error: unknown) => error);
    await vcall(b, "interrupt", "()V"); expect(await rejected).not.toBeNull();
    setCurThread(a); await release(read);
    expect(await count(owner, true)).toBe(0);
    expect(await vcall(write, "tryLock", "()Z")).toBe(1); await release(write);
  } finally { setCurThread(previous); }
});
