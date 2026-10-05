/** An app for the compile worker and the persisted app build: virtual and interface calls, a devirtualised call a later dex falsifies (Pst2), static state, exceptions and loops hot enough for the second tier. */
public class Pst {
  public interface Op { int apply(int x); }
  public static class Add implements Op { final int k; Add(int k) { this.k = k; } public int apply(int x) { return x + k; } }
  public static class Mul implements Op { final int k; Mul(int k) { this.k = k; } public int apply(int x) { return x * k; } }
  public static class Base { public int f(int x) { return x + 1; } }
  static final int[] TABLE = new int[16];
  static { for (int i = 0; i < TABLE.length; i++) TABLE[i] = i * i; }

  public static int callBase(Base b, int x) { return b.f(x); }
  public static int chain() { return callBase(new Base(), 5); }
  public static int viaTable(int i) { return TABLE[i & 15]; }
  public static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
  public static int hot(int n) {
    Op[] ops = { new Add(3), new Mul(2), new Add(1) };
    int s = 0;
    for (int i = 0; i < n; i++) s = ops[i % 3].apply(s) & 0xffff;
    return s;
  }
  public static int sum(int[] a) { int s = 0; for (int v : a) s += v; return s; }
  public static int fill(int n) { int[] a = new int[n]; for (int i = 0; i < n; i++) a[i] = i ^ (i >> 3); return sum(a); }
  public static int guarded(int x) {
    try { if (x < 0) throw new IllegalStateException("negative"); return x; } catch (IllegalStateException e) { return -e.getMessage().length(); }
  }
}
