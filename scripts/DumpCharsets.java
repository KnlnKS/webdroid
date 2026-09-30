// Run by gen-framework on the reference device (app_process): every single-byte charset's name,
// aliases (in the order aliases() iterates them), encoder replacement, the character each byte
// decodes to, and the bytes whose character does not encode back to them.
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.Charset;
import java.nio.charset.CharsetEncoder;

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
      out.append('\t');
      for (int i = 0; i < 256; i++) {
        if (text.charAt(i) == '�') continue;
        CharsetEncoder e = cs.newEncoder();
        ByteBuffer one = ByteBuffer.allocate(4);
        if (e.encode(CharBuffer.wrap(new char[] { text.charAt(i) }), one, true).isError() || one.position() != 1 || (one.get(0) & 255) != i)
          out.append(i).append(' ');
      }
      System.out.println(out);
    }
  }
}
