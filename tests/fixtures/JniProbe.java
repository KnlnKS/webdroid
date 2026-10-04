// Rebuild in a temporary directory with javac --release 11 against Android API 35's android.jar, then Android build-tools d8
// --min-api 26 --output <dir> <dir>/*.class. Copy classes.dex to JniProbe.dex; tests need neither Java nor the Android SDK.
import dalvik.annotation.optimization.CriticalNative;
import dalvik.annotation.optimization.FastNative;
import java.nio.ByteBuffer;

/** The Java side of the JNI tests: members of every type for the Get/Set and Call families, and natives that guest code stands in for. */
public class JniProbe {
    public static int sInt = 7;
    public static long sLong = 1L << 40;
    public static float sFloat = 1.5f;
    public static double sDouble = 2.5;
    public static boolean sBool;
    public static byte sByte = -3;
    public static short sShort = 300;
    public static char sChar = 'x';
    public static String sStr = "static";
    public static Object sObj;
    public int i = 5;
    public long l = 6L << 33;
    public float f = 0.25f;
    public double d = 9.5;
    public boolean z;
    public byte b = -1;
    public short s = -2;
    public char c = 'c';
    public String str = "inst";
    public Object obj;
    public int[] ints = { 1, 2, 3 };

    public JniProbe() {}
    public JniProbe(int i, String str) { this.i = i; this.str = str; }

    public static int twice(int x) { return 2 * x; }
    public static long widen(int a, long b) { return a + b; }
    public static double mix(int a, long b, float c, double d) { return a + b + c + d; }
    public static boolean flip(boolean v) { return !v; }
    public static String cat(String a, int n) { return a + n; }
    public static int sum(int[] a) { int r = 0; for (int x : a) r += x; return r; }
    public static void fill(byte[] a, int v) { java.util.Arrays.fill(a, (byte) v); }
    public static void fail(String m) { throw new IllegalStateException(m); }
    public static ByteBuffer direct(int n) { return ByteBuffer.allocateDirect(n); }
    public static int peek(ByteBuffer b, int at) { return b.get(at); }
    public static Object self(Object o) { return o; }
    public int plus(int n) { return i + n; }

    public static class Child extends JniProbe {
        public int plus(int n) { return -n; }
    }
    public static JniProbe child() { return new Child(); }

    // each of these is bound once, so a test that runs on both ABIs has one pair for each
    @CriticalNative public static native double critical32(int a, long b, float c, double d);
    @FastNative public static native double fast32(int a, long b, float c, double d);
    @CriticalNative public static native double critical64(int a, long b, float c, double d);
    @FastNative public static native double fast64(int a, long b, float c, double d);
    public static native int late(int a);
    public native int inst(int a);
    public native int calls(int a);
    public static native Object echo(Object o);
    public static native int measure(String s, byte[] b, Object[] o);
}
