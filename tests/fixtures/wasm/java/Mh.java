import java.lang.invoke.*;
import java.lang.reflect.Method;

/** MethodHandle call sites: invoke-polymorphic on MethodHandle.invoke and invokeExact over handles of each direct kind. */
public class Mh {
  int f = 7; static int sf = 3; long lf = 5; String s = "str";
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
}
