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

  static MethodHandle inv(VarHandle.AccessMode mode, MethodType type, boolean exact) {
    return exact ? MethodHandles.varHandleExactInvoker(mode, type) : MethodHandles.varHandleInvoker(mode, type);
  }
  public static int tInvokerField(int a) throws Throwable {
    Vh v = new Vh(); v.i = a;
    MethodHandle h = inv(VarHandle.AccessMode.GET_AND_ADD, MethodType.methodType(int.class, Vh.class, int.class), true);
    int before = (int) h.invokeExact(I, v, 3);
    return before + v.i;
  }
  public static int tInvokerBound(int a) throws Throwable {
    Vh v = new Vh(); v.i = a;
    MethodHandle h = I.toMethodHandle(VarHandle.AccessMode.GET).bindTo(v);
    return (int) h.invokeExact() + (int) MethodHandles.filterReturnValue(h, MethodHandles.identity(int.class)).invokeExact();
  }
  public static long tInvokerStatic(int a) throws Throwable {
    sl = a;
    MethodHandle h = inv(VarHandle.AccessMode.GET_AND_SET, MethodType.methodType(long.class, long.class), true);
    long before = (long) h.invokeExact(SL, 1L << 40);
    return before + sl;
  }
  public static int tInvokerArray(int a) throws Throwable {
    int[] array = new int[3]; array[1] = a;
    MethodHandle h = inv(VarHandle.AccessMode.COMPARE_AND_EXCHANGE, MethodType.methodType(int.class, int[].class, int.class, int.class, int.class), true);
    int before = (int) h.invokeExact(AI, array, 1, a, a + 4);
    return before + array[1];
  }
  public static int tInvokerAdapt(int a) throws Throwable {
    Vh v = new Vh(); v.i = a;
    MethodHandle get = inv(VarHandle.AccessMode.GET, MethodType.methodType(Object.class, Object.class), false);
    MethodHandle set = inv(VarHandle.AccessMode.SET, MethodType.methodType(void.class, Object.class, Object.class), false);
    set.invokeExact(I, (Object) v, (Object) Integer.valueOf(a + 2));
    return (Integer) (Object) get.invokeExact(I, (Object) v);
  }
  public static long tInvokerWiden(int a) throws Throwable {
    Vh v = new Vh(); v.i = a;
    return (long) inv(VarHandle.AccessMode.GET, MethodType.methodType(long.class, Vh.class), false).invokeExact(I, v);
  }
  public static int tInvokerFloating(int a) throws Throwable {
    Vh v = new Vh(); v.f = a; v.d = a;
    float f = (float) inv(VarHandle.AccessMode.GET_AND_ADD, MethodType.methodType(float.class, Vh.class, float.class), true).invokeExact(F, v, 0.5f);
    double d = (double) inv(VarHandle.AccessMode.GET_AND_ADD, MethodType.methodType(double.class, Vh.class, double.class), true).invokeExact(D, v, 0.25);
    return (int) ((f + d + v.f + v.d) * 4);
  }
  public static int tInvokerErrors(int a) throws Throwable {
    int r = 0;
    MethodHandle get = inv(VarHandle.AccessMode.GET, MethodType.methodType(int.class, Vh.class), true);
    try { int unused = (int) get.invokeExact((VarHandle) null, new Vh()); } catch (NullPointerException e) { r += 1; }
    try { long unused = (long) inv(VarHandle.AccessMode.GET, MethodType.methodType(long.class, Vh.class), true).invokeExact(I, new Vh()); } catch (WrongMethodTypeException e) { r += 2; }
    try { Object unused = (Object) inv(VarHandle.AccessMode.GET, MethodType.methodType(Object.class, Object.class), false).invokeExact(I, (Object) "wrong"); } catch (ClassCastException e) { r += 4; }
    try { int unused = (int) AI.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(new int[2], -1); } catch (ArrayIndexOutOfBoundsException e) { r += 8; }
    try { int unused = (int) inv(VarHandle.AccessMode.GET_AND_ADD, MethodType.methodType(int.class, Vh.class, int.class), false).invokeExact(S, new Vh(), 1); } catch (UnsupportedOperationException e) { r += 16; }
    return r + a;
  }

  public static int tInvokerViewArray(int a) throws Throwable {
    VarHandle vh = MethodHandles.byteArrayViewVarHandle(int[].class, java.nio.ByteOrder.BIG_ENDIAN);
    byte[] data = new byte[12];
    vh.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(data, 1, a);
    int r = (int) vh.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(data, 1);
    vh.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(data, 4, a + 2);
    r += (int) vh.toMethodHandle(VarHandle.AccessMode.GET_AND_ADD).invokeExact(data, 4, 3);
    r += (int) vh.toMethodHandle(VarHandle.AccessMode.GET_VOLATILE).invokeExact(data, 4);
    try { int unused = (int) vh.toMethodHandle(VarHandle.AccessMode.GET_OPAQUE).invokeExact(data, 1); } catch (IllegalStateException e) { r += 100; }
    try { int unused = (int) vh.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(data, 10); } catch (IndexOutOfBoundsException e) { r += 1000; }
    return r;
  }
  public static int tInvokerViewBuffer(int a) throws Throwable {
    VarHandle vh = MethodHandles.byteBufferViewVarHandle(long[].class, java.nio.ByteOrder.LITTLE_ENDIAN);
    java.nio.ByteBuffer buffer = java.nio.ByteBuffer.allocate(24).order(java.nio.ByteOrder.BIG_ENDIAN);
    vh.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(buffer, 8, (long) a);
    long before = (long) vh.toMethodHandle(VarHandle.AccessMode.GET_AND_SET).invokeExact(buffer, 8, 1L << 40);
    long after = (long) vh.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(buffer, 8);
    int r = (int) before + (int) (after >> 40);
    if (buffer.order() == java.nio.ByteOrder.BIG_ENDIAN && buffer.position() == 0) r += 10;
    java.nio.ByteBuffer readOnly = buffer.asReadOnlyBuffer();
    try { boolean unused = (boolean) vh.toMethodHandle(VarHandle.AccessMode.COMPARE_AND_SET).invokeExact(readOnly, 8, 99L, 0L); } catch (java.nio.ReadOnlyBufferException e) { r += 100; }
    try { long unused = (long) vh.toMethodHandle(VarHandle.AccessMode.GET_VOLATILE).invokeExact(buffer, 1); } catch (IllegalStateException e) { r += 1000; }
    return r;
  }

  public static int tInvokerViewKinds(int a) throws Throwable {
    byte[] bytes = new byte[32];
    VarHandle c = MethodHandles.byteArrayViewVarHandle(char[].class, java.nio.ByteOrder.BIG_ENDIAN);
    c.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(bytes, 1, (char) (a + 65530));
    int r = (char) c.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(bytes, 1);
    VarHandle s = MethodHandles.byteArrayViewVarHandle(short[].class, java.nio.ByteOrder.LITTLE_ENDIAN);
    s.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(bytes, 4, (short) -a);
    r += (short) s.toMethodHandle(VarHandle.AccessMode.GET_VOLATILE).invokeExact(bytes, 4);
    VarHandle d = MethodHandles.byteArrayViewVarHandle(double[].class, java.nio.ByteOrder.BIG_ENDIAN);
    d.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(bytes, 8, -0.0);
    r += (boolean) d.toMethodHandle(VarHandle.AccessMode.COMPARE_AND_SET).invokeExact(bytes, 8, 0.0, 2.0) ? -100 : 100;
    r += (boolean) d.toMethodHandle(VarHandle.AccessMode.COMPARE_AND_SET).invokeExact(bytes, 8, -0.0, 3.0) ? 1000 : -1000;
    r += (int) (double) d.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(bytes, 8);
    return r;
  }
  public static int tInvokerViewDirect(int a) throws Throwable {
    VarHandle vh = MethodHandles.byteBufferViewVarHandle(int[].class, java.nio.ByteOrder.BIG_ENDIAN);
    java.nio.ByteBuffer direct = java.nio.ByteBuffer.allocateDirect(24);
    vh.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(direct, 4, a);
    int r = (int) vh.toMethodHandle(VarHandle.AccessMode.GET_AND_BITWISE_XOR).invokeExact(direct, 4, 3);
    r += (int) vh.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(direct, 4);
    direct.position(1); java.nio.ByteBuffer slice = direct.slice();
    vh.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(slice, 0, a + 1);
    r += (int) vh.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(slice, 0);
    try { int unused = (int) vh.toMethodHandle(VarHandle.AccessMode.GET_ACQUIRE).invokeExact(slice, 0); } catch (IllegalStateException e) { r += 100; }
    java.nio.ByteBuffer heap = java.nio.ByteBuffer.allocate(16); heap.position(3); heap = heap.slice();
    vh.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(heap, 0, a + 2);
    r += (int) vh.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(heap, 0);
    try { vh.toMethodHandle(VarHandle.AccessMode.SET_RELEASE).invokeExact(heap, 0, 1); } catch (IllegalStateException e) { r += 1000; }
    return r;
  }

  public static int tDirectAdapt(int a) {
    Object v = new Vh();
    I.set(v, Integer.valueOf(a));
    Object boxed = I.get(v);
    long widened = (long) I.get(v);
    I.getAndAdd(v, Integer.valueOf(3));
    return (Integer) boxed + (int) widened + (int) I.get(v);
  }
  public static int tDirectViews(int a) {
    VarHandle array = MethodHandles.byteArrayViewVarHandle(int[].class, java.nio.ByteOrder.BIG_ENDIAN);
    Object bytes = new byte[12]; array.set(bytes, Integer.valueOf(4), Integer.valueOf(a));
    int before = (int) array.getAndAdd(bytes, 4, 5);
    VarHandle buffer = MethodHandles.byteBufferViewVarHandle(int[].class, java.nio.ByteOrder.LITTLE_ENDIAN);
    Object direct = java.nio.ByteBuffer.allocateDirect(12).position(4).slice();
    buffer.set(direct, 0, before); int exchanged = (int) buffer.compareAndExchange(direct, 0, before, a + 9);
    return before + exchanged + (int) array.get(bytes, 4) + (int) buffer.get(direct, 0);
  }
  public static int tDirectErrors(int a) {
    int r = 0;
    try { I.set(new Vh(), (Object) "bad"); } catch (ClassCastException e) { r |= 1; }
    try { int unused = (int) I.get("bad"); } catch (ClassCastException e) { r |= 2; }
    try { I.set(new Vh(), (Object) null); } catch (NullPointerException e) { r |= 4; }
    try { I.set(new Vh(), 1L); } catch (WrongMethodTypeException e) { r |= 8; }
    VarHandle view = MethodHandles.byteArrayViewVarHandle(float[].class, java.nio.ByteOrder.BIG_ENDIAN);
    try { float unused = (float) view.getAndAdd(new byte[8], 0, 1f); } catch (UnsupportedOperationException e) { r |= 16; }
    return r;
  }

  static java.nio.ByteBuffer artViewAllocate() { return java.nio.ByteBuffer.allocateDirect(8); }
  static int artViewRead(java.nio.ByteBuffer buffer) {
    VarHandle view = MethodHandles.byteBufferViewVarHandle(int[].class, java.nio.ByteOrder.BIG_ENDIAN);
    return (int) view.getVolatile(buffer, 0);
  }
  static int artViewUpdate(java.nio.ByteBuffer buffer, int a) {
    VarHandle view = MethodHandles.byteBufferViewVarHandle(int[].class, java.nio.ByteOrder.BIG_ENDIAN);
    return (int) view.getAndAdd(buffer, 0, a);
  }

  public static int tInvokerConcurrent(int a) throws Throwable {
    VarHandle vh = MethodHandles.byteBufferViewVarHandle(int[].class, java.nio.ByteOrder.BIG_ENDIAN);
    java.nio.ByteBuffer buffer = java.nio.ByteBuffer.allocateDirect(8);
    vh.toMethodHandle(VarHandle.AccessMode.SET).invokeExact(buffer, 0, a);
    MethodHandle add = vh.toMethodHandle(VarHandle.AccessMode.GET_AND_ADD).bindTo(buffer);
    SL.set((long) a);
    MethodHandle staticAdd = SL.toMethodHandle(VarHandle.AccessMode.GET_AND_ADD);
    class Worker extends Thread {
      public void run() {
        try { for (int i = 0; i < 100; i++) { int unused = (int) add.invokeExact(0, 1); long old = (long) staticAdd.invokeExact(1L); Thread.yield(); } }
        catch (Throwable e) { throw new AssertionError(e); }
      }
    }
    Thread first = new Worker(), second = new Worker(); first.start(); second.start(); first.join(); second.join();
    return (int) vh.toMethodHandle(VarHandle.AccessMode.GET).invokeExact(buffer, 0) + (int) (long) SL.get();
  }
}
