public class W {
  public static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
  public static int sieve(int n) {
    boolean[] c = new boolean[n + 1]; int cnt = 0;
    for (int i = 2; i <= n; i++) { if (!c[i]) { cnt++; for (long j = (long) i * i; j <= n; j += i) c[(int) j] = true; } }
    return cnt;
  }
  public static long xorshift(int n) { long s = 88172645463325252L; for (int i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 7; s ^= s << 17; } return s; }
  public static double mandel(int n) {
    double sum = 0;
    for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) {
      double cr = 2.0 * x / n - 1.5, ci = 2.0 * y / n - 1.0, zr = 0, zi = 0; int it = 0;
      while (it < 50 && zr * zr + zi * zi < 4.0) { double t = zr * zr - zi * zi + cr; zi = 2 * zr * zi + ci; zr = t; it++; }
      sum += it;
    }
    return sum;
  }
  public static int sw(int x) { switch (x) { case 0: return 10; case 1: return 20; case 5: return 50; case 100: return 7; default: return -1; } }
  public static int swsum(int n) { int s = 0; for (int i = 0; i < n; i++) s += sw(i % 7 == 6 ? 100 : i % 7); return s; }
  public static int floats(int n) { float f = 0; for (int i = 0; i < n; i++) f += i * 0.5f; return (int) f; }
  public static int collatz(int n) { int best = 0; for (int i = 1; i < n; i++) { long x = i; int steps = 0; while (x != 1) { x = (x & 1) == 0 ? x >> 1 : 3 * x + 1; steps++; } if (steps > best) best = steps; } return best; }
}
