// Run by gen-framework on the reference device (app_process): every single-byte charset's name,
// aliases, encoder replacement and the character each byte decodes to.
import java.nio.charset.Charset;

public class DumpCharsets {
  public static void main(String[] args) {
    byte[] bytes = new byte[256];
    for (int i = 0; i < 256; i++) bytes[i] = (byte) i;
    for (String name : Charset.availableCharsets().keySet()) {
      Charset cs = Charset.forName(name);
      if (cs.newEncoder().maxBytesPerChar() != 1f) continue;
      String text = new String(bytes, cs);
      if (text.length() != 256) continue;
      StringBuilder out = new StringBuilder(cs.name()).append('\t').append(String.join(" ", cs.aliases())).append('\t');
      for (byte b : cs.newEncoder().replacement()) out.append(b & 255).append(' ');
      out.append('\t');
      for (int i = 0; i < 256; i++) out.append(Integer.toHexString(text.charAt(i))).append(' ');
      System.out.println(out);
    }
  }
}
