import java.lang.invoke.*;

/** VarHandle access modes over fields made with MethodHandles.Lookup.findVarHandle and findStaticVarHandle, and over array elements. */
public class Vh {
  int i; long l; String s; boolean z; short sh; float f; double d; volatile int vi; byte by; char ch;
  static int si; static long sl; static String ss; static float sf; static double sd; static boolean sz; static short ssh;
  static final VarHandle I, L, S, Z, SH, F, D, VI, BY, CH, SI, SL, SS, SF, SD, SZ, SSH, AI, AJ, AS, AB;
  static {
    try {
      MethodHandles.Lookup lk = MethodHandles.lookup();
      I = lk.findVarHandle(Vh.class, "i", int.class); L = lk.findVarHandle(Vh.class, "l", long.class); S = lk.findVarHandle(Vh.class, "s", String.class);
      Z = lk.findVarHandle(Vh.class, "z", boolean.class); SH = lk.findVarHandle(Vh.class, "sh", short.class); F = lk.findVarHandle(Vh.class, "f", float.class);
      D = lk.findVarHandle(Vh.class, "d", double.class); VI = lk.findVarHandle(Vh.class, "vi", int.class); BY = lk.findVarHandle(Vh.class, "by", byte.class); CH = lk.findVarHandle(Vh.class, "ch", char.class);
      SI = lk.findStaticVarHandle(Vh.class, "si", int.class); SL = lk.findStaticVarHandle(Vh.class, "sl", long.class); SS = lk.findStaticVarHandle(Vh.class, "ss", String.class);
      SF = lk.findStaticVarHandle(Vh.class, "sf", float.class); SD = lk.findStaticVarHandle(Vh.class, "sd", double.class); SZ = lk.findStaticVarHandle(Vh.class, "sz", boolean.class);
      SSH = lk.findStaticVarHandle(Vh.class, "ssh", short.class);
      AI = MethodHandles.arrayElementVarHandle(int[].class); AJ = MethodHandles.arrayElementVarHandle(long[].class); AS = MethodHandles.arrayElementVarHandle(String[].class); AB = MethodHandles.arrayElementVarHandle(byte[].class);
    } catch (ReflectiveOperationException e) { throw new Error(e); }
  }

  public static int inst(int a) {
    Vh v = new Vh();
    I.set(v, a); int r = (int) I.get(v); r += (int) I.getAndAdd(v, 5);
    r ^= I.compareAndSet(v, a + 5, 3) ? 99 : 0; r += (int) I.compareAndExchange(v, 3, 8); r += (int) I.compareAndExchange(v, 3, 9);
    r += (int) I.getAndSet(v, 11); r += (int) I.getAndBitwiseOr(v, 0xf0); r += (int) I.getAndBitwiseAnd(v, 0x3c); r += (int) I.getAndBitwiseXor(v, 0xff);
    r += (int) I.getAcquire(v) + (int) I.getOpaque(v) + (int) I.getVolatile(v); I.setRelease(v, 5); I.setOpaque(v, (int) I.get(v) + 1); I.setVolatile(v, (int) I.get(v) * 3);
    r += I.weakCompareAndSetPlain(v, 18, 4) ? 1 : 0; r += I.weakCompareAndSet(v, 4, 6) ? 2 : 0; r += I.weakCompareAndSetAcquire(v, 6, 7) ? 4 : 0; r += I.weakCompareAndSetRelease(v, 7, 8) ? 8 : 0;
    r += (int) I.getAndAddAcquire(v, 1) + (int) I.getAndAddRelease(v, 1) + (int) I.getAndSetAcquire(v, 40) + (int) I.getAndSetRelease(v, 41) + (int) VI.getAndAdd(v, 2) + (int) VI.getVolatile(v);
    return r + (int) I.get(v);
  }
  public static long wide(int a) {
    Vh v = new Vh(); L.set(v, (long) a << 33); long r = (long) L.get(v); r += (long) L.getAndAdd(v, 7L); r ^= L.compareAndSet(v, ((long) a << 33) + 7L, -1L) ? 5L : 0L;
    r += (long) L.getAndSet(v, 9L) + (long) L.compareAndExchange(v, 9L, 0x100000000L) + (long) L.getAndBitwiseXor(v, 0xffL) + (long) L.getAndBitwiseOr(v, 1L << 40);
    D.set(v, a * 1.5); double x = (double) D.get(v); x += (double) D.getAndSet(v, -0.0); r += Double.doubleToRawLongBits(x) + Double.doubleToRawLongBits((double) D.get(v));
    r += D.compareAndSet(v, -0.0, Double.NaN) ? 1 : 0; r += D.compareAndSet(v, 0.0, 1.0) ? 2 : 0; r += D.compareAndSet(v, Double.NaN, 2.0) ? 4 : 0;
    return r + (long) L.get(v);
  }
  public static int small(int a) {
    Vh v = new Vh(); Z.set(v, a % 2 == 0); int r = (boolean) Z.get(v) ? 1 : 0; r += Z.compareAndSet(v, a % 2 == 0, a % 2 != 0) ? 2 : 0; r += (boolean) Z.getAndSet(v, true) ? 4 : 0;
    SH.set(v, (short) (a * 3000)); r += (short) SH.get(v); r += (short) SH.getAndAdd(v, (short) 40000); r += (short) SH.get(v);
    BY.set(v, (byte) a); r += (byte) BY.getAndAdd(v, (byte) 100); r += (byte) BY.get(v); CH.set(v, 'a'); r += (char) CH.getAndAdd(v, (char) 3) + (char) CH.get(v);
    F.set(v, a * 0.5f); r += Float.floatToRawIntBits((float) F.getAndSet(v, Float.NaN)); r += F.compareAndSet(v, Float.NaN, 1f) ? 1000 : 0; r += (float) F.get(v) == 1f ? 5000 : 0;
    return r;
  }
  public static int refs(int a) {
    Vh v = new Vh(); String x = (a & 1) == 0 ? "x0" : "x1", y = "y";
    S.set(v, x); int r = ((String) S.get(v)).length(); r += S.compareAndSet(v, x, y) ? 1 : 0; r += S.compareAndSet(v, x, "z") ? 2 : 0; r += (String) S.compareAndExchange(v, y, null) == y ? 4 : 0;
    r += S.get(v) == null ? 8 : 0; r += (String) S.getAndSet(v, "q") == null ? 16 : 0; r += (String) S.getAcquire(v) == "q" ? 32 : 0; S.setRelease(v, null);
    Object o = "s"; r += o instanceof CharSequence ? 64 : 0;
    return r + a;
  }
  public static int statics(int a) {
    si = a; int r = (int) SI.get(); SI.set(a + 1); r += (int) SI.getAndAdd(10); r += SI.compareAndSet(a + 11, 5) ? 100 : 0; r += (int) SI.compareAndExchange(5, 6) + (int) SI.getAndSet(7) + (int) SI.getAndBitwiseAnd(3);
    SL.set((long) a << 35); r += (int) ((long) SL.getAndAdd(1L) >> 35) + (int) (long) SL.get() + (SL.compareAndSet(((long) a << 35) + 1, 2L) ? 1000 : 0);
    ss = "p"; r += ((String) SS.get()).length(); r += SS.compareAndSet("p", "qq") ? 10000 : 0; r += ((String) SS.getAndSet("rrr")).length() + ss.length();
    SF.set(1.5f); r += (int) (float) SF.getAndSet(2.5f) + (int) sf; SD.set(3.5); r += (int) (double) SD.getAndSet(4.5) + (int) sd; SZ.set(true); r += (boolean) SZ.getAndSet(false) ? 100000 : 0; SSH.set((short) -5); r += (short) SSH.getAndAdd((short) 2) + ssh;
    return r + si;
  }
  public static int arrays(int a) {
    int[] ia = new int[4]; long[] ja = new long[3]; String[] sa = new String[3]; byte[] ba = new byte[4];
    AI.set(ia, 2, a); int r = (int) AI.get(ia, 2) + (int) AI.getAndAdd(ia, 2, 5) + (AI.compareAndSet(ia, 2, a + 5, 1) ? 10 : 0) + (int) AI.getAndSet(ia, 3, 9) + ia[2] + ia[3];
    AJ.set(ja, 1, 1L << 40); r += (int) ((long) AJ.getAndAdd(ja, 1, 3L) >> 40) + (int) (long) AJ.get(ja, 1) + (AJ.compareAndSet(ja, 1, (1L << 40) + 3, 7L) ? 100 : 0);
    AS.set(sa, 0, "e"); r += ((String) AS.get(sa, 0)).length() + (AS.compareAndSet(sa, 0, "e", "ff") ? 1000 : 0) + ((String) AS.getAndSet(sa, 1, "ggg") == null ? 10000 : 0) + sa[0].length();
    AB.set(ba, 3, (byte) a); r += (byte) AB.getAndAdd(ba, 3, (byte) 100) + ba[3];
    try { AI.get(ia, 4); } catch (ArrayIndexOutOfBoundsException e) { r += 100000; }
    try { AS.set(new Object[1], 0, "x"); } catch (ClassCastException e) { r += 200000; }
    return r;
  }
  public static int errors(int a) {
    int r = 0;
    try { I.get((Vh) null); } catch (NullPointerException e) { r += 1; }
    try { I.set((Object) "s", 1); } catch (ClassCastException e) { r += 2; }
    try { AI.get((int[]) null, 0); } catch (NullPointerException e) { r += 4; }
    try { AI.get(new int[2], -1); } catch (ArrayIndexOutOfBoundsException e) { r += 8; }
    return r + a;
  }
  public static int fieldAfterInit(int a) { Vh v = new Vh(); VI.set(v, a); return (int) VI.getAndAdd(v, 1) + v.vi; }
}
