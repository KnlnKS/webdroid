public class Shared implements Tag {
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
}
