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
