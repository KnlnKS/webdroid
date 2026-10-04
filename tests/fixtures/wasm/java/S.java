/** String and StringBuilder behaviour over the AOSP libraries: each method folds its string operations into an int. Characters beyond Latin-1 take the UTF-16 paths. */
public class S {
  static final String K = "k\u00e9y\ud83d\ude00"; static final String E = ""; static String lazy = K + "!"; static final String[] NAMES = {"a", K, E, null};
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
  public static int copy(int n) {
    int[] a = new int[8]; for (int i = 0; i < 8; i++) a[i] = i * i + n;
    System.arraycopy(a, 0, a, 2, 5); System.arraycopy(a, 3, a, 1, 4);
    char[] c = new char[6]; "abcdef".getChars(0, 6, c, 0); System.arraycopy(c, 1, c, 0, 5);
    String[] s = {"p", "q", "r"}; Object[] o = new Object[4]; System.arraycopy(s, 0, o, 1, 3);
    long[] l = {1L << 40, 2, 3}; System.arraycopy(l, 0, l, 1, 2);
    int r = 0; for (int v : a) r = r * 31 + v; r = r * 31 + new String(c).hashCode() + (o[0] == null ? 1 : 0) + (o[3] == s[2] ? 2 : 0) + (int) (l[1] >> 40) + (int) l[2];
    try { System.arraycopy(a, n, a, 0, 8); } catch (ArrayIndexOutOfBoundsException e) { r += 1000; }
    try { System.arraycopy(null, 0, a, 0, 1); } catch (NullPointerException e) { r += 2000; }
    return r;
  }
  public static int dispatch(int n) {
    Object o = mk(n, 7); CharSequence cs = (CharSequence) o; @SuppressWarnings("unchecked") Comparable<String> cmp = (Comparable<String>) o;
    return o.hashCode() + (o.equals(mk(n, 7)) ? 1 : 0) + cs.length() + (n > 0 ? cs.charAt(n - 1) : 0) + cmp.compareTo(mk(n + 1, 7)) + o.toString().length()
      + (o instanceof String ? 1 : 0) + (o instanceof CharSequence ? 2 : 0) + (o instanceof Integer ? 4 : 0) + (cs instanceof Comparable ? 8 : 0) + (o instanceof Number ? 16 : 0) + cs.subSequence(0, n / 2).length();
  }
  public static int map(int n) {
    java.util.HashMap<String, String> m = new java.util.HashMap<>(); java.util.ArrayList<String> keys = new java.util.ArrayList<>();
    for (int i = 0; i < n; i++) { String k = mk(i % 7 + 1, 3); if (m.put(k, mk(i % 5, 11)) == null) keys.add(k); }
    int r = m.size() * 1000 + keys.size(); for (String k : keys) r = r * 31 + m.get(k).hashCode() + (m.containsKey(k) ? 1 : 0);
    java.util.TreeMap<String, String> t = new java.util.TreeMap<>(m); for (java.util.Map.Entry<String, String> e : t.entrySet()) r = r * 17 + e.getKey().hashCode() - e.getValue().length();
    return r + (m.containsKey("nope") ? 1 : 0);
  }
  public static int statics(int n) {
    return K.length() + K.hashCode() + E.length() + lazy.hashCode() + NAMES.length + NAMES[1].hashCode() + (NAMES[3] == null ? 1 : 0) + (K == NAMES[1] ? 2 : 0) + n;
  }
  public static int enc(int n) throws Exception {
    String s = mk(n, 11) + mk(n, 3); byte[] b = s.getBytes(), c = s.getBytes("UTF-8"); int r = b.length * 31 + c.length;
    for (int i = 0; i < b.length; i++) r = r * 17 + b[i] + c[b.length - 1 - i];
    return r + new String(b, "UTF-8").hashCode() + new String(c, 0, c.length / 2).length();
  }
  public static int cat(int n) { int r = 0; for (int i = 0; i < n; i++) { String k = "key_" + i + "_" + (i * 31); r = r * 31 + k.hashCode() + k.length(); } return r; }
  public static int mapKeys(int n) {
    String[] keys = new String[n]; for (int i = 0; i < n; i++) keys[i] = "key_" + i + "_" + (i * 31);
    java.util.HashMap<String, Integer> m = new java.util.HashMap<>(); for (int i = 0; i < n; i++) m.put(keys[i], i);
    int s = m.size() * 1000003; for (int r = 0; r < 2; r++) for (String k : keys) s += m.get(k); return s;
  }
}
