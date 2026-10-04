/** A devirtualised call that a later dex falsifies (Lz2). */
public class Lz {
  public static class A { public int f() { return 1; } }
  public static class B extends A { }
  public static int call(A a) { return a.f() + 10; }
  public static int test() { return call(new B()); }
}
