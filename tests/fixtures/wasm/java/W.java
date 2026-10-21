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
  public static long lmath(long a, long b) {
    long r = a * b + (a - b) ^ (a & ~b) | (a >>> 3);
    r += -a + ~b;
    if (b != 0) r += a / b + a % b;
    return r;
  }
  public static long lshift(long a, int s) { return (a << s) ^ (a >> s) ^ (a >>> s) ^ ((long) (int) a << s); }
  public static int ishift(int a, int s) { return (a << s) ^ (a >> s) ^ (a >>> s) ^ (a << 33) ^ (a >>> 31); }
  public static int idiv(int a, int b) { return b == 0 ? -1 : a / b + a % b; }
  public static int lcmp(long a, long b) { return (a < b ? 1 : 0) + (a <= b ? 2 : 0) + (a == b ? 4 : 0) + (a > b ? 8 : 0) + (a != b ? 16 : 0); }
  public static int conv(float f, double d) { return (int) f + (int) d + (int) (long) d + (short) d + (byte) f + (char) d; }
  public static long convl(float f, double d, long l, int i) { return (long) f + (long) d + (long) (float) l + (long) (double) l + (long) (float) i; }
  public static double convd(long l, int i, float f) { return (double) l + (float) l + (double) i + (double) f + (double) (float) (l * 0.1); }
  public static int fcmp(float a, float b) { return (a < b ? 1 : 0) + (a <= b ? 2 : 0) + (a == b ? 4 : 0) + (a > b ? 8 : 0) + (a >= b ? 16 : 0) + (a != b ? 32 : 0); }
  public static int dcmp(double a, double b) { return (a < b ? 1 : 0) + (a <= b ? 2 : 0) + (a == b ? 4 : 0) + (a > b ? 8 : 0) + (a >= b ? 16 : 0) + (a != b ? 32 : 0); }
  public static double farith(double a, double b) { return a * b - a / b + a % b + -a; }
  public static float farithf(float a, float b) { return a * b - a / b + a % b + -a; }
  public static int sparse(int x) { switch (x) { case -5: return 1; case 1000: return 2; case 65536: return 3; case Integer.MAX_VALUE: return 4; default: return 0; } }
  public static int sparse9(int x) { int r = 0; for (int i = 0; i < 3; i++) { switch (x * 7 + i * 1000) { case -90000: r += 1; break; case -1000: r += 2; break; case 0: r += 3; continue; case 1000: r += 4; case 2000: r += 5; break; case 7000: r += 6; break; case 9000: r += 7; break; case 40000: r += 8; break; case 1 << 30: r += 9; break; case Integer.MIN_VALUE: r += 10; break; default: r -= 1; } } return r; }
  public static int dense(int x) { int r = 0; for (int i = 0; i < 2; i++) { switch (x + i) { case -2: r += 1; break; case -1: r += 2; break; case 0: r += 3; continue; case 1: r += 4; break; case 3: r += 6; break; case 4: r += 7; break; case 6: r += 9; break; case 7: r += 10; break; default: r -= 1; } r *= 3; } return r; }
  public static int packed(int x) { switch (x) { case 3: return 30; case 4: return 40; case 5: return 50; case 7: return 70; default: return -3; } }
  public static int tryDiv(int a, int b) { try { return a / b; } catch (ArithmeticException e) { return -1; } }
  public static int tryIdx(int i) { int[] a = new int[4]; int r = 0; try { r = a[i] + 1; a[i] = 5; r += a[i]; } catch (ArrayIndexOutOfBoundsException e) { r = -2; } return r; }
  public static int tryNest(int a, int b) {
    int r = 0;
    try { try { r += 100 / a; } finally { r += 1; } r += 1000 / b; } catch (ArithmeticException e) { r += 7; } finally { r += 20; }
    return r;
  }
  /** d8 ends a try range at the invoke when the handler reads the register the call's result goes to, so its move-result starts a block of its own */
  public static int tryResult(int n) {
    synchronized (W.class) {
      String s = "[unknown] ";
      try { s = String.format("%d:%s", n, Integer.toHexString(n)); } catch (RuntimeException e) { s = s + "x"; }
      return s.length() + s.charAt(1);
    }
  }
  public static int tryNeg(int n) { try { int[] a = new int[n]; return a.length; } catch (NegativeArraySizeException e) { return -9; } }
  public static int nested(int n) {
    int s = 0;
    outer: for (int i = 0; i < n; i++) { for (int j = 0; j < n; j++) { if (j > i) continue outer; if (i * j > 40) break outer; s += i ^ j; } }
    return s;
  }
  public static long mix(int n) { long s = 0; int k = 1; for (int i = 0; i < n; i++) { k = k * 31 + i; s += (long) k * i - (k >> 3); if ((k & 3) == 0) s ^= s << 1; } return s; }
  public static int arrays(int n) {
    long[] l = new long[n + 1]; short[] sh = new short[n + 1]; byte[] b = new byte[n + 1]; char[] c = new char[n + 1]; double[] d = new double[n + 1]; float[] f = new float[n + 1];
    for (int i = 0; i <= n; i++) { l[i] = (long) i << 33; sh[i] = (short) (i * 40000); b[i] = (byte) (i * 200); c[i] = (char) (i * 70000); d[i] = i / 3.0; f[i] = i / 7f; }
    long s = 0; for (int i = 0; i <= n; i++) s += l[i] + sh[i] + b[i] + c[i] + (long) d[i] + (long) f[i];
    return (int) (s ^ (s >>> 32));
  }
  public static int objs(int n) {
    int[] a = new int[n]; for (int i = 0; i < n; i++) a[i] = i * i;
    Object o = a; int s = 0;
    if (o instanceof int[]) s += ((int[]) o).length;
    Object[] os = new Object[2]; s += os[0] == null ? 1 : 0;
    return s + a[n - 1];
  }
  // diff.ts rewrites it to read the String through a copy of its allocation made before the constructor call
  public static int stringAlias(int n) { return new String(new char[n & 7]).length() * 2; }
}
