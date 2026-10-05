public class Nest {
  public static int loop(int n) { int s = 0; java.io.File f = new java.io.File("/"); for (int i = 0; i < n; i++) { String[] l = f.list(); s += l == null ? 0 : l.length; } return s; }
}
