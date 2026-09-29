package dalvik.system;

public final class BlockGuard {
    public interface Policy {
        void onWriteToDisk();
        void onReadFromDisk();
        void onNetwork();
        void onUnbufferedIO();
        void onExplicitGc();
        int getPolicyMask();
    }
    public static Policy getThreadPolicy() { throw new UnsupportedOperationException(); }
    public static void setThreadPolicy(Policy policy) { throw new UnsupportedOperationException(); }
}
