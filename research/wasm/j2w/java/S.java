/** String and StringBuilder behaviour over the AOSP libraries: each method folds its string operations into an int. Characters beyond Latin-1 take the UTF-16 paths. */
public class S {
  static String mk(int n, int stride) { char[] c = new char[n]; for (int i = 0; i < n; i++) c[i] = (char) ('a' + (i * stride + n) % 26 + (stride > 7 ? 0x3b0 : 0)); return new String(c); }
  public static int basics(int n) {
    String a = mk(n, 7), b = mk(n, 7), c = mk(n + 1, 7);
    return a.length() + (a.isEmpty() ? 100 : 0) + a.hashCode() + (a.equals(b) ? 1 : 0) + (a.equals(c) ? 2 : 0) + (a.equals(null) ? 4 : 0) + a.compareTo(c) * 3 + c.compareTo(a) + (a.equals((Object) "x") ? 8 : 0) + ("hello" == "hel" + "lo" ? 16 : 0);
  }
  public static int wide(int n) { String a = mk(n, 11), b = mk(n, 5); return a.hashCode() * 31 + a.compareTo(b) + a.length() + a.charAt(n / 2 % Math.max(1, a.length()) ) * (n > 0 ? 1 : 0); }
  public static int parts(int n) {
    String a = mk(n, 3); int r = 0;
    for (int i = 0; i <= n; i += 3) r += a.substring(i).hashCode() + a.substring(i / 2, i).length();
    char[] cs = a.toCharArray(); r += cs.length + (n > 0 ? cs[n - 1] : 0);
    return r + a.indexOf('c') + a.indexOf("cd") + a.lastIndexOf('b') + (a.startsWith("a") ? 1 : 0) + (a.endsWith("z") ? 2 : 0) + (a.contains("de") ? 4 : 0) + a.concat(a).length();
  }
  public static int sb(int n) {
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < n; i++) { b.append("x").append((char) ('a' + i % 26)); if (i % 5 == 0) b.insert(0, "<").append(mk(i % 4, 5)); }
    b.reverse(); if (b.length() > 3) b.deleteCharAt(1); b.setLength(Math.max(0, b.length() - 1));
    String s = b.toString();
    return s.length() + s.hashCode() + b.indexOf("x") + (b.length() > 2 ? b.charAt(2) : 0);
  }
  public static int sw(int n) {
    switch (mk(n % 4, 7)) { case "": return 1; case "h": return 2; case "hn": return 3; case "hnu": return 4; default: return 5; }
  }
  public static int cmp(int n) { String a = mk(n, 7), b = mk(n, 9); return a.compareTo(b) + b.compareTo(a) + "".compareTo(a); }
  public static int bytes(int n) { byte[] raw = new byte[n]; for (int i = 0; i < n; i++) raw[i] = (byte) (i * 37 + 65); String s = new String(raw, 0, n); return s.length() + s.hashCode() + new String(raw).length(); }
  public static int chars(int n) { char[] c = mk(n, 7).toCharArray(); String s = String.valueOf(c); return s.hashCode() + new String(c, n / 3, n - n / 3).length() + String.valueOf(c, 0, n / 2).hashCode(); }
  public static int err(int n) { try { return mk(5, 7).substring(n, 3).length(); } catch (StringIndexOutOfBoundsException e) { return -1; } }
  public static int err2(int n) { try { return mk(5, 7).charAt(n); } catch (StringIndexOutOfBoundsException e) { return -2; } }
  public static int err3(int n) { try { return new String(new char[4], n, 2).length(); } catch (IndexOutOfBoundsException e) { return -3; } }
}
