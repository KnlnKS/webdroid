// What the entry suite calls from the host: statics of every value kind, a class with constructors, fields and an override, exceptions, and arrays.
public class E {
    public static int built = 41;
    static { built++; }
    public static final int K = 7;
    public static long BIG = 1L << 40;
    public static double D = 2.5;
    public static float F = 1.5f;
    public static String NAME = "entry";
    public static E INSTANCE = new E(11);

    public static class WebApi {
        @android.webkit.JavascriptInterface public int ping(int n) throws InterruptedException { Thread.sleep(1); return n + 1; }
        public int hidden() { return 99; }
    }

    public static class Owner {
        public final Thread thread = Thread.currentThread();
        public final boolean held;
        public Owner() { this(null); }
        public Owner(Object lock) { held = lock != null && Thread.holdsLock(lock); }
        public Thread owner() { return thread; }
        public boolean held() { return held; }
    }

    public static class Err extends RuntimeException {
        public Err(String m, Throwable cause) { super(m, cause); }
    }
    public static class Sub extends E {
        public Sub(int v) { super(v); }
        @Override public int get() { return -v; }
    }

    int v;
    public E peer;
    public int[] slots = {1, 2, 3};
    public E(int v) { this.v = v; }
    public E() { this(5); }
    public int get() { return v; }
    public int plus(int n) { return v + n; }
    public void set(int x) { v = x; }
    public E self() { return this; }
    public E sub(int x) { return new Sub(x); }
    public String describe() { return "E" + v; }
    @Override public String toString() { return describe(); }

    public static int add(int a, int b) { return a + b; }
    public static long mul(long a, long b) { return a * b; }
    public static float half(float x) { return x / 2; }
    public static double scale(double x, int n) { return x * n; }
    public static boolean not(boolean b) { return !b; }
    public static char next(char c) { return (char) (c + 1); }
    public static byte lowByte(int x) { return (byte) x; }
    public static String join(String a, String b) { return a + "-" + b; }
    public static String nul(String a) { return a == null ? "null" : a; }
    public static int sum(int[] a) { int s = 0; for (int x : a) s += x; return s; }
    public static void fill(byte[] a, int v) { for (int i = 0; i < a.length; i++) a[i] = (byte) (v + i); }
    public static byte[] bytes(int n) { byte[] a = new byte[n]; fill(a, 1); return a; }
    public static String[] names(int n) { String[] a = new String[n]; for (int i = 0; i < n; i++) a[i] = "n" + i; return a; }
    public static int counted() { return ++built; }
    public static E make(int v) { return new E(v); }
    public static int boom(int x) {
        if (x < 0) throw new IllegalStateException("boom " + x);
        return x;
    }
    public static int wrapped(int x) {
        try { return boom(x); } catch (IllegalStateException e) { throw new Err("wrapped " + x, e); }
    }
    public static int npe(Object o) { return o.hashCode(); }
}
