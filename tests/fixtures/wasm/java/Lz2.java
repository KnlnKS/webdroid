public class Lz2 {
  public static class C extends Lz.A { public int f() { return 2; } }
  public static int test() { return Lz.call(new C()); }
  public static Lz.A make() { return new C(); }
}
