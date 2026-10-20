import java.util.ArrayList;
/** A platform method the build devirtualised (ArrayList.contains calls indexOf), and a later dex that falsifies it (Aot2). */
public class Aot {
  public static class MyList extends ArrayList<Object> {}
  public static int plain() { return new ArrayList<Object>().contains("x") ? 1 : 0; }
  public static int inherited() { return new MyList().contains("x") ? 1 : 0; }

  // bodies a statically bound call runs in place (inline.ts): a forwarder keeps its frame, a constructor its stores, a static read its order.
  // Bits: 1 and 2 the frames of a trace made and of one thrown in place, 4 the initialization order, 8 the stores, 16 the frame of a null object's access
  static final class Pair { final int a; final long b; Pair(int a, long b) { this.a = a; this.b = b; } }
  static int order;
  static Object log(int k) { order = order * 10 + k; return null; }
  static class A { static final Object X = log(1); }
  static class B { static { log(2); } static void take(Object o) {} }
  static void readThenCall() { B.take(A.X); }
  static Throwable made() { return new Throwable(); }
  static Throwable forward() { return made(); }
  static void fail() { throw new IllegalStateException(); }
  static void forwardFail() { fail(); }
  static int first(Pair p) { return p.a; }
  static int frames(StackTraceElement[] s, String... names) { for (int i = 0; i < names.length; i++) if (!s[i].getMethodName().equals(names[i])) return 0; return 1; }
  public static int inlined() {
    int r = frames(forward().getStackTrace(), "made", "forward", "inlined");
    try { forwardFail(); } catch (IllegalStateException e) { r |= frames(e.getStackTrace(), "fail", "forwardFail", "inlined") << 1; }
    try { first(null); } catch (NullPointerException e) { r |= frames(e.getStackTrace(), "first", "inlined") << 4; }
    readThenCall();
    Pair p = new Pair(3, 4L << 40);
    return r | (order == 12 ? 4 : 0) | (p.a == 3 && p.b == 4L << 40 ? 8 : 0);
  }
}
