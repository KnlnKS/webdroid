import java.net.HttpURLConnection;
import java.net.ProtocolException;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.IntSupplier;
import wdtest.Counter;
import wdtest.HostList;
import wdtest.Maker;

/** Java that uses classes the host implements: the cases in scripts/wasm/hostcases.ts call these and the host objects directly. */
public class Hc {
  static final List<Object> KEPT = new ArrayList<>();

  static class Sub extends Counter {
    @Override public int get() { return super.get() + 1000; }
  }
  static class Mine extends HostList {
    @Override public Object get(int i) { return "<" + super.get(i) + ">"; }
  }
  static class Conn extends HttpURLConnection {
    Conn(URL url) { super(url); }
    @Override public void connect() { connected = true; }
    @Override public void disconnect() {}
    @Override public boolean usingProxy() { return false; }
    @Override public java.io.InputStream getInputStream() { return new java.io.ByteArrayInputStream(new byte[0]); }
    @Override public String getHeaderField(int n) { return n == 0 ? "HTTP/1.1 201 Made" : null; }
    String method() { return method; }
    void method(String m) { method = m; }
    String lengths() { return fixedContentLength + "/" + fixedContentLengthLong + "/" + chunkLength; }
  }

  public interface Face { int area(); }
  static class Triangle implements Face { public int area() { return 3; } }
  public static int faces() { Face q = new Triangle(); Face h = (Face) Maker.face(); return q.area() * 100 + h.area(); }

  public abstract static class Shape { public abstract int area(); }
  static class Square extends Shape { @Override public int area() { return 4; } }
  /** an instance of an abstract class that the host implements, made while this method runs: the call is to the host's method, not to the one concrete bytecode subclass */
  public static int shapes() { Shape q = new Square(); Shape h = (Shape) Maker.make(); return q.area() * 100 + h.area(); }

  /** a native handle in a long field: the object that frees it in finalize() owns it, one that does not free it does not */
  static class Own { long h; @Override protected void finalize() {} }
  static class Plain { long h; }
  public static Object own(long h) { Own o = new Own(); o.h = h; return o; }
  public static Object plain(long h) { Plain o = new Plain(); o.h = h; return o; }
  /** host methods that take an array as an Object, one nested in another: each write is the array's before the next call */
  public static int bumpTwice() { Counter k = new Counter(); int[] a = { 0 }; k.bump(a); k.bump(a); return a[0]; }
  /** a bytecode subclass calls a host method that waits */
  public static int blockSub() { Sub s = new Sub(); return s.pause(5) * 100 + s.get(); }
  /** Java that blocks on a monitor until another thread has run */
  public static int locked() throws InterruptedException {
    final Object o = new Object(); final int[] r = {0};
    Thread t = new Thread(() -> { synchronized (o) { r[0] = 7; o.notifyAll(); } });
    synchronized (o) { t.start(); while (r[0] == 0) o.wait(); }
    return r[0];
  }
  /** a host method that calls back into Java that blocks */
  public static int reentered() { return new Counter().reenter() + 1; }
  /** a class whose initializer calls a host method that enters Java for a static method of the same class, as JNI_OnLoad does for the class that loads its library */
  static class Boot { static final int V; static { V = new Counter().reenterInit() + 1; } static int get() { return 41; } }
  public static int booted() { return Boot.V; }
  public static Object newSub() { return new Sub(); }
  public static Object newConn(URL url) { return new Conn(url); }
  public static Object keep(Object o) { KEPT.add(o); return o; }
  public static Object kept(int i) { return KEPT.get(i); }
  public static void forget() { KEPT.clear(); }

  public static String runnable() {
    Counter c = new Counter();
    Runnable r = c;
    r.run();
    r.run();
    return c.get() + ":" + (r == c) + ":" + c.equals(r) + ":" + c.inc() + ":" + ((IntSupplier) c).getAsInt();
  }

  public static String identity() {
    Counter c = new Counter(), d = new Counter();
    Set<Object> set = new HashSet<>();
    set.add(c); set.add(c.self()); set.add(d);
    List<Object> list = new ArrayList<>(Arrays.asList(c, d));
    Counter m = Counter.make(5);
    return (c.self() == c) + ":" + c.same(c) + ":" + c.same(d) + ":" + (c.hashCode() == c.self().hashCode()) + ":" + c.equals(c.self()) + ":" + c.equals(d)
      + ":" + set.size() + ":" + list.indexOf(d) + ":" + list.contains(c) + ":" + m.get() + ":" + (m.self() == m) + ":" + (Counter.make(5) == m);
  }

  public static String tags() {
    Counter c = new Counter();
    String before = c.getTag();
    c.setTag("t" + 1);
    return before + ":" + c.getTag();
  }

  public static int sub() {
    Sub s = new Sub();
    s.inc(); s.inc();
    return s.twice() * 10000 + s.get();
  }

  public static String fail() {
    try { new Counter().fail(); return "no"; } catch (IllegalStateException e) { return e.getMessage(); }
  }

  public static String list() {
    Mine m = new Mine();
    m.add("a"); m.add("b"); m.add(1);
    return m + ":" + m.size() + ":" + m.contains("<b>") + ":" + m.indexOf("<1>") + ":" + m.equals(Arrays.asList("<a>", "<b>", "<1>")) + ":" + m.hashCode()
      + ":" + new ArrayList<>(m) + ":" + m.subList(1, 3);
  }

  /** the connection the platform's handler makes for each scheme is of the class the host implements, whose abstract methods the host answers */
  public static String opened() throws Exception {
    StringBuilder b = new StringBuilder();
    for (String u : new String[] { "http://example.com/", "https://example.com/" }) {
      HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
      c.disconnect();
      b.append(c instanceof javax.net.ssl.HttpsURLConnection).append(',').append(c.usingProxy()).append(';');
    }
    return b.toString();
  }

  public static String http() throws Exception {
    Conn c = new Conn(new URL("http://example.com/p?q=1"));
    StringBuilder b = new StringBuilder();
    b.append(c.getURL().getHost()).append(',').append(c.getRequestMethod()).append(',').append(c.method()).append(',').append(c.getInstanceFollowRedirects());
    c.setRequestMethod("PUT");
    b.append(',').append(c.getRequestMethod()).append(',').append(c.method());
    c.method("DELETE");
    b.append(',').append(c.getRequestMethod());
    c.setFixedLengthStreamingMode(7);
    b.append(',').append(c.lengths());
    c.setChunkedStreamingMode(0);
    b.append(',').append(c.lengths());
    c.setRequestProperty("A", "b");
    c.addRequestProperty("c", "d");
    b.append(',').append(c.getRequestProperty("a")).append(',').append(c.getRequestProperty("C")).append(',').append(c.getRequestProperty("none"));
    try { c.setRequestMethod("BOGUS"); } catch (ProtocolException e) { b.append(',').append(e.getMessage()); }
    c.connect();
    try { c.setRequestMethod("GET"); } catch (ProtocolException e) { b.append(',').append(e.getMessage()); }
    try { c.setRequestProperty("x", "y"); } catch (IllegalStateException e) { b.append(',').append(e.getMessage()); }
    b.append(',').append(c.usingProxy()).append(',').append(c.getDoInput()).append(',').append(c.getConnectTimeout());
    b.append(',').append(c.getResponseCode()).append(' ').append(c.getResponseMessage());
    return b.toString();
  }
}
