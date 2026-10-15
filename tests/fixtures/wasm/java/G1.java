import java.util.*;

/** Extra G1 workloads in the shape of scripts/jbench/Bench.java (a `case` per line of run), for the code the jbench set leaves out: strings, arithmetic
 *  loops, field and array access, direct, virtual and interface calls, and the `kt` shapes Kotlin compiles to. g1.ts cuts each case into its own static
 *  method; g1art.ts runs the same cases on the reference device. */
public class G1 {
  interface Shape { int area(); }
  static final class Sq implements Shape { final int s; Sq(int s) { this.s = s; } public int area() { return s * s; } }
  static final class Rect implements Shape { final int w, h; Rect(int w, int h) { this.w = w; this.h = h; } public int area() { return w * h; } }
  static abstract class Node { int v; Node next; abstract int val(); }
  static class A extends Node { int val() { return v + 1; } }
  static class B extends Node { int val() { return v * 2; } }
  static class P { int x, y; P(int x, int y) { this.x = x; this.y = y; } int sum() { return x + y; } }
  static class Counter { int n; synchronized void inc() { n++; } synchronized int get() { return n; } void plain() { n++; } void tryinc() { try { n++; } finally { n--; n++; } } }
  // the shapes Kotlin compiles to (Compose and coroutine code): final getter chains, a lone implementation behind an interface, generic lambdas, parameter
  // null checks, IntArray slot tables, field updaters, try/finally, continuation state machines and stackless cancellation
  static final class Leaf { private final int v; Leaf(int v) { this.v = v; } public final int getV() { return v; } }
  static final class Mid { private final Leaf leaf; Mid(Leaf l) { leaf = l; } public final Leaf getLeaf() { return leaf; } }
  static final class Top { private final Mid mid; Top(Mid m) { mid = m; } public final Mid getMid() { return mid; } }
  interface Store { int read(int key); }
  static final class OnlyStore implements Store { final int[] data = new int[64]; public int read(int key) { return data[key & 63] + key; } }
  interface Function2<P1, P2, R> { R invoke(P1 a, P2 b); }
  static final class Intrinsics { static void checkNotNullParameter(Object o, String name) { if (o == null) throw new NullPointerException(name); } }
  static int sized(String s, Object tag) { Intrinsics.checkNotNullParameter(s, "s"); Intrinsics.checkNotNullParameter(tag, "tag"); return s.length(); }
  static final class Slots { final int[] groups = new int[4096]; int size;
    void start(int key, int flags) { int at = size; groups[at] = key; groups[at + 1] = flags << 2 | 1; size = at + 2; }
    int key(int at) { return groups[at]; } int flags(int at) { return groups[at + 1] >>> 2; } }
  static final class Job { volatile int state; volatile Object result; }
  static final java.util.concurrent.atomic.AtomicIntegerFieldUpdater<Job> STATE = java.util.concurrent.atomic.AtomicIntegerFieldUpdater.newUpdater(Job.class, "state");
  static final java.util.concurrent.atomic.AtomicReferenceFieldUpdater<Job, Object> RESULT = java.util.concurrent.atomic.AtomicReferenceFieldUpdater.newUpdater(Job.class, Object.class, "result");
  static final Object SUSPENDED = new Object();
  /** a continuation as kotlinc writes one: a label, the locals it spills, and a resume that re-enters the state machine */
  static final class Cont { int label, acc, i; }
  static Object step(Cont c, int v) { return (v & 3) == 0 ? SUSPENDED : (Object) Integer.valueOf(v); }
  static Object machine(Cont c) {
    for (;;) switch (c.label) {
      case 0: c.i = 0; c.acc = 0; c.label = 1;
      case 1: if (c.i >= 64) return c.acc; c.label = 2; { Object r = step(c, c.i); if (r == SUSPENDED) return SUSPENDED; c.acc += (Integer) r; } c.label = 3; break;
      case 2: c.acc += c.i; c.label = 3; break;
      case 3: c.i++; c.label = 1; break;
      default: throw new IllegalStateException();
    }
  }
  static final class Cancelled extends RuntimeException { Cancelled() { super("cancelled", null, false, false); } }
  static final Cancelled CANCEL = new Cancelled();
  static int ensureActive(int i) { if ((i & 7) == 7) throw CANCEL; return i; }
  static int using(Counter c, int i) { try { c.n += i; try { return c.n & 1; } finally { c.n--; } } finally { c.n++; } }
  static String[] WORDS = new String[200];
  static { for (int i = 0; i < WORDS.length; i++) WORDS[i] = "word" + (i * 7919 % 1000) + (i % 3 == 0 ? "Alpha" : "beta"); }

  // G4: a kernel loop in one long call (no OSR for Wasm: the activation stays in baseline code), and the same loop re-entered in chunks
  static int kernel(int s, int from, int to) { for (int i = from; i < to; i++) { s += i * 31 ^ (s >>> 3); s ^= i; } return s; }
  static int chunked(int total, int chunk) { int s = 0; for (int i = 0; i < total; i += chunk) s = kernel(s, i, Math.min(total, i + chunk)); return s; }

  static int run(String w) throws Exception {
    switch (w) {
      case "loopOnce": return kernel(0, 0, 8000000);
      case "loopChunk": return chunked(8000000, 16384);
      case "divLoop": { int s = 7; for (int i = 1; i < 100000; i++) { int d = (i & 15) + 1; s += (s / d) ^ (s % d) + i / 3; } return s; }
      case "longDiv": { long s = 1234567890123L; for (int i = 1; i < 50000; i++) { long d = (i & 255) + 1; s += s / d + s % d; } return (int) s; }
      case "switchDense": { int s = 0; for (int i = 0; i < 100000; i++) { switch (i & 15) { case 0: s += 1; break; case 1: s += 3; break; case 2: s ^= 5; break; case 3: s += 7; break; case 4: s -= 2; break; case 5: s += 11; break; case 6: s ^= 13; break; case 7: s += 17; break; case 8: s += 19; break; case 9: s -= 23; break; case 10: s += 29; break; case 11: s ^= 31; break; case 12: s += 37; break; case 13: s += 41; break; case 14: s -= 43; break; default: s += 47; } } return s; }
      case "switchSparse": { int s = 0; for (int i = 0; i < 100000; i++) { switch ((i & 7) * 1000) { case 0: s += 1; break; case 1000: s += 3; break; case 2000: s ^= 5; break; case 3000: s += 7; break; case 4000: s -= 2; break; case 5000: s += 11; break; case 7000: s += 17; break; default: s += 47; } } return s; }
      case "refArray": { Object[] a = new Object[256]; String[] b = new String[256]; for (int r = 0; r < 200; r++) for (int i = 0; i < 256; i++) { a[i] = WORDS[i % 200]; b[i] = WORDS[(i + r) % 200]; } return a.length + b.length + a[5].hashCode() % 3; }
      case "matrix": { int[][] m = new int[64][64]; for (int r = 0; r < 20; r++) for (int i = 0; i < 64; i++) for (int j = 0; j < 64; j++) m[i][j] += i * j + r; int s = 0; for (int[] row : m) for (int v : row) s += v; return s; }
      case "sieve": { boolean[] c = new boolean[100000]; int n = 0; for (int i = 2; i < c.length; i++) { if (!c[i]) { n++; for (int j = i * 2; j < c.length; j += i) c[j] = true; } } return n; }
      case "intLoop": { int s = 0; for (int i = 0; i < 200000; i++) { s += i * 31 ^ (s >>> 3); s ^= i; } return s; }
      case "longLoop": { long s = 1; for (int i = 0; i < 100000; i++) { s = s * 6364136223846793005L + 1442695040888963407L; s ^= s >>> 17; } return (int) s; }
      case "doubleLoop": { double s = 0; for (int i = 1; i < 100000; i++) { s += Math.sqrt(i) / (i + 1.5); } return (int) (s * 1000); }
      case "arraySum": { int[] a = new int[4096]; for (int i = 0; i < a.length; i++) a[i] = i * 3; int s = 0; for (int r = 0; r < 40; r++) for (int i = 0; i < a.length; i++) s += a[i]; return s; }
      case "fieldLoop": { P p = new P(1, 2); for (int i = 0; i < 100000; i++) { p.x += p.y; p.y ^= p.x; } return p.sum(); }
      case "allocLoop": { int s = 0; for (int i = 0; i < 20000; i++) { P p = new P(i, i + 1); s += p.sum(); } return s; }
      case "syncCall": { Counter c = new Counter(); for (int i = 0; i < 100000; i++) c.inc(); return c.get(); }
      case "plainCall": { Counter c = new Counter(); for (int i = 0; i < 100000; i++) c.plain(); return c.get(); }
      case "tryCall": { Counter c = new Counter(); for (int i = 0; i < 100000; i++) c.tryinc(); return c.get(); }
      case "syncBlock": { Counter c = new Counter(); for (int i = 0; i < 100000; i++) { synchronized (c) { c.n++; } } return c.get(); }
      case "idHash": { Object[] os = new Object[64]; for (int i = 0; i < 64; i++) os[i] = new Object(); int s = 0; for (int r = 0; r < 2000; r++) for (int i = 0; i < 64; i++) if (System.identityHashCode(os[i]) == os[i].hashCode()) s++; return s; }
      case "virtualMono": { Node n = new A(); n.v = 3; int s = 0; for (int i = 0; i < 100000; i++) s += n.val(); return s; }
      case "virtualBi": { Node[] ns = new Node[2]; ns[0] = new A(); ns[1] = new B(); ns[0].v = 3; ns[1].v = 4; int s = 0; for (int i = 0; i < 100000; i++) s += ns[i & 1].val(); return s; }
      case "interfaceBi": { Shape[] ss = { new Sq(3), new Rect(2, 5) }; int s = 0; for (int i = 0; i < 100000; i++) s += ss[i & 1].area(); return s; }
      case "linkedNodes": { Node head = null; for (int i = 0; i < 2000; i++) { Node n = (i & 1) == 0 ? new A() : new B(); n.v = i; n.next = head; head = n; } int s = 0; for (int r = 0; r < 20; r++) for (Node n = head; n != null; n = n.next) s += n.val(); return s; }
      case "strChars": { String t = "The quick brown fox jumps over the lazy dog, again and again"; int s = 0; for (int r = 0; r < 2000; r++) for (int i = 0; i < t.length(); i++) s += t.charAt(i); return s; }
      case "strEquals": { int s = 0; for (int r = 0; r < 20; r++) for (int i = 1; i < WORDS.length; i++) { if (WORDS[i].equals(WORDS[i - 1])) s++; s += WORDS[i].hashCode() & 7; if (WORDS[i].startsWith("word1")) s++; } return s; }
      case "strIndex": { String t = "alpha=1;beta=22;gamma=333;delta=4444;epsilon=55555"; int s = 0; for (int r = 0; r < 3000; r++) { int i = t.indexOf('='); while (i >= 0) { s += i; i = t.indexOf('=', i + 1); } s += t.indexOf("gamma"); } return s; }
      case "strBuild": { int s = 0; for (int r = 0; r < 300; r++) { StringBuilder sb = new StringBuilder(); for (int i = 0; i < 20; i++) sb.append("k").append(i).append(','); s += sb.toString().length(); } return s; }
      case "strSubstr": { String t = "0123456789abcdefghijklmnopqrstuvwxyz"; int s = 0; for (int r = 0; r < 3000; r++) for (int i = 0; i + 4 < t.length(); i += 3) s += t.substring(i, i + 4).length() + t.substring(i).length(); return s; }
      case "strCompare": { int s = 0; for (int r = 0; r < 20; r++) for (int i = 1; i < WORDS.length; i++) s += WORDS[i].compareTo(WORDS[i - 1]) > 0 ? 1 : 2; return s; }
      case "parseInts": { int s = 0; for (int r = 0; r < 300; r++) for (int i = 0; i < 20; i++) s += Integer.parseInt(Integer.toString(r * i)); return s; }
      case "ktGetters": { Top[] ts = { new Top(new Mid(new Leaf(3))), new Top(new Mid(new Leaf(5))) }; int s = 0; for (int i = 0; i < 100000; i++) s += ts[i & 1].getMid().getLeaf().getV(); return s; }
      case "ktSingleImpl": { Store st = new OnlyStore(); int s = 0; for (int i = 0; i < 100000; i++) s += st.read(i); return s; }
      case "ktLambda": { Function2<Integer, Integer, Integer> add = (a, b) -> a + b; Function2<Integer, Integer, Integer> mul = (a, b) -> a * b; int s = 0; for (int i = 0; i < 50000; i++) s = add.invoke(s, mul.invoke(i & 7, 3)) & 0xffffff; return s; }
      case "ktNullChecks": { int s = 0; for (int i = 0; i < 100000; i++) s += sized(WORDS[i % 200], WORDS); return s; }
      case "ktSlots": { Slots t = new Slots(); int s = 0; for (int r = 0; r < 50; r++) { t.size = 0; for (int k = 0; k < 2000; k++) t.start(k * 31, k & 15); for (int at = 0; at < t.size; at += 2) s += t.key(at) ^ t.flags(at); } return s; }
      case "ktUpdaters": { Job j = new Job(); int s = 0; for (int i = 0; i < 50000; i++) { int v = STATE.get(j); if (STATE.compareAndSet(j, v, v + 1)) s++; RESULT.compareAndSet(j, null, WORDS[i % 200]); RESULT.set(j, null); } return s + j.state; }
      case "ktTryFinally": { Counter c = new Counter(); int s = 0; for (int i = 0; i < 100000; i++) s += using(c, i); return s + c.n; }
      case "ktStateMachine": { Cont c = new Cont(); int s = 0; for (int r = 0; r < 2000; r++) { c.label = 0; Object o; while ((o = machine(c)) == SUSPENDED) c.label = 2; s += (Integer) o; } return s; }
      case "ktCancel": { int s = 0; for (int i = 0; i < 20000; i++) { try { s += ensureActive(i); } catch (Cancelled e) { s -= 1; } } return s; }
      case "exceptions": { int s = 0; for (int i = 0; i < 3000; i++) { try { if ((i & 3) == 0) throw new IllegalStateException(); s++; } catch (IllegalStateException e) { s += 2; } } return s; }
    }
    throw new IllegalArgumentException(w);
  }
}
