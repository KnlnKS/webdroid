import java.lang.invoke.*;

public class Bootstrap {
  static int links, retries, recursive;
  static volatile int racing, racingFailure;
  static MutableCallSite mutable;
  static VolatileCallSite volatileSite;
  static final MethodType INT = MethodType.methodType(int.class, int.class);
  public static int add(int bias, int a) { return bias + a; }
  static MethodHandle target(int bias) throws Exception {
    return MethodHandles.insertArguments(MethodHandles.lookup().findStatic(Bootstrap.class, "add", MethodType.methodType(int.class, int.class, int.class)), 0, bias);
  }
  public static CallSite fixed(MethodHandles.Lookup l, String n, MethodType t, int bias) throws Exception {
    if (l.lookupClass() != Dyn.class || !t.equals(INT) || !n.equals("fixed")) throw new AssertionError();
    links++;
    return new ConstantCallSite(l.findStatic(Dyn.class, "secret", INT));
  }
  public static CallSite collected(MethodHandles.Lookup l, String n, MethodType t, int... values) throws Exception {
    int sum = 0; for (int value : values) sum += value;
    return new ConstantCallSite(target(sum));
  }
  public static CallSite constants(MethodHandles.Lookup l, String n, MethodType t, String s, Class<?> c, MethodType mt, MethodHandle h) throws Throwable {
    if (!s.equals("payload") || c != Bootstrap.class || !mt.equals(INT) || h.type().parameterCount() != 2) throw new AssertionError();
    return new ConstantCallSite(target((int) h.invokeExact(2, 3)));
  }
  public static CallSite signature(MethodHandles.Lookup l, String n, MethodType t, Class<?> c, MethodType mt, MethodHandle h) {
    if (c.getClassLoader() != l.lookupClass().getClassLoader() || mt.returnType() != c || mt.parameterType(0) != c || !h.type().equals(t)) throw new AssertionError();
    return new ConstantCallSite(h);
  }
  public static CallSite scalars(MethodHandles.Lookup l, String n, MethodType t, long j, float f, double d) throws Exception {
    if (j != 4294967303L || Float.floatToRawIntBits(f) != 0x80000000 || d != 2.5) throw new AssertionError();
    return new ConstantCallSite(target((int) j + (int) d));
  }
  public static CallSite volatileChanging(MethodHandles.Lookup l, String n, MethodType t) throws Exception {
    return volatileSite = new VolatileCallSite(target(20));
  }
  public static CallSite reentrant(MethodHandles.Lookup l, String n, MethodType t) throws Exception {
    int candidate = ++recursive;
    if (candidate == 1) Dyn.reentrant(0);
    return new ConstantCallSite(target(candidate));
  }
  public static int throwing(int a) { throw new IllegalStateException("target failure"); }
  public static CallSite targetFailure(MethodHandles.Lookup l, String n, MethodType t) throws Exception {
    return new ConstantCallSite(l.findStatic(Bootstrap.class, "throwing", INT));
  }
  public static Object nonCallSite(MethodHandles.Lookup l, String n, MethodType t) { return "invalid"; }
  public static CallSite collectorMismatch(MethodHandles.Lookup l, String n, MethodType t, Object... values) throws Exception { return new ConstantCallSite(target(1)); }
  public static int tCustomNonCallSite(int a) { try { Dyn.nonCallSite(a); return -1; } catch (BootstrapMethodError e) { return 29; } }
  public static int artCollectorMismatch(int a) { try { Dyn.collectorMismatch(a); return -1; } catch (BootstrapMethodError e) { return e.getCause() instanceof ClassCastException ? 31 : -2; } }
  public static CallSite changing(MethodHandles.Lookup l, String n, MethodType t) throws Exception {
    return mutable = new MutableCallSite(target(10));
  }
  public static CallSite failure(MethodHandles.Lookup l, String n, MethodType t, int kind) throws Exception {
    retries++;
    if (kind == 0) throw new IllegalStateException("bootstrap failure");
    if (kind == 1) throw new AssertionError("bootstrap error");
    if (kind == 2) return null;
    return new ConstantCallSite(MethodHandles.constant(String.class, "wrong"));
  }
  public static CallSite race(MethodHandles.Lookup l, String n, MethodType t) throws Exception {
    int candidate;
    synchronized (Bootstrap.class) { candidate = ++racing; }
    while (racing < 2) Thread.sleep(1);
    return new ConstantCallSite(target(candidate));
  }
  public static CallSite raceFailure(MethodHandles.Lookup l, String n, MethodType t) throws Exception {
    int candidate;
    synchronized (Bootstrap.class) { candidate = ++racingFailure; }
    while (racingFailure < 2) Thread.sleep(1);
    if (candidate == 1) throw new IllegalStateException("losing bootstrap");
    return new ConstantCallSite(target(candidate));
  }
  public static int artRaceFailure(int a) throws Exception {
    int[] results = new int[2];
    Thread first = new Thread() { public void run() { try { results[0] = Dyn.raceFailure(0); } catch (BootstrapMethodError e) { results[0] = 7; } } };
    Thread second = new Thread() { public void run() { try { results[1] = Dyn.raceFailure(0); } catch (BootstrapMethodError e) { results[1] = 7; } } };
    first.start(); second.start(); first.join(); second.join();
    return results[0] + results[1] == 9 && Dyn.raceFailure(0) == 2 && racingFailure == 2 ? 1 : -1;
  }
  public static int tCustomFixed(int a) { int x = Dyn.fixed(a), y = Dyn.fixed(a); return x + y + links; }
  public static int tCustomCollected(int a) { return Dyn.collected(a); }
  public static int tCustomConstants(int a) { return Dyn.constants(a); }
  public static int tCustomMutable(int a) throws Exception {
    Dyn.changing(a); mutable.setTarget(target(a)); return Dyn.changing(a);
  }
  public static int tCustomScalars(int a) { return Dyn.scalars(a); }
  public static int tCustomVolatile(int a) throws Exception {
    Dyn.volatileChanging(a); volatileSite.setTarget(target(a + 1)); return Dyn.volatileChanging(a);
  }
  public static int tCustomReentrant(int a) { int x = Dyn.reentrant(a); return recursive == 2 ? x - a : -1; }
  public static int tCustomTargetFailure(int a) { try { Dyn.targetFailure(a); return -1; } catch (IllegalStateException e) { return 23; } }
  public static int tCustomFailure(int a) {
    try { Dyn.failure(a); return -1; } catch (BootstrapMethodError e) { return e.getCause() instanceof IllegalStateException ? 7 : -2; }
  }
  public static int tCustomError(int a) { try { Dyn.error(a); return -1; } catch (AssertionError e) { return 11; } }
  public static int tCustomNull(int a) { try { Dyn.nullSite(a); return -1; } catch (BootstrapMethodError e) { return 13; } }
  public static int tCustomWrong(int a) { try { Dyn.wrong(a); return -1; } catch (BootstrapMethodError e) { return 17; } }
  public static int tCustomRetry(int a) { int before = retries; tCustomFailure(a); tCustomFailure(a); return retries - before; }
  public static int tCustomRace(int a) throws Exception {
    int[] results = new int[2];
    Thread first = new Thread() { public void run() { results[0] = Dyn.race(a); } };
    Thread second = new Thread() { public void run() { results[1] = Dyn.race(a); } };
    first.start(); second.start(); first.join(); second.join();
    return results[0] == results[1] && racing == 2 ? 1 : -1;
  }
}
