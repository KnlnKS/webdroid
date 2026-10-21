import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.text.LineBreakConfig;
import android.graphics.text.PositionedGlyphs;
import android.graphics.text.TextRunShaper;
import android.text.StaticLayout;
import android.text.TextPaint;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Locale;

/** StaticLayout on the reference device for each "text<TAB>width<TAB>size[<TAB>locale<TAB>hyphenation
 *  frequency]" line of the file named by args[0] (\n and \t escaped), under every break strategy,
 *  without and with letter spacing: "case strategy spacing end:width:ascent:descent:startEdit:endEdit
 *  ..." per layout, "hyphen case strategy spacing line glyph@x ..." with the glyphs of each line a
 *  hyphen edit ends, and "advances case spacing a0 a1 ..." with each character's advance, measured
 *  per paragraph as StaticLayout measures. With args[1], each "weight size" line of that file gives
 *  "widths weight size hinting w0 w1 ..." with getTextWidths of printable ASCII in the default
 *  family at that weight, hinting on and off. Run by `pnpm gen-framework --only textLayout`. */
public class TextLayoutProbe {
  public static void main(String[] args) throws Exception {
    android.os.Looper.prepareMainLooper();
    Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);   // LineBreakConfig reads the target SDK
    Typeface.class.getDeclaredMethod("loadPreinstalledSystemFontMap").invoke(null);      // what the zygote preloads
    Class.forName("android.text.Hyphenator").getMethod("init").invoke(null);                // and its hyphenation patterns
    LineBreakConfig none = new LineBreakConfig.Builder().setLineBreakStyle(0).setLineBreakWordStyle(0).build();
    TextPaint p = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
    java.lang.reflect.Method startEdit = StaticLayout.class.getMethod("getStartHyphenEdit", int.class);   // hidden
    java.lang.reflect.Method endEdit = StaticLayout.class.getMethod("getEndHyphenEdit", int.class);
    int i = 0;
    for (String line : Files.readAllLines(Paths.get(args[0]))) {
      String[] f = line.split("\t");
      String text = f[0].replace("\\n", "\n").replace("\\t", "\t");
      p.setTextSize(Float.parseFloat(f[2]));
      p.setTextLocale(Locale.forLanguageTag(f.length > 3 ? f[3] : "en-US"));
      int frequency = f.length > 4 ? Integer.parseInt(f[4]) : 0;
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
          .setBreakStrategy(strategy).setHyphenationFrequency(frequency).setLineBreakConfig(none).build();
        StringBuilder b = new StringBuilder().append(i).append(' ').append(strategy).append(' ').append(spacing);
        StringBuilder h = new StringBuilder();
        for (int k = 0; k < l.getLineCount(); k++) {
          int start = (Integer) startEdit.invoke(l, k), end = (Integer) endEdit.invoke(l, k);
          b.append(' ').append(l.getLineEnd(k)).append(':').append(l.getLineWidth(k)).append(':').append(l.getLineAscent(k)).append(':').append(l.getLineDescent(k))
            .append(':').append(start).append(':').append(end);
          if (end == 0) continue;
          TextPaint q = new TextPaint(p);
          q.setStartHyphenEdit(start);
          q.setEndHyphenEdit(end);
          int s = l.getLineStart(k), e = l.getLineEnd(k);
          PositionedGlyphs g = TextRunShaper.shapeTextRun(text, s, e - s, s, e - s, 0, 0, false, q);
          h.append("hyphen ").append(i).append(' ').append(strategy).append(' ').append(spacing).append(' ').append(k);
          for (int j = 0; j < g.glyphCount(); j++) h.append(' ').append(g.getGlyphId(j)).append('@').append(g.getGlyphX(j));
          h.append('\n');
        }
        System.out.println(b);
        System.out.print(h);
      }
      i++;
    }
    if (args.length < 2) return;
    StringBuilder ascii = new StringBuilder();
    for (char c = 0x21; c < 0x7f; c++) ascii.append(c);
    char[] chars = ascii.toString().toCharArray();
    for (String line : Files.readAllLines(Paths.get(args[1]))) {
      String[] f = line.split(" ");
      Paint w = new Paint(Paint.ANTI_ALIAS_FLAG);
      w.setTypeface(Typeface.create(Typeface.DEFAULT, Integer.parseInt(f[0]), false));
      w.setTextSize(Float.parseFloat(f[1]));
      for (int hinting : new int[] { Paint.HINTING_ON, Paint.HINTING_OFF }) {
        w.setHinting(hinting);
        float[] widths = new float[chars.length];
        w.getTextWidths(chars, 0, chars.length, widths);
        StringBuilder b = new StringBuilder("widths ").append(line).append(' ').append(hinting);
        for (float x : widths) b.append(' ').append(x);
        System.out.println(b);
      }
    }
  }
}
