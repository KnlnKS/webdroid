import java.lang.reflect.Field;
import java.lang.ref.WeakReference;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** The natives that take objects: Field's reads and writes with their widening and checks, direct buffers, Class.forName, the running Thread, Character's Unicode properties, References. */
public class N {
  static int sf = 7;
  int f = 5; long lf = 1L << 40; float ff = 1.5f; double df = 2.5; boolean bf; char cf = 'x'; short sh = -3; byte by = -2; String s = "s"; private int hidden = 11; final int fin = 4;
  static Field field(String name) throws Exception { Field f = N.class.getDeclaredField(name); f.setAccessible(true); return f; }
  public static int fieldsInt(int n) throws Exception {
    N o = new N(); Field f = field("f");
    f.setInt(o, n); return f.getInt(o) + (Integer) f.get(o) + (int) f.getFloat(o) + (int) f.getDouble(o);
  }
  public static int fieldsLong(int n) throws Exception {
    N o = new N(); int r = 0; Field l = field("lf");
    l.setLong(o, n); r += (int) l.getLong(o); l.set(o, Integer.valueOf(n + 1)); r += (int) (long) (Long) l.get(o);
    return r;
  }
  public static int fieldsFloat(int n) throws Exception {
    N o = new N(); int r = 0; Field ff = field("ff");
    ff.setInt(o, n); r += (int) ff.getFloat(o);
    return r;
  }
  public static int fieldsFloatShort(int n) throws Exception {
    N o = new N(); Field ff = field("ff");
    ff.set(o, Short.valueOf((short) (n + 2))); return (int) ff.getDouble(o);
  }
  public static int fieldsFloatLong(int n) throws Exception {
    N o = new N(); Field ff = field("ff");
    ff.setLong(o, 1L << 33); return (int) (ff.getFloat(o) / 4096f);
  }
  public static int fieldsDouble(int n) throws Exception {
    N o = new N(); int r = 0; Field df = field("df");
    df.setFloat(o, n + 0.5f); r += (int) (df.getDouble(o) * 2); df.set(o, Character.valueOf('a')); r += (int) df.getDouble(o);
    return r;
  }
  public static int fieldsOther(int n) throws Exception {
    N o = new N(); int r = 0; Field bf = field("bf"), cf = field("cf"), sh = field("sh"), by = field("by"), s = field("s"), st = field("sf");
    bf.setBoolean(o, n > 2); r += bf.getBoolean(o) ? 1 : 0; r += (Boolean) bf.get(o) ? 2 : 0;
    cf.setChar(o, (char) (n + 65)); r += cf.getChar(o) + cf.getInt(o); sh.setShort(o, (short) -n); r += sh.getShort(o) + sh.getInt(o); by.setByte(o, (byte) n); r += by.getByte(o) + by.getShort(o);
    s.set(o, "v" + n); r += ((String) s.get(o)).length(); s.set(o, null); r += s.get(o) == null ? 5 : 0;
    st.setInt(null, n); r += st.getInt(null) + N.sf; st.set(null, Integer.valueOf(n * 2)); r += sf;
    return r + field("hidden").getInt(o);
  }
  public static int errWiden(int n) throws Exception { try { field("f").setLong(new N(), 1L); } catch (IllegalArgumentException e) { return 1; } return 0; }
  public static int errType(int n) throws Exception { try { field("f").getBoolean(new N()); } catch (IllegalArgumentException e) { return 1; } return 0; }
  public static int errNull(int n) throws Exception { try { field("f").get(null); } catch (NullPointerException e) { return 1; } return 0; }
  public static int errReceiver(int n) throws Exception { try { field("f").get("x"); } catch (IllegalArgumentException e) { return 1; } return 0; }
  public static int errRefType(int n) throws Exception { try { field("s").set(new N(), Integer.valueOf(1)); } catch (IllegalArgumentException e) { return 1; } return 0; }
  public static int errNullBox(int n) throws Exception { try { field("f").set(new N(), null); } catch (IllegalArgumentException e) { return 1; } return 0; }
  public static int errNarrow(int n) throws Exception { try { field("f").set(new N(), Long.valueOf(1)); } catch (IllegalArgumentException e) { return 1; } return 0; }
  public static int errFinal(int n) throws Exception { N o = new N(); try { field("fin").setInt(o, 1); return 0; } catch (IllegalAccessException e) { return 9 + o.fin; } }
  private static class PrivInner {} protected static class ProtInner {} static final class FinInner {} public interface PubIface {} abstract static class AbsInner {}
  public static int inner(int n) {
    int r = N.class.getDeclaredClasses().length * 100000;
    for (Class<?> c : N.class.getDeclaredClasses()) r += c.getModifiers();
    return r + PrivInner.class.getModifiers() + ProtInner.class.getModifiers() + n * 0;
  }
  @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME) @interface RA {}
  @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.CLASS) @interface CA {}
  @RA @CA static class Annotated {
    @RA int f; @CA int g; int plain; static @RA int sf;
    @RA Annotated() {} Annotated(int a) {} private Annotated(String s, long l) {}
    @RA void m() {} @CA void n() {} public static void p(int a, String b) {} private int q() { return 0; } @RA static long s() { return 1; }
  }
  @RA static class Sub extends Annotated {}
  public static int members(int n) throws Exception {
    int r = 0;
    for (Class<?> c : new Class<?>[] {N.class, Annotated.class, PrivInner.class, int.class, int[].class, String[][].class, String.class, Object.class, void.class}) r = r * 31 + c.getSimpleName().hashCode();
    Object anon = new Object() {};
    class Local {}
    r = r * 31 + anon.getClass().getSimpleName().length() * 7 + Local.class.getSimpleName().hashCode();
    for (Class<?> c : new Class<?>[] {Annotated.class, Sub.class, N.class}) r = r * 31 + (c.isAnnotationPresent(RA.class) ? 1 : 0) + (c.isAnnotationPresent(CA.class) ? 2 : 0);
    for (java.lang.reflect.Method m : Annotated.class.getDeclaredMethods()) r += m.getName().hashCode() + m.getParameterTypes().length * 3 + m.getModifiers() + (m.isAnnotationPresent(RA.class) ? 7 : 0) + (m.isAnnotationPresent(CA.class) ? 11 : 0);
    r = r * 31 + Annotated.class.getDeclaredMethods().length;
    for (java.lang.reflect.Constructor<?> k : Annotated.class.getDeclaredConstructors()) r += k.getParameterTypes().length * 5 + k.getModifiers() + (k.isAnnotationPresent(RA.class) ? 13 : 0);
    r = r * 31 + Annotated.class.getConstructors().length + Annotated.class.getMethods().length * 1000;
    for (java.lang.reflect.Field f : Annotated.class.getDeclaredFields()) r += f.getName().hashCode() + (f.isAnnotationPresent(RA.class) ? 17 : 0) + (f.isAnnotationPresent(CA.class) ? 19 : 0);
    r += (Annotated.class.getDeclaringClass() == N.class ? 100 : 0) + (N.class.getDeclaringClass() == null ? 200 : 0) + (anon.getClass().getDeclaringClass() == null ? 400 : 0);
    r += (anon.getClass().getEnclosingMethod().getName().hashCode() & 0xff) + (anon.getClass().getEnclosingClass() == N.class ? 800 : 0) + (Local.class.getEnclosingMethod() != null ? 1600 : 0) + (Local.class.getEnclosingConstructor() == null ? 3200 : 0);
    return r + n * 0;
  }
  public enum Color { RED, GREEN }
  @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME) @interface Nested { int value(); }
  @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME) @interface Full {
    int i() default 5; long l() default 1L << 40; String s() default "dflt"; boolean z() default true; byte b() default 3; short sh() default 4; char ch() default 'q'; float f() default 1.5f; double d() default 2.5;
    Class<?> c() default Object.class; Color e() default Color.GREEN; int[] ia() default {1, 2}; String[] sa() default {}; Class<?>[] ca() default {}; Color[] ea() default {Color.RED};
    Nested n() default @Nested(7); Nested[] na() default {}; long[] la() default {}; double[] da() default {}; boolean[] za() default {true, false}; char[] cha() default {'a'};
  }
  @Full(i = 9, s = "x", z = false, ia = {3, 4, 5}, sa = {"a", "bb"}, c = String.class, e = Color.RED, n = @Nested(8), na = {@Nested(1), @Nested(2)}, la = {7L}, da = {0.5}, ch = 'z', f = 2.25f, sh = 300, b = -1, ca = {int.class, String[].class}, ea = {Color.GREEN, Color.RED})
  static class Subject {
    @Full int field; @Nested(6) static int other;
    @Full(i = 1) void m(@Nested(3) int a, int b, @Nested(4) @Full String c) {} void plain() {} @Full Subject() {}
  }
  private static int full(Full a) {
    int r = a.i() + a.s().length() * 3 + (a.z() ? 1 : 0) + (int) (a.l() >> 38) + a.b() + a.sh() + a.ch() + (int) (a.f() * 4) + (int) (a.d() * 4) + a.c().getName().length() * 5 + a.e().ordinal() * 7 + a.n().value() * 11;
    for (int x : a.ia()) r += x * 13; for (String x : a.sa()) r += x.length() * 17; for (Class<?> x : a.ca()) r += x.getName().length() * 19; for (Color x : a.ea()) r += x.ordinal() * 23 + 1;
    for (Nested x : a.na()) r += x.value() * 29; for (long x : a.la()) r += (int) x * 31; for (double x : a.da()) r += (int) (x * 8); for (boolean x : a.za()) r += x ? 37 : 41; for (char x : a.cha()) r += x;
    return r + a.annotationType().getName().length() + a.ia().length * 43;
  }
  public static int annots(int n) throws Exception {
    Full a = Subject.class.getAnnotation(Full.class), d = Subject.class.getDeclaredField("field").getAnnotation(Full.class), m = Subject.class.getDeclaredMethod("m", int.class, int.class, String.class).getAnnotation(Full.class);
    int r = full(a) * 3 + full(d) * 5 + full(m) * 7;
    r += (a.equals(Subject.class.getAnnotation(Full.class)) ? 1 : 0) + (a.equals(d) ? 2 : 0) + (d.equals(Subject.class.getDeclaredField("field").getAnnotation(Full.class)) ? 4 : 0);
    r += Subject.class.getDeclaredAnnotations().length * 100 + Subject.class.getAnnotations().length * 1000 + N.class.getAnnotations().length * 10000;
    java.lang.reflect.Method mm = Subject.class.getDeclaredMethod("m", int.class, int.class, String.class);
    java.lang.annotation.Annotation[][] pa = mm.getParameterAnnotations();
    r += pa.length * 100000 + pa[0].length * 1000000 + pa[1].length * 3000000 + pa[2].length * 7000000 + ((Nested) pa[0][0]).value();
    r += Subject.class.getDeclaredField("other").getAnnotation(Nested.class).value() + Subject.class.getDeclaredField("other").getDeclaredAnnotations().length * 50;
    r += Subject.class.getDeclaredMethod("plain").getAnnotations().length + (Subject.class.getDeclaredMethod("plain").getAnnotation(Full.class) == null ? 7 : 0);
    r += Subject.class.getDeclaredConstructor().getAnnotation(Full.class).i() * 77 + Full.class.getAnnotations().length * 123;
    return r + n * 0;
  }
  public static int forName(int n) throws Exception {
    int r = 0;
    r += Class.forName("java.util.ArrayList").getName().length() + Class.forName("[I").getName().length() + Class.forName("[Ljava.lang.String;").getName().length();
    r += Class.forName("N").getDeclaredFields().length;
    try { Class.forName("no.such.Klass" + n); } catch (ClassNotFoundException e) { r += 1000; }
    try { Class.forName("int"); } catch (ClassNotFoundException e) { r += 2000; }
    return r + (Class.forName("N", false, N.class.getClassLoader()) == N.class ? 1 : 0);
  }
  public static int direct(int n) {
    ByteBuffer b = ByteBuffer.allocateDirect(64 + n);
    int r = b.isDirect() ? 1 : 0;
    b.putInt(0, 0x01020304 + n).putLong(8, 0x0102030405060708L * (n + 1)).putShort(16, (short) (n * 77)).put(18, (byte) n).putDouble(24, n + 0.25).putFloat(32, n + 0.5f).putChar(36, (char) (n + 1000));
    r += b.getInt(0) + (int) b.getLong(8) + b.getShort(16) + b.get(18) + (int) (b.getDouble(24) * 4) + (int) (b.getFloat(32) * 2) + b.getChar(36) + b.getInt(1);
    b.order(ByteOrder.LITTLE_ENDIAN); r += b.getInt(0) + (int) (b.getLong(8) >> 8);
    byte[] src = new byte[40]; for (int i = 0; i < src.length; i++) src[i] = (byte) (i * 7 + n);
    b.position(40); b.limit(64); b.put(src, 0, 20); r += b.position(); b.flip(); b.position(40); byte[] back = new byte[20]; b.get(back); for (byte x : back) r = r * 31 + x;
    b.position(0); b.limit(40); java.nio.IntBuffer ib = b.asIntBuffer(); int[] ints = new int[5]; ib.get(ints, 0, 5); for (int x : ints) r = r * 31 + x;
    ib.position(0); ib.put(new int[] { n, n + 1, n + 2 }); r += b.getInt(8);
    return r;
  }
  public static int thread(int n) {
    Thread t = Thread.currentThread();
    int r = t.getName().length() + t.getPriority() + (t.isDaemon() ? 1 : 0) + (t.isAlive() ? 10 : 0) + t.getState().ordinal() * 100 + (t == Thread.currentThread() ? 1000 : 0);
    r += Thread.interrupted() ? 5 : 0; t.interrupt(); r += t.isInterrupted() ? 20000 : 0; r += Thread.interrupted() ? 50000 : 0; r += Thread.interrupted() ? 7 : 0;
    r += new Thread("w" + n).getState().ordinal() * 10000 + t.getThreadGroup().getName().length();
    return r;
  }
  public static int unicode(int n) {
    int[] cps = { 'a', 'Z', '5', ' ', 0xe9, 0x3b1, 0x5d0, 0x627, 0x660, 0x4e2d, 0x1f600, 0x10400, 0xff21, 0x2028, 0x300, 0x28, 0x29 };
    int r = 0;
    for (int c : cps) {
      r = r * 31 + Character.getType(c) + Character.getDirectionality(c) * 3 + (Character.isLetter(c) ? 1 : 0) + (Character.isDigit(c) ? 2 : 0) + (Character.isMirrored(c) ? 4 : 0)
        + (Character.isUpperCase(c) ? 8 : 0) + (Character.isLowerCase(c) ? 16 : 0) + (Character.isWhitespace(c) ? 32 : 0) + (Character.isSpaceChar(c) ? 64 : 0)
        + (Character.isAlphabetic(c) ? 128 : 0) + (Character.isIdeographic(c) ? 256 : 0) + Character.toUpperCase(c) + Character.toLowerCase(c) + Character.toTitleCase(c) + Character.digit(c, 16)
        + Character.getNumericValue(c) + (Character.isDefined(c) ? 512 : 0) + (Character.isIdentifierIgnorable(c) ? 1024 : 0) + (Character.isUnicodeIdentifierStart(c) ? 2048 : 0) + (Character.isUnicodeIdentifierPart(c) ? 4096 : 0);
    }
    return r + Character.getName(0x3b1 + n % 5).length();
  }
  public static int refs(int n) {
    Object o = new int[n + 1]; WeakReference<Object> w = new WeakReference<>(o);
    int r = w.get() == o ? 1 : 0; w.clear(); r += w.get() == null ? 4 : 0;
    return r;
  }
}
