import java.lang.reflect.*;

/** java.lang.reflect.Proxy: the handler sees each call with its Method and boxed arguments, and its result is unboxed or cast as ART does. */
public class Px {
  interface Greeter {
    String greet(String n); int add(int a, int b); long wide(long a, double d); void ping(); double dbl(); float flt(float x); boolean not(boolean b); char ch(char c); byte by(byte b); short sh(short s);
    Object any(); int[] ints(int n); String fail(int kind) throws java.io.IOException;
    default int dflt(int a) { return a + 1000; }
  }
  interface Other { int other(int x); }
  static int log;
  static class H implements InvocationHandler {
    final int mode;
    H(int mode) { this.mode = mode; }
    public Object invoke(Object p, Method m, Object[] a) throws Throwable {
      String n = m.getName(); log += n.hashCode() + (a == null ? -1 : a.length);
      if (n.equals("hashCode")) return 42;
      if (n.equals("equals")) return p == a[0];
      if (n.equals("toString")) return "proxy!";
      switch (n) {
        case "greet": return mode == 1 ? null : mode == 2 ? (Object) Integer.valueOf(5) : "hi ".concat((String) a[0]);
        case "add": return mode == 3 ? null : mode == 4 ? (Object) Long.valueOf(7L) : mode == 5 ? "x" : (Integer) a[0] + (Integer) a[1];
        case "wide": return (Long) a[0] * 2 + ((Double) a[1]).intValue();
        case "ping": log += 100; return mode == 6 ? (Object) "ignored" : null;
        case "dbl": return 2.5; case "flt": return (Float) a[0] * 2; case "not": return !(Boolean) a[0]; case "ch": return (char) ((Character) a[0] + 1);
        case "by": return (byte) ((Byte) a[0] + 100); case "sh": return (short) ((Short) a[0] * 300);
        case "any": return mode == 7 ? m : this;
        case "ints": return new int[(Integer) a[0]];
        case "fail": switch ((Integer) a[0]) { case 0: throw new java.io.IOException("io"); case 1: throw new IllegalStateException("ise"); case 2: throw new Exception("checked"); case 3: throw new Error("err"); default: return null; }
        case "dflt": return (Integer) a[0] * 2;
        case "other": return -(Integer) a[0];
      }
      throw new AssertionError(n);
    }
  }
  static Greeter make(int mode) { return (Greeter) Proxy.newProxyInstance(Px.class.getClassLoader(), new Class<?>[] {Greeter.class}, new H(mode)); }

  public static int calls(int n) {
    Greeter g = make(0); int r = g.greet("a").length() + g.add(n, 5) + (int) g.wide(n, 3.7) + (int) (g.dbl() * 10) + (int) g.flt(1.5f * n) + (g.not(n % 2 == 0) ? 1 : 0) + g.ch('a') + g.by((byte) n) + g.sh((short) n);
    g.ping(); r += g.ints(n % 5).length + g.dflt(n) + (int) g.any().getClass().getName().length() * 0;
    return r + log % 1000;
  }
  public static int objectMethods(int n) {
    Greeter g = make(0), h = make(0); return g.hashCode() + (g.equals(g) ? 1 : 0) + (g.equals(h) ? 2 : 0) + g.toString().length() + (Proxy.isProxyClass(g.getClass()) ? 8 : 0) + (Proxy.isProxyClass(Px.class) ? 16 : 0)
      + (Proxy.getInvocationHandler(g) instanceof H ? 32 : 0) + (g instanceof Greeter ? 64 : 0) + (g.getClass().getSuperclass() == Proxy.class ? 128 : 0) + (g.getClass() == h.getClass() ? 256 : 0);
  }
  public static int results(int n) {
    int r = 0;
    try { make(1).greet("x"); r += 1; } catch (Throwable t) { r += 100; }
    try { make(2).greet("x"); } catch (ClassCastException e) { r += 2; }
    try { make(3).add(1, 2); } catch (NullPointerException e) { r += 4; }
    try { make(4).add(1, 2); } catch (ClassCastException e) { r += 8; }
    try { make(5).add(1, 2); } catch (ClassCastException e) { r += 16; }
    make(6).ping();
    try { make(7).any(); r += 32; } catch (Throwable t) { r += 1000; }
    return r;
  }
  public static int exceptions(int n) {
    int r = 0; Greeter g = make(0);
    try { g.fail(0); } catch (java.io.IOException e) { r += 1; } catch (Throwable t) { r += 1000; }
    try { g.fail(1); } catch (IllegalStateException e) { r += 2; } catch (Throwable t) { r += 1000; }
    try { g.fail(2); } catch (UndeclaredThrowableException e) { r += 4 + (e.getCause().getMessage().length() == 7 ? 8 : 0); } catch (Throwable t) { r += 1000; }
    try { g.fail(3); } catch (Error e) { r += 16; } catch (Throwable t) { r += 1000; }
    try { g.fail(4); r += 32; } catch (Throwable t) { r += 1000; }
    return r;
  }
  public static int several(int n) {
    Object o = Proxy.newProxyInstance(Px.class.getClassLoader(), new Class<?>[] {Greeter.class, Other.class}, new H(0));
    return ((Other) o).other(n) + ((Greeter) o).add(1, 2) + (o instanceof Other ? 1000 : 0);
  }
  public static int illegal(int n) {
    int r = 0;
    try { Proxy.newProxyInstance(Px.class.getClassLoader(), new Class<?>[] {String.class}, new H(0)); } catch (IllegalArgumentException e) { r += 1; }
    try { Proxy.newProxyInstance(Px.class.getClassLoader(), new Class<?>[] {Greeter.class}, null); } catch (NullPointerException e) { r += 2; }
    return r;
  }
}
