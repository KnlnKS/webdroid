import java.util.*;

/** Extra G1 workloads in the shape of scripts/jbench/Bench.java (a `case` per line of run), for the code the jbench set leaves out: strings, arithmetic
 *  loops, field and array access, direct, virtual and interface calls. g1.ts cuts each case into its own static method. */
public class G1 {
  interface Shape { int area(); }
  static final class Sq implements Shape { final int s; Sq(int s) { this.s = s; } public int area() { return s * s; } }
  static final class Rect implements Shape { final int w, h; Rect(int w, int h) { this.w = w; this.h = h; } public int area() { return w * h; } }
  static abstract class Node { int v; Node next; abstract int val(); }
  static class A extends Node { int val() { return v + 1; } }
  static class B extends Node { int val() { return v * 2; } }
  static class P { int x, y; P(int x, int y) { this.x = x; this.y = y; } int sum() { return x + y; } }
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
      case "exceptions": { int s = 0; for (int i = 0; i < 3000; i++) { try { if ((i & 3) == 0) throw new IllegalStateException(); s++; } catch (IllegalStateException e) { s += 2; } } return s; }
    }
    throw new IllegalArgumentException(w);
  }
}
