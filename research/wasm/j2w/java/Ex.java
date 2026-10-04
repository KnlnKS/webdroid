/** Implicit exceptions, heap limits, stack overflow and a stack trace, as the Wasm tier raises them. */
public class Ex {
  static class D0 {}
  static class D1 extends D0 {}
  static class D2 extends D1 {}
  static class D3 extends D2 {}
  static class D4 extends D3 {}
  static class D5 extends D4 {}
  static class D6 extends D5 {}
  static class D7 extends D6 {}
  static class D8 extends D7 {}
  static class D9 extends D8 {}
  static class D10 extends D9 {}
  static class D11 extends D10 {}
  static class D12 extends D11 {}
  static class D13 extends D12 {}
  public static int deepTypes(int k) { Object o = k == 0 ? new D13() : new D5(); return (o instanceof D13 ? 1 : 0) + (o instanceof D12 ? 2 : 0) + (o instanceof D5 ? 4 : 0) + (o instanceof D0 ? 8 : 0); }
  static class P { int f() { return 1; } }
  static class Q extends P { }
  public static int div(int a, int b) { try { return a / b; } catch (ArithmeticException e) { return -1001; } }
  public static int idx(int i) { int[] a = new int[4]; try { return a[i]; } catch (ArrayIndexOutOfBoundsException e) { return -1002; } }
  public static int cast(int k) { P p = k == 0 ? new P() : new Q(); try { Q q = (Q) p; return 1; } catch (ClassCastException e) { return -1003; } }
  public static int neg(int n) { try { int[] a = new int[n]; return a.length; } catch (NegativeArraySizeException e) { return -1004; } }
  public static int npe(P p) { try { return p.f(); } catch (NullPointerException e) { return -1005; } }
  public static P mk(int k) { return k == 0 ? null : new Q(); }
  public static int oom(int n) { try { byte[] a = new byte[n]; return a.length; } catch (OutOfMemoryError e) { return -1006; } }
  static int[] sink;
  public static int churn(int n) { int i = 0; try { for (; i < n; i++) { sink = new int[1 << 20]; sink[0] = i; } } catch (OutOfMemoryError e) { return -1 - i; } return n; }
  public static int deep(int n) { return deep(n + 1) + 1; }
  static void c(int k) { if (k > 0) throw new RuntimeException(); }
  static void b(int k) { c(k); }
  public static Throwable a(int k) { try { b(k); return null; } catch (RuntimeException e) { return e; } }
}
