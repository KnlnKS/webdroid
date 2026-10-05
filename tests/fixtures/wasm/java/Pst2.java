/** A dex that arrives after Pst: it overrides the one implementation of Base.f that compiled code of Pst relied on. */
public class Pst2 extends Pst.Base {
  @Override public int f(int x) { return x * 100; }
  public static int sub() { return Pst.callBase(new Pst2(), 5); }
}
