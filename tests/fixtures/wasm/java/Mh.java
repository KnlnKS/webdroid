import java.lang.invoke.*;
import java.lang.reflect.Method;

/** MethodHandle call sites: invoke-polymorphic on MethodHandle.invoke and invokeExact over handles of each direct kind. */
public class Mh {
  int f = 7; static int sf = 3; long lf = 5; String s = "str";
  final int readOnly = 23;
  static int initializations;
  static class Dormant { static int f = ++initializations; }
  static int add(int a, int b) { return a + b; }
  static long wide(long a, double d, int i) { return a + (long) d + i; }
  static float flt(float a, boolean z, char c, byte b, short s) { return z ? a + c + b + s : -a; }
  static void sink(int a) { sf += a; }
  static int boom(int a) { if (a > 0) throw new IllegalStateException("boom"); return a; }
  int plus(int a) { return f + a; }
  private int priv(int a) { return f * a; }
  static Object obj(Object o) { return o; }
  static final MethodHandles.Lookup L = MethodHandles.lookup();
  static MethodType mt(Class<?> r, Class<?>... p) { return MethodType.methodType(r, p); }

  public static int tStatic(int a) throws Throwable { return (int) L.findStatic(Mh.class, "add", mt(int.class, int.class, int.class)).invokeExact(a, 4); }
  public static long tWide(int a) throws Throwable { return (long) L.findStatic(Mh.class, "wide", mt(long.class, long.class, double.class, int.class)).invokeExact((long) a * 3, a * 0.5, a); }
  public static int tFloat(int a) throws Throwable { return Float.floatToIntBits((float) L.findStatic(Mh.class, "flt", mt(float.class, float.class, boolean.class, char.class, byte.class, short.class)).invokeExact(a * 1.5f, (a & 1) == 0, (char) 65, (byte) a, (short) -a)); }
  public static int tVirtual(int a) throws Throwable { return (int) L.findVirtual(Mh.class, "plus", mt(int.class, int.class)).invokeExact(new Mh(), a); }
  public static int tString(int a) throws Throwable { String s = a == 0 ? "" : "abcdefghij".substring(0, a % 10); return (int) L.findVirtual(String.class, "length", mt(int.class)).invokeExact(s); }
  public static int tInvokeBox(int a) throws Throwable { Object r = L.findStatic(Mh.class, "add", mt(int.class, int.class, int.class)).invoke(Integer.valueOf(a), (short) 2); return (Integer) r; }
  public static long tInvokeWiden(int a) throws Throwable { return (long) L.findStatic(Mh.class, "add", mt(int.class, int.class, int.class)).invoke((byte) a, 9); }
  public static int tInvokeObject(int a) throws Throwable { Object r = (Object) L.findStatic(Mh.class, "obj", mt(Object.class, Object.class)).invoke("xy"); return r == null ? 0 : r.hashCode(); }
  public static int tVoid(int a) throws Throwable { int before = sf; L.findStatic(Mh.class, "sink", mt(void.class, int.class)).invokeExact(a); return sf - before; }
  public static int tGetter(int a) throws Throwable { Mh m = new Mh(); m.f = a; return (int) L.findGetter(Mh.class, "f", int.class).invokeExact(m); }
  public static int tSetter(int a) throws Throwable { Mh m = new Mh(); L.findSetter(Mh.class, "lf", long.class).invokeExact(m, (long) a * 7); return (int) m.lf; }
  public static int tStaticGetter(int a) throws Throwable { sf = a; return (int) L.findStaticGetter(Mh.class, "sf", int.class).invokeExact(); }
  public static int tStaticSetter(int a) throws Throwable { L.findStaticSetter(Mh.class, "sf", int.class).invokeExact(a * 2); return sf; }
  public static int tRefGetter(int a) throws Throwable { return ((String) L.findGetter(Mh.class, "s", String.class).invokeExact(new Mh())).length() + a; }
  public static int tUnreflect(int a) throws Throwable { Method m = Mh.class.getDeclaredMethod("add", int.class, int.class); return (int) L.unreflect(m).invokeExact(a, a); }
  public static int tPrivate(int a) throws Throwable { Method m = Mh.class.getDeclaredMethod("priv", int.class); m.setAccessible(true); return (int) L.unreflect(m).invokeExact(new Mh(), a); }
  public static int tThrows(int a) throws Throwable { try { return (int) L.findStatic(Mh.class, "boom", mt(int.class, int.class)).invokeExact(a); } catch (IllegalStateException e) { return -100; } }
  public static int tNullRecv(int a) throws Throwable { try { return (int) L.findVirtual(Mh.class, "plus", mt(int.class, int.class)).invokeExact((Mh) null, a); } catch (NullPointerException e) { return -200; } }
  public static int tWrongType(int a) throws Throwable { try { return (int) L.findStatic(Mh.class, "add", mt(int.class, int.class, int.class)).invokeExact((long) a, 4); } catch (WrongMethodTypeException e) { return -300; } }
  public static int tCast(int a) throws Throwable { try { return (int) L.findStatic(Mh.class, "add", mt(int.class, int.class, int.class)).invoke((Object) "s", 4); } catch (ClassCastException e) { return -400; } }
  /** a combinator: its handle is a transformer, which needs ART's EmulatedStackFrame (link/mhandles.ts) */
  public static int tBind(int a) throws Throwable { return (int) L.findVirtual(Mh.class, "plus", mt(int.class, int.class)).bindTo(new Mh()).invokeExact(a); }
  public static int tType(int a) throws Throwable { return L.findStatic(Mh.class, "add", mt(int.class, int.class, int.class)).type().parameterCount() + a; }
  public static int tConstStatic(int a) throws Throwable { return (int) Mc.hStatic().invokeExact(a, 4); }
  public static int tConstVirtual(int a) throws Throwable { return (int) Mc.hVirtual().invokeExact((Mh) new Mc(), a); }
  public static int tConstInterface(int a) throws Throwable { return ((String) Mc.hInterface().invoke((Ig) new Pq(a, "name"))).length(); }
  public static int tConstDirect(int a) throws Throwable { return (int) Mc.hDirect().invokeExact(new Mc(), a); }
  public static int tConstSuper(int a) throws Throwable { return (int) Mc.hSuper().invoke(new Mc(), a); }
  public static int tConstConstructor(int a) throws Throwable { return ((Mh) Mc.hConstructor().invokeExact()).f + a; }
  public static int tConstString(int a) throws Throwable { return ((String) Mc.hStringConstructor().invokeExact(new char[]{'a', 'b'})).length() + a; }
  public static int tConstClone(int a) throws Throwable {
    int[] source = {a}; int[] copy = (int[]) (Object) Mc.hClone().invokeExact(source);
    copy[0]++; return copy != source && source[0] == a ? copy[0] : -999;
  }
  public static int tConstFields(int a) throws Throwable {
    Mh m = new Mh(); Mc.hPut().invokeExact(m, a); Mc.hStaticPut().invokeExact(a + 2);
    return (int) Mc.hGet().invokeExact(m) + (int) Mc.hStaticGet().invokeExact();
  }
  public static int tConstType(int a) {
    MethodType t = Mc.type();
    return (t == Mc.type() && t.parameterCount() == 3 && t.parameterType(0) == String[].class && t.parameterType(1) == long.class
      && t.parameterType(2) == double.class && t.returnType() == Object.class ? 100 : -100) + a;
  }
  public static int tConstErrors(int a) {
    int errors = 0;
    try { Mc.hDenied(); } catch (IllegalAccessError e) { errors++; }
    try { Mc.hMissing(); } catch (NoSuchMethodError e) { errors += 2; }
    try { Mc.hWrongKind(); } catch (IncompatibleClassChangeError e) { errors += 4; }
    try { Mc.missingType(); } catch (NoClassDefFoundError e) { errors += 8; }
    try { Mc.hMissingField(); } catch (NoSuchFieldError e) { errors += 16; }
    try { Mc.hFinalPut(); } catch (IllegalAccessError e) { errors += 32; }
    try { Mc.hMissingConstructor(); } catch (NoSuchMethodError e) { errors += 64; }
    return errors + a;
  }
  public static int tConstNoInit(int a) {
    Mc.dormantType(); Mc.hDormant(); return initializations + a;
  }
  static int waiting(int a, Thread thread, Object lock) throws InterruptedException {
    if (Thread.currentThread() != thread || !Thread.holdsLock(lock)) return -999;
    Thread.sleep(1);
    if (a < 0) throw new IllegalStateException();
    return a + 1;
  }
  public static int tConstWait(int a) throws Throwable {
    Object lock = Mh.class;
    synchronized (lock) {
      try { return (int) Mc.hWait().invokeExact(a, Thread.currentThread(), lock); }
      catch (IllegalStateException e) { return -777; }
    }
  }
}
