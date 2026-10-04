/** Records, whose toString, equals and hashCode javac compiles to invoke-custom ObjectMethods.bootstrap; d8 keeps them with --no-desugaring. */
public class Rec {
  static final int[] SHARED = {1, 2};
  record Point(int x, long y, String name, double d, float f, Object o, int[] arr, char c, boolean b, byte by, short s) {}
  record Empty() {}
  record Gen<T>(T t, Point p) {}
  public record Pub(int a, Pub next) {}

  static Point mk(int a, int diff) {
    return new Point(a + (diff == 1 ? 1 : 0), 5_000_000_000L * a + (diff == 2 ? 1 : 0), a % 3 == 0 ? null : (diff == 3 ? "m" : "n"),
      a * 1.5 + (diff == 4 ? 1 : 0), a * 2.5f + (diff == 5 ? 1 : 0), diff == 6 ? Integer.valueOf(a) : (a % 2 == 0 ? null : "o"), diff == 7 ? new int[] {a} : diff == 12 ? SHARED : null,
      (char) ('a' + a % 26 + (diff == 8 ? 1 : 0)), a % 2 == 0 != (diff == 9), (byte) (a + (diff == 10 ? 1 : 0)), (short) (a * 300 + (diff == 11 ? 1 : 0)));
  }
  public static int ts(int a) { return mk(a, 0).toString().hashCode(); }
  public static int hc(int a) { return mk(a, 0).hashCode(); }
  public static int eq(int a, int diff) { return mk(a, diff == 12 ? 12 : 0).equals(mk(a, diff)) ? 1 : 0; }
  public static int eqNaN(int a) { double d = a == 0 ? Double.NaN : a == 1 ? -0.0 : 0.0; return new Gen<Double>(d, null).equals(new Gen<Double>(a == 1 ? 0.0 : d, null)) ? 1 : 0; }
  public static int eqOther(int a) { Object o = a == 0 ? null : a == 1 ? "x" : a == 2 ? new Empty() : mk(a, 0); return mk(a, 0).equals(o) ? 1 : 0; }
  public static int empty(int a) { return new Empty().hashCode() + (new Empty().equals(new Empty()) ? 10 : 0) + new Empty().toString().length(); }
  public static int nested(int a) { return new Gen<Pub>(new Pub(a, new Pub(a + 1, null)), mk(a, 0)).toString().hashCode(); }
  public static int recordInfo(int a) { return (Point.class.isRecord() ? 1 : 0) + (Rec.class.isRecord() ? 10 : 0) + Point.class.getDeclaredConstructors().length * 100 + Point.class.getSimpleName().length() * 1000 + Point.class.getDeclaredMethods().length * 10000; }
  public static int nullRecv(int a) { Point p = a == 0 ? null : mk(a, 0); try { return p.hashCode(); } catch (NullPointerException e) { return -1; } }
}
