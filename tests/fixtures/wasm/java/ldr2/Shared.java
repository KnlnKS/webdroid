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
