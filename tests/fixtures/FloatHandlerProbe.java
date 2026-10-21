// FloatHandlerProbe.dex is this class built by `pnpm ts scripts/probes.ts FloatHandlerProbe`, committed so
// that the tests need neither Java nor the Android SDK.

public final class FloatHandlerProbe {
    static final class P {
        int x;
        long y;
        int mix(int a) { x += a; y += a * 3L; return x ^ a; }
    }

    /** d8 gives the shift count (an int) and the infinity (a float) that the handler reads one register: only instructions that can throw reach the handler */
    public static long shifted(int a, long b, float c) {
        float f = c;
        long l = b;
        P p = new P();
        try {
            l >>>= a > 3 ? p.mix(a) : 32;
            f = Float.POSITIVE_INFINITY;
            p.mix(a);
        } catch (RuntimeException e) { }
        return l ^ (long) f ^ p.y;
    }
}
