// JvmTierProbe.dex is this class built by `pnpm ts scripts/probes.ts JvmTierProbe`, committed so that the
// tests need neither Java nor the Android SDK.

public final class JvmTierProbe {
    public static final class Host {
        public static native int call(int mode, int value);
    }
    public interface Callable {
        int apply(int value);
        default int plus(int value) { return offset(apply(value)); }
        private int offset(int value) { return value + 3; }
    }
    public static final class Worker implements Callable {
        private int twice(int value) { return Host.call(0, value) * 2; }
        public int apply(int value) { return twice(value) + 1; }
    }
    public static final class Late {
        static int value = Host.call(2, 41);
        static int get(int input) { return Host.call(1, input) + value; }
    }
    public static float constants(int mode) {
        Host.call(0, mode);
        float value;
        switch (mode) {
            case 0: value = 1.25f; break;
            case 1: value = -2.5f; break;
            default: value = 3.75f;
        }
        float[] values = {value, 0.5f};
        return values[0] + values[1];
    }
    public static float negativeZero(int mode) { Host.call(0, mode); return -0.0f; }
    public static long wide(long value) { Host.call(0, 0); return (value << 9) ^ -1234567890123L; }
    public static boolean nullValue(Object value) { Host.call(0, 0); return value == null; }
    public static int suspended(int mode, int value) {
        Host.call(0, -1);
        try {
            int result = Host.call(mode, value);
            Host.call(0, 2);
            return result + 1;
        } catch (RuntimeException error) {
            Host.call(0, 3);
            return -1;
        } finally {
            Host.call(0, 4);
        }
    }
    public static int late(int value) { return Late.get(value); }
    public static int loop(int count) {
        Host.call(0, 0);
        int value = 0;
        for (int i = 0; i < count; i++) value += i;
        return value;
    }
    public static int dispatch(Callable target, int value) { return target.apply(value); }
    public static int composed(Callable target, int value) { return target.plus(value); }
}
