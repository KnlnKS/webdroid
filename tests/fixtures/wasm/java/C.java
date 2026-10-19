/** Class model tests: every method is a static int(int) that exercises one feature once. Run by classdiff.ts. */
public class C {
  public static int definitionlessAnnotations(int n) {
    for (Class<?> type : new Class<?>[] {int.class, void.class, int[].class, Object[][].class}) {
      if (type.getDeclaredAnnotation(Deprecated.class) != null || type.getDeclaredAnnotations().length != 0 || type.getAnnotations().length != 0 || type.getTypeParameters().length != 0) return 1;
    }
    return 0;
  }
  interface I { default int f() { return 1; } int g(); }
  interface J extends I { default int f() { return 2 + I.super.f(); } }
  static class A implements I { public int g() { return 5; } }
  static class B extends A implements J { }
  static class D implements I { public int f() { return 10 + I.super.f(); } public int g() { return 6; } }
  static class K implements Cloneable { int a = 3; long b = 4; Object c; K dup() throws CloneNotSupportedException { return (K) super.clone(); } }
  static abstract class Abs { }

  static class Values extends ClassValue<Object> {
    int computed;
    protected Object computeValue(Class<?> type) { computed++; return new Object(); }
  }
  public static int classValues(int n) {
    Values a=new Values(), b=new Values(); Object first=a.get(A.class);
    int r=a.get(A.class)==first && a.computed==1 ? 1 : 0;
    r+=a.get(B.class)!=first && a.computed==2 ? 2 : 0;
    r+=b.get(A.class)!=first && b.computed==1 ? 4 : 0;
    a.remove(A.class); Object second=a.get(A.class);
    r+=second!=first && a.get(A.class)==second && a.computed==3 ? 8 : 0;
    Object prim=a.get(int.class), array=a.get(int[].class);
    r+=prim!=array && a.get(int.class)==prim && a.get(int[].class)==array && a.computed==5 ? 16 : 0;
    return r;
  }

  public static int classIdent(int n) {
    Object a = new A(), b = new B();
    int r = (a.getClass() == A.class ? 1 : 0) + (b.getClass() == B.class ? 2 : 0) + (a.getClass() != b.getClass() ? 4 : 0);
    r += new int[1].getClass() == int[].class ? 8 : 0;
    r += new A[0].getClass() == A[].class ? 16 : 0;
    r += new A[0].getClass() != B[].class ? 32 : 0;
    r += new A[0][].getClass() == A[][].class ? 64 : 0;
    return r;
  }
  public static int classApi(int n) {
    int r = 0;
    r += A.class.isInstance(new B()) ? 1 : 0;
    r += B.class.isAssignableFrom(A.class) ? 2 : 0;
    r += I.class.isAssignableFrom(B.class) ? 4 : 0;
    r += A[].class.getComponentType() == A.class ? 32 : 0;
    r += A.class.getComponentType() == null ? 64 : 0;
    r += I.class.isInterface() ? 128 : 0;
    r += B.class.getSuperclass() == A.class ? 256 : 0;
    r += A[].class.isArray() ? 512 : 0;
    r += I.class.isInstance(new int[0]) ? 0 : 1024;
    r += Object.class.isAssignableFrom(I.class) ? 2048 : 0;
    r += Abs.class.getModifiers() & 0x400;
    r += Object.class.getSuperclass() == null ? 16384 : 0;
    return r;
  }
  public static int arrayClassApi(int n) {
    int r = 0;
    r += A[].class.isAssignableFrom(B[].class) ? 8 : 0;
    r += Object[].class.isAssignableFrom(A[].class) ? 16 : 0;
    r += Cloneable.class.isAssignableFrom(int[].class) ? 4096 : 0;
    r += I.class.getSuperclass() == null ? 8192 : 0;
    return r;
  }
  public static int newInstance(int n) throws Exception {
    Object o = A.class.newInstance();
    return (o instanceof A ? 1 : 0) + (o.getClass() == A.class ? 2 : 0) + (((I) o).g() == 5 ? 4 : 0);
  }
  public static int stringConstructors(int n) throws Exception {
    String empty = String.class.newInstance(), s = String.class.getConstructor(char[].class, int.class, int.class).newInstance(new char[] {'a', 'b', 'c'}, 1, 2);
    return empty.length() * 1000 + s.hashCode();
  }
  public static int defaults(int n) {
    I a = new A(), d = new D();
    return a.f() * 100 + d.f() + (a.g() + d.g()) * 1000;
  }
  public static int defaultSpecific(int n) { I b = new B(); return b.f() + new B().f() * 10; }
  public static int arrayClone(int n) {
    int[] a = {1, 2, 3}; int[] b = a.clone(); b[0] = 9;
    long[] l = {5L, 6L}; long[] m = l.clone();
    A[] x = new B[2]; x[0] = new B(); A[] y = x.clone(); y[1] = new B();
    char[][] cc = new char[2][]; cc[0] = new char[3]; cc[1] = new char[1]; char[][] c2 = cc.clone();
    byte[] bb = {7}; boolean[] zz = {true}; short[] ss = {8};
    long r = a[0] + b[0] * 10 + m[1] + (y.getClass() == B[].class ? 100 : 0) + (x[1] == null ? 200 : 0) + (c2[1] == cc[1] ? 400 : 0) + bb.clone()[0] + (zz.clone()[0] ? 1 : 0) + ss.clone()[0];
    return (int) r;
  }
  public static int objectClone(int n) throws Exception {
    K k = new K(); k.c = k; k.a = 7;
    K c = k.dup();
    return (c != k ? 1 : 0) + (c.a == 7 ? 2 : 0) + (c.b == 4 ? 4 : 0) + (c.c == k ? 8 : 0) + (c.getClass() == K.class ? 16 : 0);
  }
  public static int arrayStoreOk(int n) {
    int r = 0;
    Object[] a = new A[2];
    a[0] = new B(); a[1] = new A(); r += 1;
    I[] ia = new A[1]; ia[0] = new A(); r += 2;
    Object[] oa = new Object[2]; oa[0] = new int[2]; oa[1] = new A[1]; r += 4;
    Object[][] aa = new A[1][]; aa[0] = new B[1]; r += 8;
    a[1] = null; r += 16;
    return r;
  }
  public static int arrayStore(int n) {
    int r = 0;
    Object[] a = new A[2];
    try { a[0] = new Object(); } catch (ArrayStoreException e) { r += 1; }
    Object[] ba = new B[1];
    try { ba[0] = new A(); } catch (ArrayStoreException e) { r += 16; }
    Object[][] aa = new A[1][];
    try { aa[0] = new Object[1]; } catch (ArrayStoreException e) { r += 64; }
    I[] ia = new A[1];
    try { ((Object[]) ia)[0] = new D(); r += 2; } catch (ArrayStoreException e) { r += 4; }
    return r;
  }
  public static int arrayStoreIface(int n) {
    int r = 0;
    Object[] ia = new I[2], ba = new B[1], ca = new Comparable[1], sa = new CharSequence[1];
    ia[0] = new A(); ia[1] = new B(); r += 1;
    try { ia[0] = new Object(); } catch (ArrayStoreException e) { r += 2; }
    try { ia[0] = new int[1]; } catch (ArrayStoreException e) { r += 4; }
    try { ba[0] = new D(); } catch (ArrayStoreException e) { r += 8; }
    ca[0] = "s"; ca[0] = 7; r += 16;
    try { ca[0] = new Object(); } catch (ArrayStoreException e) { r += 32; }
    sa[0] = "t"; r += 64;
    try { sa[0] = 7; } catch (ArrayStoreException e) { r += 128; }
    return r;
  }
  public static int arrayCasts(int n) {
    Object o = new B[1];
    int r = (o instanceof A[] ? 1 : 0) + (o instanceof I[] ? 2 : 0) + (o instanceof Object[] ? 4 : 0) + (o instanceof int[] ? 0 : 8) + (o instanceof B[] ? 16 : 0) + (o instanceof D[] ? 0 : 32)
      + (o instanceof Cloneable ? 64 : 0) + (o instanceof java.io.Serializable ? 128 : 0) + (o instanceof Object ? 256 : 0) + (new A[0][] instanceof Object[][] ? 512 : 0) + (new int[0][] instanceof Object[] ? 1024 : 0);
    A[] ok = (A[]) o; r += ok.length;
    try { Object[] bad = (D[]) o; r += 4096; } catch (ClassCastException e) { r += 2048; }
    try { int[] bad = (int[]) (Object) new long[1]; r += 8192; } catch (ClassCastException e) { r += 16384; }
    return r;
  }

  static class P { static int x = Q.y + 1; }
  static class Q { static int y = P.x + 10; }
  public static int initCycle(int n) { return P.x * 100 + Q.y; }
  static class Q2 { static int y = P2.x + 10; }
  static class P2 { static int x = Q2.y + 1; }
  public static int initCycleReverse(int n) { return Q2.y * 100 + P2.x; }

  static int z() { return 0; }
  static class F { static int v = 1 / z(); static int g() { return 1; } }
  public static int initFails(int n) {
    int r = 0; Throwable t1 = null, t2 = null;
    try { F.g(); } catch (Throwable t) { t1 = t; }
    try { F.g(); } catch (Throwable t) { t2 = t; }
    r += t1 instanceof ExceptionInInitializerError ? 1 : 0;
    r += t1 != null && t1.getCause() instanceof ArithmeticException ? 2 : 0;
    r += t2 instanceof NoClassDefFoundError ? 4 : 0;
    return r;
  }
  static class E { static int v = 1; static { if (v == 1) throw new Error2(); } }
  static class Error2 extends Error { }
  public static int initError(int n) {
    try { return E.v; } catch (Throwable t) { return t instanceof Error2 ? 1 : 2; }
  }
  static class Base { static int b = 5; static int log = 0; static { log = log * 10 + 1; } }
  static class Sub extends Base { static int s = 6; static { log = log * 10 + 2; } }
  public static int initOrder(int n) { int s = Sub.s; return s * 1000 + Base.log * 10 + Base.b; }
  interface WithDefault { int V = Order.next(1); default int d() { return 1; } }
  static class Order { static int last; static int next(int v) { last = last * 10 + v; return v; } }
  static class Impl implements WithDefault { }
  public static int initDefaultIface(int n) { new Impl(); return Order.last; }

  // ---- VarHandle: handles made by Lookup.findVarHandle and MethodHandles.arrayElementVarHandle
  static class S { int i = 5; long l = 1L << 40; Object o; int j = 7; }
  static final java.lang.invoke.VarHandle VI = fh(0), VL = fh(1), VO = fh(2), VJ = fh(3), VA = av(0), VLA = av(1), VOA = av(2);
  static java.lang.invoke.VarHandle fh(int ordinal) {
    try { String[] names = {"i", "l", "o", "j"}; Class<?>[] types = {int.class, long.class, Object.class, int.class};
      return java.lang.invoke.MethodHandles.lookup().findVarHandle(S.class, names[ordinal], types[ordinal]);
    } catch (ReflectiveOperationException e) { throw new Error(e); }
  }
  static java.lang.invoke.VarHandle av(int ordinal) {
    return java.lang.invoke.MethodHandles.arrayElementVarHandle(ordinal == 0 ? int[].class : ordinal == 1 ? long[].class : Object[].class);
  }
  public static int varHandleInt(int n) {
    S s = new S(); int r = 0;
    r += (int) VI.get(s);                                  // 5
    VI.set(s, 11);
    r += (int) VI.getAndAdd(s, 4) * 10;                    // 110, i = 15
    r += VI.compareAndSet(s, 15, 20) ? 1000 : 0;           // i = 20
    r += VI.compareAndSet(s, 15, 30) ? 2000 : 0;
    r += (int) VI.compareAndExchange(s, 20, 21) == 20 ? 4000 : 0;
    r += (int) VI.getAndSet(s, 99) * 10000;                // 21
    r += (int) VI.getAndBitwiseOr(s, 4);                   // 99
    r += (int) VI.getVolatile(s) + (int) VJ.getAcquire(s);  // 99 | 4 = 103, j = 7
    VJ.setRelease(s, 2); VJ.setOpaque(s, (int) VJ.getOpaque(s) + 1);
    r += s.j * 100000 + (VJ.weakCompareAndSetPlain(s, 3, 9) ? 1000000 : 0) + s.j * 10000000;
    return r + s.i;
  }
  public static long varHandleLong(int n) {
    S s = new S(); long r = (long) VL.get(s);
    r += (long) VL.getAndAdd(s, 5L) + (long) VL.getAndBitwiseXor(s, 3L) + (long) VL.getAndSet(s, -1L);
    return r + (VL.compareAndSet(s, -1L, 1L << 33) ? 1 : 0) + s.l;
  }
  public static int varHandleRef(int n) {
    S s = new S(), t = new S(); int r = 0;
    r += VO.get(s) == null ? 1 : 0;
    r += VO.compareAndSet(s, null, t) ? 2 : 0;
    r += VO.compareAndSet(s, null, s) ? 4 : 0;
    r += (S) VO.getAndSet(s, null) == t ? 8 : 0;
    VO.set(s, s); r += s.o == s ? 16 : 0;
    r += VO.compareAndExchange(s, s, t) == s ? 32 : 0;
    r += s.o == t ? 64 : 0;
    return r;
  }
  public static int varHandleArray(int n) {
    int[] ia = new int[4]; long[] la = new long[3]; Object[] oa = new Object[2]; int r = 0;
    VA.set(ia, 1, 7); r += (int) VA.getAndAdd(ia, 1, 5) + ia[1] * 10;      // 7 + 120
    r += VA.compareAndSet(ia, 2, 0, 9) ? 1000 : 0;
    r += (int) VA.get(ia, 2) * 10000;
    VLA.set(la, 2, 1L << 35); r += (long) VLA.getAndAdd(la, 2, 1L) == 1L << 35 ? 100000 : 0; r += la[2] == (1L << 35) + 1 ? 200000 : 0;
    Object x = new Object(); VOA.set(oa, 0, x); r += VOA.compareAndSet(oa, 0, x, oa) ? 400000 : 0; r += oa[0] == oa ? 800000 : 0;
    try { VA.get(ia, 4); } catch (ArrayIndexOutOfBoundsException e) { r += 1600000; }
    try { VI.get(null); } catch (NullPointerException e) { r += 3200000; }
    return r;
  }

  static class T2 { public int a; int b; public static long c; private Object d; protected A e; }
  public static int fieldsApi(int n) {
    java.lang.reflect.Field[] fs = T2.class.getDeclaredFields();
    int r = fs.length;
    for (java.lang.reflect.Field f : fs) {
      int m = f.getModifiers();
      r += (f.getType().isPrimitive() ? 10 : 0) + (f.getType() == Object.class ? 100 : 0) + (f.getType() == A.class ? 1000 : 0) + (f.getDeclaringClass() == T2.class ? 10000 : 0)
        + ((m & 1) != 0 ? 100000 : 0) + ((m & 8) != 0 ? 1000000 : 0) + ((m & 2) != 0 ? 10000000 : 0);
    }
    return r + S.class.getDeclaredFields().length * 100000000;
  }
  public static int publicFields(int n) { return T2.class.getFields().length; }
  public static int arraycopyStore(int n) {
    Object[] src = {new A(), new Object(), new A()}; A[] dst = new A[3]; int r = 0;
    try { System.arraycopy(src, 0, dst, 0, 3); } catch (ArrayStoreException e) { r += 1; }
    r += dst[0] != null ? 2 : 0;
    r += dst[1] == null && dst[2] == null ? 4 : 0;
    Object[] ok = new B[2]; A[] from = {new B(), new B(), new A()};
    System.arraycopy(from, 0, ok, 0, 2); r += ok[1] != null ? 8 : 0;
    try { System.arraycopy(from, 1, ok, 0, 2); } catch (ArrayStoreException e) { r += 16; }
    Object[] wide = new Object[3]; System.arraycopy(from, 0, wide, 1, 2); r += wide[2] == from[1] ? 32 : 0;
    System.arraycopy(from, 0, from, 1, 2); r += from[2] == from[1] ? 64 : 0;
    return r;
  }
  public static int newInstance2(int n) {
    Object[] c = (Object[]) java.lang.reflect.Array.newInstance(A.class, 3);
    return (c.getClass() == A[].class ? 1000 : 0) + c.length * 10000;
  }
  public static int classLoader(int n) { return (A.class.getClassLoader() != null ? 1 : 0) + (A[].class.getClassLoader() != null ? 4 : 0); }

  public static int multiArray(int n) {
    A[][] a = (A[][]) java.lang.reflect.Array.newInstance(A.class, new int[] {2, 3});
    int[][][] z = (int[][][]) java.lang.reflect.Array.newInstance(int[].class, new int[] {2, 2});
    int[][] p = (int[][]) java.lang.reflect.Array.newInstance(int.class, new int[] {2, 3});
    return p[1].length * 1000000 + a.length + a[1].length * 10 + (a.getClass() == A[][].class ? 100 : 0) + (a[0].getClass() == A[].class ? 1000 : 0) + z[1].length * 10000 + (z.getClass() == int[][][].class ? 100000 : 0);
  }
  public static int reflectMethods(int n) throws Exception {
    java.lang.reflect.Method m = A.class.getMethod("g");
    java.lang.reflect.Method f = I.class.getMethod("f");
    java.lang.reflect.Constructor<?> k = A.class.getDeclaredConstructor();
    Object o = k.newInstance();
    int r = (Integer) m.invoke(o) + (Integer) f.invoke(new B()) * 10 + (m.getReturnType() == int.class ? 100 : 0) + m.getParameterTypes().length * 1000;
    try { A.class.getMethod("nope"); } catch (NoSuchMethodException e) { r += 10000; }
    return r + (o instanceof A ? 100000 : 0) + (m.getDeclaringClass() == A.class ? 1000000 : 0) + I.class.getMethod("g").getName().length() * 10000000;
  }
  enum Color { RED, GREEN, BLUE }
  public static int enums(int n) { return Color.values().length + Color.valueOf("GREEN").ordinal() * 10 + java.util.EnumSet.allOf(Color.class).size() * 100 + java.util.EnumSet.of(Color.RED, Color.BLUE).size() * 1000; }

  public static int names(int n) {
    return (C.class.getName().equals("C") ? 1 : 0) + (A.class.getName().equals("C$A") ? 10 : 0) + (int[].class.getName().equals("[I") ? 100 : 0) + (A[].class.getName().equals("[LC$A;") ? 1000 : 0)
      + (int.class.getName().equals("int") ? 10000 : 0) + (Object.class.getName().equals("java.lang.Object") ? 100000 : 0) + (void.class.getName().equals("void") ? 1000000 : 0);
  }
  public static int fieldByName(int n) throws Exception {
    java.lang.reflect.Field f = S.class.getDeclaredField("j"), g = S.class.getDeclaredField("o");
    int r = (f.getName().equals("j") ? 1 : 0) + (g.getType() == Object.class ? 10 : 0) + (f.getType().isPrimitive() ? 100 : 0) + (f.getDeclaringClass() == S.class ? 1000 : 0);
    try { S.class.getDeclaredField("nope"); } catch (NoSuchFieldException e) { r += 10000; }
    return r;
  }
  static class F2 { static int v = 1 / z(); static void touch() { } }
  public static int initMessages(int n) {
    Throwable t1 = null, t2 = null;
    try { F2.touch(); } catch (Throwable t) { t1 = t; }
    try { F2.touch(); } catch (Throwable t) { t2 = t; }
    return (t1 instanceof ExceptionInInitializerError && t1.getCause() instanceof ArithmeticException && t1.getCause().getMessage() != null ? 1 : 0)
      + (t2 instanceof NoClassDefFoundError && t2.getMessage().contains("C$F2") ? 10 : 0);
  }
}
