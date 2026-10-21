// InvokeProbe.dex is this class built by `pnpm ts scripts/probes.ts InvokeProbe`.
import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.lang.invoke.VarHandle;

public final class InvokeProbe {
    public record Point(int x, String label, long id) {}

    volatile int count;
    volatile Object ref;
    static volatile long total;

    static final VarHandle COUNT, REF, TOTAL, SLOTS;
    static {
        try {
            MethodHandles.Lookup l = MethodHandles.lookup();
            COUNT = l.findVarHandle(InvokeProbe.class, "count", int.class);
            REF = l.findVarHandle(InvokeProbe.class, "ref", Object.class);
            TOTAL = l.findStaticVarHandle(InvokeProbe.class, "total", long.class);
            SLOTS = MethodHandles.arrayElementVarHandle(Object[].class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    int add(int a, int b) { return a + b + count; }
    static String join(String a, int b) { return a + b; }

    public static String varHandles() {
        InvokeProbe p = new InvokeProbe();
        StringBuilder out = new StringBuilder();
        out.append(COUNT.compareAndSet(p, 0, 5)).append(',');
        out.append(COUNT.compareAndSet(p, 0, 6)).append(',');
        out.append((int) COUNT.getAndAdd(p, 3)).append(',');
        out.append((int) COUNT.get(p)).append(',');
        Object a = new Object(), b = new Object();
        out.append(REF.compareAndSet(p, null, a)).append(',');
        out.append(REF.getAndSet(p, b) == a).append(',');
        out.append((Object) REF.compareAndExchange(p, a, null) == b).append(',');
        TOTAL.set(40L);
        out.append((long) TOTAL.getAndAdd(2L)).append(',');
        out.append((long) TOTAL.getVolatile()).append(',');
        Object[] slots = new Object[2];
        SLOTS.setRelease(slots, 1, "x");
        out.append(SLOTS.compareAndSet(slots, 1, "x", "y")).append(',');
        out.append((Object) SLOTS.getAcquire(slots, 1));
        VarHandle.fullFence();
        try { SLOTS.get(slots, 2); } catch (ArrayIndexOutOfBoundsException e) { out.append(",oob"); }
        return out.toString();
    }

    public static String methodHandles() throws Throwable {
        MethodHandles.Lookup l = MethodHandles.lookup();
        MethodHandle add = l.findVirtual(InvokeProbe.class, "add", MethodType.methodType(int.class, int.class, int.class));
        MethodHandle join = l.findStatic(InvokeProbe.class, "join", MethodType.methodType(String.class, String.class, int.class));
        InvokeProbe p = new InvokeProbe();
        p.count = 100;
        int sum = (int) add.invokeExact(p, 1, 2);
        Object boxed = add.invoke(p, (Object) 3, 4);
        String joined = (String) join.invokeExact("n", 7);
        return sum + "," + boxed + "," + joined;
    }

    public static String records() {
        Point a = new Point(1, "a", 9L), b = new Point(1, "a", 9L), c = new Point(2, null, 9L);
        return a + "," + a.equals(b) + "," + a.equals(c) + "," + (a.hashCode() == b.hashCode()) + "," + c;
    }
}
