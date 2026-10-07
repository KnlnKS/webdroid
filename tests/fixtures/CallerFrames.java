public class CallerFrames {
  private static Class<?> reflected() { return sun.reflect.Reflection.getCallerClass(); }
  public static Class<?> caller() { return reflected(); }
  private static native void park();
  private static native Class<?> nativeFrame();
  private static Class<?> suspended() { park(); return reflected(); }
  public static Class<?> suspendedCaller() { return suspended(); }
  public static Class<?> nativeCaller() { return nativeFrame(); }
}
