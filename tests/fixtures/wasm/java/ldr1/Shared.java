public class Shared implements Tag, NamespaceFace {
  public static int counter;
  public Shared peer;
  public static int bump() { return ++counter; }
  public static Shared make() { return new Shared(); }
  public static boolean same(Shared x, Shared y) { return x == y; }
  public static void boom() { throw new Boom(); }
  public static int guarded() { try { boom(); } catch (Boom e) { return 7; } return 0; }
  public Shared self() { return this; }
  public int tag() { return 1; }
  public static int optional(boolean enter) { return enter ? new AbsentOptional().value : 7; }
  public static int symbolic() { return SymbolicHelper.value(); }
}
class SymbolicHelper { static int value() { return 11; } }

interface NamespaceFace {}
class AbsentOptional { int value = 9; }
