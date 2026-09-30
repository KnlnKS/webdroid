import android.graphics.Typeface;
import android.graphics.text.LineBreakConfig;
import android.text.StaticLayout;
import android.text.TextPaint;
import java.nio.file.Files;
import java.nio.file.Paths;

/** StaticLayout on the reference device for each "text<TAB>width<TAB>size" line of the file named by
 *  args[0] (\n and \t escaped), under every break strategy, without and with letter spacing:
 *  "case strategy spacing end:width:ascent:descent ..." per layout, and "advances case spacing a0 a1 ..."
 *  with each character's advance, measured per paragraph as StaticLayout measures. Run by
 *  `bun run textcmp --record`. */
public class TextLayoutProbe {
  public static void main(String[] args) throws Exception {
    android.os.Looper.prepareMainLooper();
    Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);   // LineBreakConfig reads the target SDK
    Typeface.class.getDeclaredMethod("loadPreinstalledSystemFontMap").invoke(null);      // what the zygote preloads
    LineBreakConfig none = new LineBreakConfig.Builder().setLineBreakStyle(0).setLineBreakWordStyle(0).build();
    TextPaint p = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
    int i = 0;
    for (String line : Files.readAllLines(Paths.get(args[0]))) {
      String[] f = line.split("\t");
      String text = f[0].replace("\\n", "\n").replace("\\t", "\t");
      p.setTextSize(Float.parseFloat(f[2]));
      for (int spacing = 0; spacing <= 1; spacing++) {
        p.setLetterSpacing(spacing * 0.05f);
        char[] chars = text.toCharArray();
        float[] adv = new float[chars.length];
        for (int start = 0; start < chars.length;) {
          int end = text.indexOf('\n', start) + 1;
          if (end == 0) end = chars.length;
          p.getTextRunAdvances(chars, start, end - start, start, end - start, false, adv, start);
          start = end;
        }
        StringBuilder b = new StringBuilder("advances ").append(i).append(' ').append(spacing);
        for (float x : adv) b.append(' ').append(x);
        System.out.println(b);
      }
      for (int strategy = 0; strategy <= 2; strategy++) for (int spacing = 0; spacing <= 1; spacing++) {
        p.setLetterSpacing(spacing * 0.05f);
        StaticLayout l = StaticLayout.Builder.obtain(text, 0, text.length(), p, Integer.parseInt(f[1]))
          .setBreakStrategy(strategy).setLineBreakConfig(none).build();
        StringBuilder b = new StringBuilder().append(i).append(' ').append(strategy).append(' ').append(spacing);
        for (int k = 0; k < l.getLineCount(); k++)
          b.append(' ').append(l.getLineEnd(k)).append(':').append(l.getLineWidth(k)).append(':').append(l.getLineAscent(k)).append(':').append(l.getLineDescent(k));
        System.out.println(b);
      }
      i++;
    }
  }
}
