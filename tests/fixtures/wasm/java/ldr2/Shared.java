public class Shared implements Tag, NamespaceFace {
  public static int counter;
  public int childOnly = 42;
  public Shared peer;
  public static int bump() { return ++counter; }
  public static Shared make() { return new Shared(); }
  public static boolean same(Shared x, Shared y) { return x == y; }
  public static void boom() { throw new Boom(); }
  public static int guarded() { try { boom(); } catch (Boom e) { return 7; } return 0; }
  public Shared self() { return this; }
  public int tag() { return 2; }
  public static int optional(boolean enter) { return enter ? new AbsentOptional().value : 7; }
  public static int symbolic() { return SymbolicHelper.value(); }
  public static int symbolicOperands() {
    SymbolicOperands v = new SymbolicOperands();
    v.peer = v; v.f = -0.0f; v.d = -0.0; v.j = 0x123456789abcdef0L;
    return SymbolicOperands.check(v, v, v.f, v.f, v.d, v.j);
  }
  public static int catchOnly(boolean enter) {
    if (!enter) return 7;
    try { throw new IllegalStateException(); }
    catch (MissingCatch e) { return 1; }
    catch (CatchOnly e) { return 2; }
    catch (RuntimeException e) { return 42; }
  }
}
class SymbolicHelper { static int value() { return 42; } }
class CatchOnly extends RuntimeException {}
class MissingCatch extends RuntimeException {}

interface NamespaceFace {}
class AbsentOptional { int value = 9; }

class SymbolicOperands {
  SymbolicOperands peer;
  float f; double d; long j;
  static int check(SymbolicOperands a, SymbolicOperands b, float f, float g, double d, long j) {
    return (a == b && a.peer == a ? 1 : 0)
      | (Float.floatToRawIntBits(f) == 0x80000000 && Float.floatToRawIntBits(g) == 0x80000000 ? 2 : 0)
      | (Double.doubleToRawLongBits(d) == 0x8000000000000000L ? 4 : 0)
      | (j == 0x123456789abcdef0L ? 8 : 0);
  }
}
