// Run by gen-framework on the reference device (app_process): the first code point of each of ICU's
// Unicode blocks, or of a gap between blocks, with every name ICU knows the block by.
import android.icu.lang.UCharacter;
import android.icu.lang.UProperty;

public class DumpUnicodeBlocks {
  public static void main(String[] args) {
    int last = -1;
    for (int cp = 0; cp <= 0x10ffff; cp++) {
      int block = UCharacter.getIntPropertyValue(cp, UProperty.BLOCK);
      if (block == last) continue;
      last = block;
      StringBuilder out = new StringBuilder(Integer.toHexString(cp));
      for (int choice = 0; block != 0; choice++) {
        String name;
        try { name = UCharacter.getPropertyValueName(UProperty.BLOCK, block, choice); } catch (IllegalArgumentException e) { break; }
        if (name != null) out.append(' ').append(name);
      }
      System.out.println(out);
    }
  }
}
