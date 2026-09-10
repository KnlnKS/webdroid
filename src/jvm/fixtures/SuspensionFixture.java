package webdroid;

public class SuspensionFixture {
  public static native int step(int value);

  public static int call(int value) { return step(value); }

  public static int immediate() { return step(7) + step(9); }

  public static int immediateLoop() {
    int total = 0;
    for (int i = 0; i < 100; i++) total += step(7);
    return total;
  }

  public static long wide(long n) {
    step(1);
    long[] values = { n, 0x123456789abcdef0L };
    return values[0] ^ values[1];
  }

  public static float decimal() {
    step(1);
    float[] values = { -0f, 1.25f };
    return values[0] + values[1];
  }

  public static int array(Object value) {
    step(1);
    Object[] values = new Object[2];
    values[1] = value;
    return (values[1] == value ? 7 : 9) + values.length;
  }

  public static int run(int limit) {
    int total = 0;
    for (int i = 0; i < limit; i++) {
      try {
        switch (i % 3) {
          case 0: total += call(i); break;
          case 1: total += call(i) + call(i + 10); break;
          default: total -= call(i);
        }
      } catch (IllegalStateException e) {
        total += call(100);
      }
    }
    return total;
  }
}
