/** Linked against a Base whose m() is concrete; Base is then recompiled abstract (java/am2) so Sub, which does not override it, inherits an abstract method. */
public class Am {
  static class Sub extends AmBase { }
  static class Ok1 extends AmBase { int m() { return 1; } }
  static class Ok2 extends AmBase { int m() { return 2; } }
  public static int run(int n) {
    int r = 0;
    for (AmBase b : new AmBase[] {new Ok1(), new Ok2(), new Sub()}) {
      try { r += b.m(); } catch (AbstractMethodError e) { r += 100; }
    }
    return r;
  }
  public static void main(String[] a) { System.out.println(run(0)); }
}
