import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.concurrent.locks.*;

/** Threads, monitors, parking and class initialization: static int(int) cases whose answers do not depend on timing (the harness compares the JDK,
 *  and the Wasm tier); the natives are bound by scripts/wasm/threads.ts. */
public class Th {
  static native int admissionIdentity();
  static int linkAdmissionIdentity(int ignored) { return admissionIdentity(); }
  static native int delayedCallback(int x);
  static native int orderedWait(int x);
  static synchronized int callbackLock(int x) { return x + 1; }
  static class AdmissionA { static int value = AdmissionB.value + 1; }
  static class AdmissionB { static int value = 7; }
  static class AdmissionC { static int value = 11; }
  static int linkAdmissionWinner(int n) { return n + 1; }
  static int linkAdmissionPlain(int ignored) { return AdmissionC.value; }
  static synchronized int linkAdmission(int ignored) {
    Thread owner = Thread.currentThread();
    int answer = AdmissionA.value + delayedCallback(40);
    return owner == Thread.currentThread() && Thread.holdsLock(Th.class) ? answer : -1;
  }
  static synchronized int callbackOwner(int x) { return delayedCallback(x); }
  static native int await(int x);       // an async native
  static native int driven(int x);      // a generator native
  static native int drivenEnters(int x); // a generator native that waits, takes a value it yields at once and then enters Java (onDriven)
  static int onDriven(int x) { return Thread.currentThread().getName().equals("driven") ? x : -1; }
  /** what a generator native enters Java with after a wait runs on the native's thread */
  static int drivenThread(int x) throws Exception {
    int[] r = new int[1];
    Thread t = new Thread(() -> r[0] = drivenEnters(x), "driven");
    t.start();
    t.join();
    return r[0];
  }
  static native int nested(int x);      // an async native that enters Java again, which waits again
  static native int flagged(int x);     // a plain native that answers a Promise
  static native int viaJs(int x);       // a plain native that calls Java which waits (a JS frame between the entry and the import)
  static int inner(int x) { return await(x) * 2; }
  static int trap(int x) { return await(x); }
  static native byte[] gapEcho(byte[] a, int ms);   // an async native: waits, writes a[0] + 1 into its argument and answers the argument reversed
  /** threads whose natives wait together each get their own array back, and see their own argument written, whatever the others do meanwhile */
  static int arrayGap(int n) throws Exception {
    final int[] bad = new int[1];
    Thread[] ts = new Thread[n];
    for (int i = 0; i < n; i++) {
      final int k = i;
      ts[i] = new Thread(() -> {
        byte[] a = new byte[8 + k % 5];
        for (int j = 0; j < a.length; j++) a[j] = (byte) (k * 7 + j);
        byte first = a[0];
        byte[] got = gapEcho(a, k % 3);
        boolean ok = got != null && got.length == a.length && a[0] == (byte) (first + 1);
        for (int j = 0; ok && j < a.length; j++) ok = got[j] == (byte) (k * 7 + a.length - 1 - j);
        if (!ok) synchronized (bad) { bad[0]++; }
      });
      ts[i].start();
    }
    for (Thread t : ts) t.join();
    return bad[0];
  }

  static native int gapAlias(byte[] a, byte[] b, boolean fail);
  static int arrayAlias(int n) {
    byte[] a = {3};
    int r = gapAlias(a, a, false);
    try { gapAlias(a, a, true); } catch (IllegalArgumentException e) { return r == 9 && a[0] == 9 ? 0 : 1; }
    return 2;
  }
  static volatile boolean stop;
  static int fuelProgress(int n) throws Exception {
    stop = false;
    Thread t = new Thread(() -> { try { Thread.sleep(1); } catch (InterruptedException e) { } stop = true; });
    t.start();
    int bound = 10;
    for (int i = 0; i < bound; i++) { if (stop) break; bound++; }
    t.join();
    return stop ? 0 : 1;
  }
  static int fuelOverflow(int n) throws Exception {
    stop = false;
    Thread t = new Thread(() -> { try { Thread.sleep(1); } catch (InterruptedException e) { } stop = true; });
    t.start();
    for (int i = 0; i < Integer.MAX_VALUE; i += 2) { if (stop) break; }
    t.join();
    return stop ? 0 : 1;
  }
  static int fuelArithmetic(int n) { int r = 0; for (int i = 0; i < n; i++) r += i; return r; }

  static class LoopInit { static int value = 7; }
  static int loopState(int n) {
    Object lock = new Object(); int[] a = { 0 }; long l = 3; float f = 1.25f; double d = 2.5;
    synchronized (lock) {
      for (int outer = 0; outer < 2; outer++) try {
        for (int i = 0; i < 9000; i++) {
          l += i; f += 0.5f; d += 0.25;
          a[0] += Thread.holdsLock(lock) ? LoopInit.value : -100;
          if (i == 8500) throw new IllegalArgumentException("chunk");
        }
      } catch (IllegalArgumentException e) { a[0] += (int) l + (int) f + (int) d; }
    }
    return a[0] + (Thread.holdsLock(lock) ? 100000 : 0);
  }
  static int loopTrace(int n) {
    for (int i = 0; i < 9000; i++) {
      if (i == 8500) {
        StackTraceElement[] s = new Exception().getStackTrace();
        int count = 0;
        for (StackTraceElement e : s) if (e.getClassName().equals("Th") && e.getMethodName().equals("loopTrace")) count++;
        return count;
      }
    }
    return 0;
  }

  // ---------- monitors
  static int reentrant(int n) {
    Object o = new Object(); int c = 0;
    synchronized (o) { synchronized (o) { for (int i = 0; i < n; i++) synchronized (o) { c += Thread.holdsLock(o) ? 1 : 0; } } }
    return c + (Thread.holdsLock(o) ? 100 : 0);
  }
  static int rec(Object o, int d) { if (d == 0) return Thread.holdsLock(o) ? 1 : 0; synchronized (o) { return rec(o, d - 1); } }
  static int deepLock(int n) { Object o = new Object(); return rec(o, n) + (Thread.holdsLock(o) ? 1000 : 0); }
  static int imse(int n) {
    Object o = new Object(); int r = 0;
    try { o.notify(); } catch (IllegalMonitorStateException e) { r += 1; }
    try { o.wait(); } catch (IllegalMonitorStateException e) { r += 2; } catch (InterruptedException e) { r += 100; }
    synchronized (o) { try { o.wait(-1); } catch (IllegalArgumentException e) { r += 4; } catch (InterruptedException e) { r += 100; } }
    synchronized (o) { try { o.wait(1, 1000000); } catch (IllegalArgumentException e) { r += 8; } catch (InterruptedException e) { r += 100; } }
    return r;
  }
  static int contend(int n) throws Exception {
    final int[] c = {0}; final Object lock = new Object();
    Thread[] t = new Thread[4];
    for (int i = 0; i < t.length; i++) { t[i] = new Thread(() -> { for (int k = 0; k < n; k++) synchronized (lock) { int v = c[0]; Thread.yield(); c[0] = v + 1; } }); t[i].start(); }
    for (Thread x : t) x.join();
    return c[0];
  }
  static int pingPong(int n) throws Exception {
    final Object lock = new Object(); final int[] turn = {0}; final int[] seq = {0};
    Thread a = new Thread(() -> { synchronized (lock) { for (int i = 0; i < n; i++) { while (turn[0] != 0) { try { lock.wait(); } catch (InterruptedException e) { return; } } seq[0] = seq[0] * 3 + 1; turn[0] = 1; lock.notifyAll(); } } });
    Thread b = new Thread(() -> { synchronized (lock) { for (int i = 0; i < n; i++) { while (turn[0] != 1) { try { lock.wait(); } catch (InterruptedException e) { return; } } seq[0] = seq[0] * 3 + 2; turn[0] = 0; lock.notifyAll(); } } });
    b.start(); a.start(); a.join(); b.join();
    return seq[0];
  }
  static int notifyOne(int n) throws Exception {
    final Object lock = new Object(), gate = new Object(); final int[] woke = {0}; final int[] ready = {0};
    Thread[] t = new Thread[3];
    for (int i = 0; i < t.length; i++) { t[i] = new Thread(() -> { synchronized (lock) { synchronized (gate) { ready[0]++; gate.notifyAll(); } try { lock.wait(); } catch (InterruptedException e) { return; } woke[0]++; } }); t[i].start(); }
    synchronized (gate) { while (ready[0] < t.length) gate.wait(); }
    int r = 0;
    for (int i = 0; i < t.length; i++) { synchronized (lock) { lock.notify(); } while (true) { synchronized (lock) { if (woke[0] == i + 1) break; } Thread.sleep(1); } r = r * 10 + woke[0]; }
    for (Thread x : t) x.join();
    return r;
  }
  static int timedWait(int n) throws Exception {
    Object o = new Object(); long t0 = System.nanoTime();
    synchronized (o) { o.wait(30); }
    long ms = (System.nanoTime() - t0) / 1000000;
    return ms >= 25 && ms < 500 ? 1 : (int) -ms;
  }

  // ---------- threads
  static int startJoin(int n) throws Exception {
    final long[] sum = {0};
    Thread t = new Thread(() -> { for (int i = 1; i <= n; i++) sum[0] += i; }, "summer");
    int before = t.getState() == Thread.State.NEW ? 1 : 0;
    t.start(); t.join();
    return (int) sum[0] + before * 1000000 + (t.isAlive() ? 1 : 0) * 100000 + (t.getState() == Thread.State.TERMINATED ? 10000000 : 0);
  }
  static int names(int n) throws Exception {
    final String[] seen = new String[1];
    Thread t = new Thread(() -> seen[0] = Thread.currentThread().getName() + "/" + Thread.currentThread().isDaemon(), "worker-" + n);
    t.setDaemon(n % 2 == 1); t.start(); t.join();
    return seen[0].hashCode() + Thread.currentThread().getName().length();
  }
  static int sleepOrder(int n) throws Exception {
    final StringBuffer sb = new StringBuffer();
    Thread a = new Thread(() -> { try { Thread.sleep(60); } catch (InterruptedException e) { } sb.append('A'); });
    Thread b = new Thread(() -> { try { Thread.sleep(20); } catch (InterruptedException e) { } sb.append('B'); });
    Thread c = new Thread(() -> { sb.append('C'); });
    a.start(); b.start(); c.start(); a.join(); b.join(); c.join();
    return sb.toString().hashCode();
  }
  static int interruptSleep(int n) throws Exception {
    final int[] r = {0};
    Thread t = new Thread(() -> { try { Thread.sleep(10000); r[0] = 1; } catch (InterruptedException e) { r[0] = 2 + (Thread.currentThread().isInterrupted() ? 10 : 0); } });
    t.start(); Thread.sleep(10); t.interrupt(); t.join();
    return r[0];
  }
  static int interruptWait(int n) throws Exception {
    final Object o = new Object(); final int[] r = {0};
    Thread t = new Thread(() -> { synchronized (o) { try { o.wait(); r[0] = 1; } catch (InterruptedException e) { r[0] = 2 + (Thread.currentThread().isInterrupted() ? 10 : 0) + (Thread.holdsLock(o) ? 100 : 0); } } });
    t.start(); Thread.sleep(10); t.interrupt(); t.join();
    return r[0];
  }
  static int interruptFlag(int n) throws Exception {
    Thread.currentThread().interrupt();
    int r = Thread.currentThread().isInterrupted() ? 1 : 0;
    try { Thread.sleep(5); } catch (InterruptedException e) { r += 10; }
    r += Thread.interrupted() ? 100 : 0;
    return r;
  }
  static int joinTimeout(int n) throws Exception {
    Thread t = new Thread(() -> { try { Thread.sleep(80); } catch (InterruptedException e) { } });
    t.start(); t.join(10);
    int r = t.isAlive() ? 1 : 0;
    t.join();
    return r + (t.isAlive() ? 10 : 0);
  }
  static int uncaught(int n) throws Exception {
    final int[] r = {0};
    Thread t = new Thread(() -> { throw new IllegalStateException("boom" + n); });
    t.setUncaughtExceptionHandler((th, e) -> r[0] = e.getMessage().length() + (th == Thread.currentThread() ? 100 : 0));
    t.start(); t.join();
    return r[0];
  }
  static int states(int n) throws Exception {
    final Object lock = new Object();
    Thread sleeper = new Thread(() -> { try { Thread.sleep(200); } catch (InterruptedException e) { } });
    Thread waiter = new Thread(() -> { synchronized (lock) { try { lock.wait(); } catch (InterruptedException e) { } } });
    Thread blocked = new Thread(() -> { synchronized (lock) { } });
    sleeper.start(); waiter.start();
    Thread.sleep(30);
    int r = sleeper.getState().ordinal() * 100 + waiter.getState().ordinal() * 10;
    synchronized (lock) { blocked.start(); Thread.sleep(30); r = r * 10 + blocked.getState().ordinal(); lock.notifyAll(); }
    sleeper.interrupt(); sleeper.join(); waiter.join(); blocked.join();
    return r * 10 + sleeper.getState().ordinal();
  }
  static int threadLocals(int n) throws Exception {
    final ThreadLocal<Integer> tl = ThreadLocal.withInitial(() -> n);
    tl.set(n + 1);
    final int[] r = {0};
    Thread t = new Thread(() -> { r[0] = tl.get(); tl.set(5); });
    t.start(); t.join();
    return r[0] * 1000 + tl.get();
  }
  static volatile boolean flag;
  static int spin(int n) throws Exception {
    final int[] r = {0};
    flag = false;
    Thread spinner = new Thread(() -> { long k = 0; while (!flag) k++; r[0] = k > 0 ? 1 : 2; });
    Thread setter = new Thread(() -> { try { Thread.sleep(15); } catch (InterruptedException e) { } flag = true; });
    spinner.start(); setter.start();
    spinner.join(); setter.join();
    return r[0];
  }

  // counters that move only when something else decides to, or are tested only then, wait like any other spin
  static int spinStep(int n) throws Exception {
    final int[] r = {0};
    flag = false;
    Thread spinner = new Thread(() -> { int i = 0; while (i < 3) { if (flag) i++; } r[0] = i; });
    Thread setter = new Thread(() -> { try { Thread.sleep(15); } catch (InterruptedException e) { } flag = true; });
    spinner.start(); setter.start();
    spinner.join(); setter.join();
    return r[0];
  }
  static int spinTest(int n) throws Exception {
    final int[] r = {0};
    flag = false;
    Thread spinner = new Thread(() -> { int k = 0; while (true) { k++; if (flag) { if (k > 1) break; } } r[0] = 1; });
    Thread setter = new Thread(() -> { try { Thread.sleep(15); } catch (InterruptedException e) { } flag = true; });
    spinner.start(); setter.start();
    spinner.join(); setter.join();
    return r[0];
  }

  // ---------- parking
  static int parkUnpark(int n) throws Exception {
    final int[] r = {0};
    Thread t = new Thread(() -> { LockSupport.park(); r[0] = 1; });
    t.start(); Thread.sleep(10);
    int before = r[0];
    LockSupport.unpark(t); t.join();
    return before * 10 + r[0];
  }
  static int permit(int n) throws Exception {
    LockSupport.unpark(Thread.currentThread());
    long t0 = System.nanoTime();
    LockSupport.park();
    return (System.nanoTime() - t0) < 50000000L ? 1 : 0;
  }
  static int parkNanos(int n) {
    long t0 = System.nanoTime();
    LockSupport.parkNanos(20000000L);
    long ms = (System.nanoTime() - t0) / 1000000;
    return ms >= 15 && ms < 500 ? 1 : (int) -ms;
  }
  static int parkInterrupt(int n) throws Exception {
    final int[] r = {0};
    Thread t = new Thread(() -> { LockSupport.park(); r[0] = Thread.currentThread().isInterrupted() ? 1 : 2; });
    t.start(); Thread.sleep(10); t.interrupt(); t.join();
    return r[0];
  }

  // ---------- java.util.concurrent
  static int executor(int n) throws Exception {
    ExecutorService ex = Executors.newFixedThreadPool(3);
    List<Future<Integer>> fs = new ArrayList<>();
    for (int i = 0; i < 20; i++) { final int k = i; fs.add(ex.submit(() -> { Thread.sleep(1); return k * k; })); }
    int sum = 0; for (Future<Integer> f : fs) sum += f.get();
    List<Callable<Integer>> cs = new ArrayList<>();
    for (int i = 0; i < 5; i++) { final int k = i; cs.add(() -> k + 100); }
    for (Future<Integer> f : ex.invokeAll(cs)) sum += f.get();
    ex.shutdown();
    return sum + (ex.awaitTermination(5, TimeUnit.SECONDS) ? 100000 : 0);
  }
  static int chm(int n) throws Exception {
    final ConcurrentHashMap<Integer, Integer> m = new ConcurrentHashMap<>();
    Thread[] t = new Thread[4];
    for (int i = 0; i < t.length; i++) { t[i] = new Thread(() -> { for (int k = 0; k < n; k++) { m.merge(k % 17, 1, Integer::sum); if (k % 50 == 0) Thread.yield(); } }); t[i].start(); }
    for (Thread x : t) x.join();
    int s = 0; for (int v : m.values()) s += v;
    return s * 100 + m.size();
  }
  static int latch(int n) throws Exception {
    final CountDownLatch go = new CountDownLatch(1), done = new CountDownLatch(3);
    final AtomicInteger sum = new AtomicInteger();
    for (int i = 0; i < 3; i++) { final int k = i + 1; new Thread(() -> { try { go.await(); } catch (InterruptedException e) { return; } sum.addAndGet(k * 10); done.countDown(); }).start(); }
    Thread.sleep(10);
    int before = sum.get();
    go.countDown();
    return done.await(5, TimeUnit.SECONDS) ? sum.get() + before * 1000 : -1;
  }
  static int lockCondition(int n) throws Exception {
    final ReentrantLock lock = new ReentrantLock(); final Condition c = lock.newCondition(); final int[] box = {0};
    Thread prod = new Thread(() -> { for (int i = 1; i <= n; i++) { lock.lock(); try { while (box[0] != 0) c.awaitUninterruptibly(); box[0] = i; c.signalAll(); } finally { lock.unlock(); } } });
    prod.start();
    int sum = 0;
    for (int i = 1; i <= n; i++) { lock.lock(); try { while (box[0] == 0) c.await(); sum += box[0]; box[0] = 0; c.signalAll(); } finally { lock.unlock(); } }
    prod.join();
    return sum;
  }
  static int queue(int n) throws Exception {
    final BlockingQueue<Integer> q = new ArrayBlockingQueue<>(2);
    Thread prod = new Thread(() -> { try { for (int i = 1; i <= n; i++) q.put(i); q.put(-1); } catch (InterruptedException e) { } });
    prod.start();
    int sum = 0; for (int v; (v = q.take()) != -1; ) sum += v;
    prod.join();
    return sum;
  }
  static int semaphore(int n) throws Exception {
    final Semaphore s = new Semaphore(2); final AtomicInteger cur = new AtomicInteger(), max = new AtomicInteger();
    Thread[] t = new Thread[6];
    for (int i = 0; i < t.length; i++) { t[i] = new Thread(() -> { try { s.acquire(); int c = cur.incrementAndGet(); max.accumulateAndGet(c, Math::max); Thread.sleep(3); cur.decrementAndGet(); s.release(); } catch (InterruptedException e) { } }); t[i].start(); }
    for (Thread x : t) x.join();
    return max.get() * 10 + s.availablePermits();
  }
  static int future(int n) throws Exception {
    FutureTask<Integer> f = new FutureTask<>(() -> { Thread.sleep(5); return n * 2; });
    new Thread(f).start();
    return f.get(5, TimeUnit.SECONDS);
  }
  static int timeout(int n) throws Exception {
    FutureTask<Integer> f = new FutureTask<>(() -> { Thread.sleep(500); return 1; });
    Thread t = new Thread(f); t.start();
    try { f.get(20, TimeUnit.MILLISECONDS); return 0; } catch (TimeoutException e) { f.cancel(true); t.join(); return 1 + (f.isCancelled() ? 10 : 0); }
  }
  static int scheduled(int n) throws Exception {
    ScheduledExecutorService ex = Executors.newScheduledThreadPool(1);
    final AtomicInteger c = new AtomicInteger();
    ScheduledFuture<?> f = ex.scheduleAtFixedRate(() -> c.incrementAndGet(), 0, 5, TimeUnit.MILLISECONDS);
    Thread.sleep(60); f.cancel(false); ex.shutdown();
    return c.get() >= 5 ? 1 : -c.get();
  }
  static int completable(int n) throws Exception {
    CompletableFuture<Integer> a = CompletableFuture.supplyAsync(() -> n + 1);
    CompletableFuture<Integer> b = a.thenApplyAsync(x -> x * 2);
    return b.get(5, TimeUnit.SECONDS);
  }
  static int manyThreads(int n) throws Exception {
    final CountDownLatch go = new CountDownLatch(1), done = new CountDownLatch(n);
    final AtomicInteger sum = new AtomicInteger();
    for (int i = 0; i < n; i++) { final int k = i; new Thread(() -> { try { go.await(); } catch (InterruptedException e) { return; } sum.addAndGet(k); done.countDown(); }).start(); }
    Thread.sleep(5);
    go.countDown();
    return done.await(60, TimeUnit.SECONDS) ? sum.get() : -1;
  }
  static int atomics(int n) throws Exception {
    final AtomicLong a = new AtomicLong(); final AtomicInteger i = new AtomicInteger();
    Thread[] t = new Thread[3];
    for (int k = 0; k < t.length; k++) { t[k] = new Thread(() -> { for (int j = 0; j < n; j++) { a.addAndGet(j); i.incrementAndGet(); } }); t[k].start(); }
    for (Thread x : t) x.join();
    return (int) a.get() + i.get();
  }

  // ---------- class initialization
  static class Slow { static int v; static { try { Thread.sleep(25); } catch (InterruptedException e) { } v = 42; } static int get() { return v; } }
  static int initRace(int n) throws Exception {
    final int[] r = new int[3];
    Thread[] t = new Thread[3];
    for (int i = 0; i < t.length; i++) { final int k = i; t[i] = new Thread(() -> r[k] = Slow.get()); }
    for (Thread x : t) x.start();
    for (Thread x : t) x.join();
    return r[0] * 10000 + r[1] * 100 + r[2];
  }
  static class CycA { static int y = CycB.x + 1; }
  static class CycB { static int x = CycA.y + 10; }
  static int initCycle(int n) { return CycA.y * 100 + CycB.x; }
  static class Bad { static int v = 1 / (Th.zero()); }
  static int zero() { return 0; }
  static int initFail(int n) throws Exception {
    final int[] r = {0};
    Thread t = new Thread(() -> { try { r[0] = Bad.v; } catch (ExceptionInInitializerError e) { r[0] = 7; } catch (NoClassDefFoundError e) { r[0] = 8; } });
    t.start(); t.join();
    try { return Bad.v; } catch (NoClassDefFoundError e) { return r[0] * 10 + 1; } catch (ExceptionInInitializerError e) { return r[0] * 10 + 2; }
  }
  /** two threads whose class initializations wait for each other: the JVM deadlocks, here the later request proceeds with the statics as they are */
  static class DeadP { static int v; static { Th.pause(); v = DeadQ.w + 1; } }
  static class DeadQ { static int w; static { Th.pause(); w = DeadP.v + 2; } }
  static void pause() { try { Thread.sleep(30); } catch (InterruptedException e) { } }
  static int initDeadlock(int n) throws Exception {
    final int[] r = new int[2];
    Thread a = new Thread(() -> r[0] = DeadP.v), b = new Thread(() -> r[1] = DeadQ.w);
    a.start(); b.start(); a.join(); b.join();
    return r[0] * 100 + r[1];
  }
  static int stackOverflow(int n) {
    try { return depth(0); } catch (StackOverflowError e) { return 1; }
  }
  static int depth(int d) { return depth(d + 1) + 1; }
  /** methods linked for the first time with the stack nearly full: a link that fails for want of stack must not leave the method without a body */
  static int probe(int k, Object a, Object b) {
    switch (k) {
      case 0: return new java.util.HashMap<Object, Object>().put(a, b) == null ? 1 : 0;
      case 1: { java.util.ArrayList<Object> l = new java.util.ArrayList<Object>(); l.add(a); return l.contains(b) ? 1 : 0; }
      case 2: return a.toString().length() > 0 ? 1 : 0;
      default: return java.util.Arrays.asList(a, b).hashCode() == 0 ? 0 : 1;
    }
  }
  static int dive(int d, int at, int k, Object a) { return d == at ? probe(k, a, a) : dive(d + 1, at, k, a) + 0; }
  static int linkDeep(int n) {
    int broken = 0;
    int[] depths = {4500, 3000, 1500, 500, 10};
    for (int i = 0; i < depths.length; i++) for (int k = 0; k < 4; k++) {
      try { dive(0, depths[i], k, "x" + i); } catch (StackOverflowError e) { } catch (UnsatisfiedLinkError e) { broken++; }
    }
    for (int k = 0; k < 4; k++) probe(k, "y", "z");
    return broken;
  }
  static int stackOverflowDeep(int n) {
    int caught = 0;
    for (int i = 0; i < 3; i++) try { depth(0); } catch (StackOverflowError e) { caught++; }
    return caught;
  }
  /** how many frames deep a thread gets before StackOverflowError, for frames of two sizes (not compared: the limits differ between machines) */
  static int cnt;
  static int light(int d) { cnt = d; return light(d + 1) + 1; }
  static int count(int n) { return cnt; }
  static int reach(int n) { cnt = 0; try { light(0); } catch (StackOverflowError e) { } return cnt; }
  static double heavy(int d, int a, int b, long c, long e, double f, double g, int h, int i, int j) {
    cnt = d; double x = a + b + c, y = e * f, z = g + h;
    return heavy(d + 1, a + 1, b + 1, c + 1, e + 1, f + 1, g + 1, h + 1, i + 1, j + 1) + x + y + z + a * b * h * i * j;
  }
  static int reachHeavy(int n) { cnt = 0; try { heavy(0, 1, 2, 3L, 4L, 5.0, 6.0, 7, 8, 9); } catch (StackOverflowError e) { } return cnt; }
}
