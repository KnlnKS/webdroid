/** A devirtualised call that a later dex falsifies (Lz2). */
public class Lz {
  public static class A { public int f() { return 1; } }
  public static class B extends A { }
  public static int call(A a) { return a.f() + 10; }
  public static int test() { return call(new B()); }
  public static A first() { return new B(); }
  public static native A late();
  public static int active() { return late().f(); }
  public static int sum(int n) { int s = 0; for (int i = 0; i < n; i++) s += call(new B()); return s; }
}
