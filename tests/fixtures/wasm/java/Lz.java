/** A devirtualised call that a later dex falsifies (Lz2). */
public class Lz {
  public interface Fn { int value(); }
  public static class X implements Fn { public int value() { return 3; } }
  public static class Y implements Fn { public int value() { return 5; } }
  public static class Z implements Fn { public int value() { return 7; } }
  public static Fn fn(int n) { return n == 0 ? new X() : n == 1 ? new Y() : new Z(); }
  public static int sites(Fn a, Fn b) { return 10 * a.value() + b.value(); }
  public static class A { public int f() { return 1; } }
  public static class B extends A { }
  public static int call(A a) { return a.f() + 10; }
  public static int test() { return call(new B()); }
  public static A first() { return new B(); }
  public static native A late();
  public static int active() { return late().f(); }
  public static int sum(int n) { int s = 0; for (int i = 0; i < n; i++) s += call(new B()); return s; }
  static int ticks;
  public static int tick(long a, Fn f) { return ++ticks; }
  public static void bump() { ticks += 100; }
}
