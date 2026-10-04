import java.util.*;

public class Bench {
  static String[] KEYS = new String[1000];
  static { for (int i = 0; i < KEYS.length; i++) KEYS[i] = "key_" + i + "_" + (i * 31); }

  static String JSON;
  static String json() {
    if (JSON != null) return JSON;
    StringBuilder sb = new StringBuilder("{\"items\":[");
    for (int i = 0; i < 1500; i++) {
      if (i > 0) sb.append(',');
      sb.append("{\"id\":").append(i).append(",\"name\":\"Item number ").append(i).append("\",\"price\":").append(i * 1.25)
        .append(",\"tags\":[\"a\",\"b\",\"c\"],\"active\":").append(i % 2 == 0).append(",\"meta\":{\"x\":").append(i * 7).append(",\"y\":null}}");
    }
    return JSON = sb.append("]}").toString();
  }

  static final String PEM =
    "-----BEGIN CERTIFICATE-----\n" +
    "MIICWTCCAd+gAwIBAgIQZvI9r4fei7FK6gxXMQHC7DAKBggqhkjOPQQDAzBlMQsw\n" +
    "CQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMTYwNAYD\n" +
    "VQQDEy1NaWNyb3NvZnQgRUNDIFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIw\n" +
    "MTcwHhcNMTkxMjE4MjMwNjQ1WhcNNDIwNzE4MjMxNjA0WjBlMQswCQYDVQQGEwJV\n" +
    "UzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMTYwNAYDVQQDEy1NaWNy\n" +
    "b3NvZnQgRUNDIFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMTcwdjAQBgcq\n" +
    "hkjOPQIBBgUrgQQAIgNiAATUvD0CQnVBEyPNgASGAlEvaqiBYgtlzPbKnR5vSmZR\n" +
    "ogPZnZH6thaxjG7efM3beaYvzrvOcS/lpaso7GMEZpn4+vKTEAXhgShC48Zo9OYb\n" +
    "hGBKia/teQ87zvH2RPUBeMCjVDBSMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8E\n" +
    "BTADAQH/MB0GA1UdDgQWBBTIy5lycFIM+Oa+sgRXKSrPQhDtNTAQBgkrBgEEAYI3\n" +
    "FQEEAwIBADAKBggqhkjOPQQDAwNoADBlAjBY8k3qDPlfXu5gKcs68tvWMoQZP3zV\n" +
    "L8KxzJOuULsJMsbG7X7JNpQS5GiFBqIb0C8CMQCZ6Ra0DvpWSNSkMBaReNtUjGUB\n" +
    "iudQZsIxtzm6uBoiB078a1QWIP8rtedMDE2mT3M=\n" +
    "-----END CERTIFICATE-----\n";
  static byte[] MB;
  static java.security.KeyPair EC;
  static byte[] SIG;
  static void ecdsa() throws Exception {
    if (EC != null) return;
    java.security.KeyPairGenerator g = java.security.KeyPairGenerator.getInstance("EC");
    g.initialize(256);
    EC = g.generateKeyPair();
    java.security.Signature s = java.security.Signature.getInstance("SHA256withECDSA");
    s.initSign(EC.getPrivate());
    s.update(KEYS[0].getBytes());
    SIG = s.sign();
  }
  static int crypto(String w) throws Exception {
    if (w.equals("sha256")) { if (MB == null) { MB = new byte[1 << 20]; for (int i = 0; i < MB.length; i++) MB[i] = (byte) (i * 31); } return java.security.MessageDigest.getInstance("SHA-256").digest(MB)[0]; }
    if (w.equals("ecdsaVerify")) { ecdsa(); java.security.Signature s = java.security.Signature.getInstance("SHA256withECDSA"); s.initVerify(EC.getPublic()); s.update(KEYS[0].getBytes()); return s.verify(SIG) ? 1 : 0; }
    java.security.cert.X509Certificate c = (java.security.cert.X509Certificate) java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(new java.io.ByteArrayInputStream(PEM.getBytes()));
    return c.getSubjectX500Principal().getName().length() + c.getEncoded().length;
  }
  static java.io.File ZIP;
  static java.io.File zip() throws java.io.IOException {
    if (ZIP != null) return ZIP;
    java.io.File f = new java.io.File(System.getProperty("java.io.tmpdir"), "bench.zip");
    try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new java.io.FileOutputStream(f))) {
      for (String k : KEYS) { z.putNextEntry(new java.util.zip.ZipEntry("res/drawable/" + k + ".png")); z.write(k.getBytes()); z.closeEntry(); }
    }
    return ZIP = f;
  }

  public static int run(String w) throws Exception {
    switch (w) {
      case "sha256": case "ecdsaVerify": case "certParse": try { return crypto(w); } catch (Exception e) { throw new RuntimeException(e); }
      case "listAddGet": { ArrayList<Integer> l = new ArrayList<>(); for (int i = 0; i < 2000; i++) l.add(i); int s = 0; for (int r = 0; r < 5; r++) for (int i = 0; i < l.size(); i++) s += l.get(i); return s; }
      case "listIter": { ArrayList<Integer> l = new ArrayList<>(); for (int i = 0; i < 2000; i++) l.add(i); int s = 0; for (int r = 0; r < 5; r++) for (Integer x : l) s += x; return s; }
      case "listRemove": { ArrayList<Integer> l = new ArrayList<>(); for (int i = 0; i < 2000; i++) l.add(i); int s = 0; while (l.size() > 1000) s += l.remove(0); for (int i = 0; i < 500; i++) l.remove(Integer.valueOf(1000 + i * 2)); return s + l.size(); }
      case "mapStr": { HashMap<String, Integer> m = new HashMap<>(); for (int i = 0; i < KEYS.length; i++) m.put(KEYS[i], i); int s = 0; for (int r = 0; r < 5; r++) for (String k : KEYS) s += m.get(k); return s; }
      case "mapInt": { HashMap<Integer, Integer> m = new HashMap<>(); for (int i = 0; i < 1000; i++) m.put(i, i); int s = 0; for (int r = 0; r < 5; r++) for (int i = 0; i < 1000; i++) s += m.get(i); return s; }
      case "mapWalk": { HashMap<String, Integer> m = new HashMap<>(); for (int i = 0; i < KEYS.length; i++) m.put(KEYS[i], i); int s = 0; for (int r = 0; r < 5; r++) { for (Map.Entry<String, Integer> e : m.entrySet()) s += e.getValue(); for (String k : m.keySet()) s += k.length(); } return s; }
      case "linkedMap": { LinkedHashMap<String, Integer> m = new LinkedHashMap<>(); for (int i = 0; i < KEYS.length; i++) m.put(KEYS[i], i); int s = 0; for (int r = 0; r < 3; r++) { for (String k : KEYS) s += m.get(k); for (Integer v : m.values()) s += v; } return s; }
      case "hashSet": { HashSet<String> h = new HashSet<>(); for (String k : KEYS) h.add(k); int s = 0; for (int r = 0; r < 5; r++) for (String k : KEYS) if (h.contains(k)) s++; return s; }
      case "smallAlloc": { int s = 0; for (int i = 0; i < 500; i++) { ArrayList<String> l = new ArrayList<>(); l.add("a"); l.add("b"); HashMap<String, String> m = new HashMap<>(); m.put("x", "1"); m.put("y", "2"); s += l.size() + m.size(); } return s; }
      case "deque": { ArrayDeque<Integer> d = new ArrayDeque<>(); int s = 0; for (int r = 0; r < 5; r++) { for (int i = 0; i < 1000; i++) d.offer(i); while (!d.isEmpty()) s += d.poll(); } return s; }
      case "treeMap": { TreeMap<String, Integer> t = new TreeMap<>(); for (int i = 0; i < KEYS.length; i++) t.put(KEYS[i], i); int s = 0; for (String k : KEYS) s += t.get(k); for (String k : t.keySet()) s += k.length(); return s; }
      case "sort": { ArrayList<Integer> l = new ArrayList<>(); for (int i = 0; i < 2000; i++) l.add((i * 7919) % 2003); Collections.sort(l); ArrayList<String> sl = new ArrayList<>(Arrays.asList(KEYS)); Collections.sort(sl, Collections.reverseOrder()); return l.get(0) + sl.get(0).length(); }
      case "mix": { HashMap<String, List<Integer>> m = new HashMap<>(); int s = 0; for (int i = 0; i < 20000; i++) { String k = KEYS[i % 997]; List<Integer> l = m.get(k); if (l == null) { l = new ArrayList<>(); m.put(k, l); } l.add(i); if ((i & 7) == 0) s += l.size(); } for (List<Integer> l : m.values()) s += l.get(l.size() - 1); return s; }
      case "linkedList": { LinkedList<Integer> l = new LinkedList<>(); for (int i = 0; i < 2000; i++) l.add(i); int s = 0; for (Integer x : l) s += x; while (!l.isEmpty()) s += l.removeFirst(); return s; }
      case "b64java": { byte[] b = new byte[100000]; for (int i = 0; i < b.length; i++) b[i] = (byte) (i * 31); String e = java.util.Base64.getEncoder().encodeToString(b); return java.util.Base64.getDecoder().decode(e).length + e.length(); }
      case "b64android": { byte[] b = new byte[100000]; for (int i = 0; i < b.length; i++) b[i] = (byte) (i * 31); String e = android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP); return android.util.Base64.decode(e, 0).length + e.length(); }
      case "jsonParse": { try { org.json.JSONObject o = new org.json.JSONObject(json()); org.json.JSONArray a = o.getJSONArray("items"); int s = 0; for (int i = 0; i < a.length(); i++) { org.json.JSONObject it = a.getJSONObject(i); s += it.getInt("id") + it.getString("name").length() + it.getJSONArray("tags").length(); } return s; } catch (org.json.JSONException e) { throw new RuntimeException(e); } }
      case "jsonWrite": { try { org.json.JSONObject o = new org.json.JSONObject(json()); return o.toString().length(); } catch (org.json.JSONException e) { throw new RuntimeException(e); } }
      case "scanTokens": { StringBuilder sb = new StringBuilder(); for (int i = 0; i < 2000; i++) sb.append(i).append(' '); Scanner sc = new Scanner(sb.toString()); int s = 0; while (sc.hasNextInt()) s += sc.nextInt(); return s; }
      case "scanLines": { StringBuilder sb = new StringBuilder(); for (int i = 0; i < 2000; i++) sb.append("line ").append(i).append('\n'); Scanner sc = new Scanner(sb.toString()); int s = 0; while (sc.hasNextLine()) s += sc.nextLine().length(); return s; }
      case "format": { int s = 0; for (int i = 0; i < 1000; i++) s += String.format("%d: %s %5.2f%%", i, KEYS[i], i * 0.37).length(); return s; }
      case "dtoa": { int s = 0; for (int i = 0; i < 2000; i++) s += Double.toString(i * 1.37e-3 + i / 7.0).length() + Float.toString(i * 0.3f).length(); return s; }
      case "parseFail": { int s = 0; for (int i = 0; i < 1000; i++) try { s += Integer.parseInt(KEYS[i]); } catch (NumberFormatException e) { s++; } return s; }
      case "parseFailMixed": { int s = 0; for (int i = 0; i < 300; i++) { try { s += (int) Long.parseLong(KEYS[i]); } catch (NumberFormatException e) { s++; } try { s += (int) Double.parseDouble(KEYS[i]); } catch (NumberFormatException e) { s++; } try { s += Integer.valueOf(KEYS[i], 16); } catch (NumberFormatException e) { s++; } } return s; }
      case "fbLoop": { java.nio.FloatBuffer fb = java.nio.ByteBuffer.allocateDirect(4 * 4096).order(java.nio.ByteOrder.nativeOrder()).asFloatBuffer(); int s = 0; for (int r = 0; r < 5; r++) { fb.clear(); for (int i = 0; i < 4096; i++) fb.put(i * 0.5f); fb.flip(); s += fb.remaining(); } return s; }
      case "fbBulk": { java.nio.FloatBuffer fb = java.nio.ByteBuffer.allocateDirect(4 * 4096).order(java.nio.ByteOrder.nativeOrder()).asFloatBuffer(); float[] a = new float[4096]; int s = 0; for (int r = 0; r < 50; r++) { fb.clear(); fb.put(a); fb.flip(); s += fb.get(r); } return s; }
      case "bbInts": { java.nio.ByteBuffer bb = java.nio.ByteBuffer.allocate(4 * 4096); int s = 0; for (int r = 0; r < 5; r++) { bb.clear(); for (int i = 0; i < 4096; i++) bb.putInt(i); bb.flip(); while (bb.hasRemaining()) s += bb.getInt(); } return s; }
      case "dbInts": { java.nio.ByteBuffer bb = java.nio.ByteBuffer.allocateDirect(4 * 4096); int s = 0; for (int r = 0; r < 5; r++) { bb.clear(); for (int i = 0; i < 4096; i++) bb.putInt(i); bb.flip(); while (bb.hasRemaining()) s += bb.getInt(); } return s; }
      case "casts": { Object[] os = { new ArrayList<String>(), new LinkedList<String>(), new HashMap<String, String>(), "s", 7, new ArrayDeque<String>(), new TreeMap<String, String>() }; int s = 0; for (int r = 0; r < 20000; r++) { Object o = os[r % os.length]; if (o instanceof Collection) s += ((Collection<?>) o).size(); else if (o instanceof Map) s += ((Map<?, ?>) o).size(); if (o instanceof RandomAccess) s++; if (o instanceof CharSequence) s += 2; if (o instanceof Number) s += ((Number) o).intValue(); if (o instanceof List) s += ((List<?>) o).size(); } return s; }
      case "monitors": { StringBuffer sb = new StringBuffer(); Object lock = new Object(); int s = 0; for (int i = 0; i < 20000; i++) { synchronized (lock) { synchronized (lock) { s += i; } } if ((i & 255) == 0) { sb.setLength(0); } sb.append('x'); } return s + sb.length(); }
      case "random": { Random r = new Random(42); int s = 0; for (int i = 0; i < 20000; i++) s += r.nextInt(1000); double d = 0; for (int i = 0; i < 5000; i++) d += r.nextDouble(); return s + (int) d; }
      case "strConcat": { StringBuilder sb = new StringBuilder(); for (int i = 0; i < 2000; i++) { sb.append("item").append(i).append(','); } return sb.toString().length(); }
      case "zipOpen": { try (java.util.zip.ZipFile z = new java.util.zip.ZipFile(zip())) { int s = z.size(); for (int i = 0; i < KEYS.length; i += 4) s += (int) z.getEntry("res/drawable/" + KEYS[i] + ".png").getSize(); return s; } }
      case "inetCached": { int s = 0; for (int i = 0; i < 1000; i++) s += java.net.InetAddress.getByName("localhost").getAddress().length; return s; }
      case "ssbAppend": { android.text.SpannableStringBuilder b = new android.text.SpannableStringBuilder(); for (int i = 0; i < 200; i++) { if ((i & 3) == 0) b.append(KEYS[i], new android.text.style.StyleSpan(1), 33); else b.append(KEYS[i]).append(' '); } return b.length() + b.toString().length(); }
      case "ssbEdit": { android.text.SpannableStringBuilder b = new android.text.SpannableStringBuilder("The quick brown fox jumps over the lazy dog"); b.setSpan(new android.text.style.StyleSpan(1), 4, 9, 33); b.setSpan(new android.text.style.UnderlineSpan(), 10, 19, 18); android.text.Selection.setSelection(b, 20); for (int i = 0; i < 200; i++) { int at = android.text.Selection.getSelectionEnd(b); b.replace(at, at, "x"); if ((i & 7) == 7) b.delete(at - 3, at); } return b.length(); }
      case "ssbGetSpans": { android.text.SpannableStringBuilder b = new android.text.SpannableStringBuilder(KEYS[0] + KEYS[1] + KEYS[2] + KEYS[3] + KEYS[4]); for (int i = 0; i < 40; i++) b.setSpan((i & 1) == 0 ? new android.text.style.ForegroundColorSpan(i) : new android.text.style.StyleSpan(1), i % 30, i % 30 + 5, 33); int s = 0; for (int i = 0; i < 500; i++) { int a = i % 30; s += b.getSpans(a, a + 3, android.text.style.CharacterStyle.class).length + b.nextSpanTransition(a, b.length(), android.text.style.MetricAffectingSpan.class); } return s; }
      case "spannedCopy": { int s = 0; for (int i = 0; i < 100; i++) { android.text.SpannableString t = new android.text.SpannableString(KEYS[i] + " " + KEYS[i + 1]); t.setSpan(new android.text.style.StyleSpan(1), 0, 4, 33); t.setSpan(new android.text.style.ForegroundColorSpan(-65536), 5, 9, 33); t.setSpan(new android.text.style.RelativeSizeSpan(1.5f), 2, 7, 33); CharSequence c = android.text.TextUtils.stringOrSpannedString(t); s += ((android.text.Spanned) c).getSpans(0, c.length(), Object.class).length + c.toString().length(); } return s; }
      case "linkify": { android.text.SpannableString t = new android.text.SpannableString("Visit example.com or https://www.android.com/path?q=1, mail user@example.com, not a@b"); android.text.util.Linkify.addLinks(t, 3); return t.getSpans(0, t.length(), Object.class).length; }
    }
    throw new IllegalArgumentException(w);
  }
}
