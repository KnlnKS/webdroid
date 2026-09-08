package webdroid;

public class MonitorFixture {
  public static native void pause();
  private Object value;

  public Object get(Object candidate) {
    synchronized (this) {
      if (value == null) {
        pause();
        value = candidate;
      }
      return value;
    }
  }

  public void failing() {
    synchronized (this) { pause(); }
  }

  public static void enter(Object lock) {
    synchronized (lock) {}
  }
}
