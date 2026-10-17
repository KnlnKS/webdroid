import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Path;
import android.graphics.drawable.Drawable;
import java.lang.reflect.Method;

/** VectorDrawable and PathParser on the reference device, for `pnpm fwtest` and the browser
 *  test's pixels: framework vectors drawn into ARGB bitmaps (one "px" line of hex colours each),
 *  node properties by target name, and paths PathParser builds (approximated). Run by
 *  `pnpm ts scripts/vector-probe.ts`. */
public class VectorDrawableProbe {
  static Object call(Object o, String name, Object... args) throws Exception {
    for (Class<?> c = o instanceof Class ? (Class<?>) o : o.getClass(); c != null; c = c.getSuperclass())
      for (Method m : c.getDeclaredMethods())
        if (m.getName().equals(name) && m.getParameterCount() == args.length) { m.setAccessible(true); return m.invoke(o instanceof Class ? null : o, args); }
    throw new NoSuchMethodException(name);
  }
  static void pixels(String name, Drawable d, int w, int h) {
    Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
    d.setBounds(0, 0, w, h);
    d.draw(new Canvas(b));
    StringBuilder s = new StringBuilder("px ").append(name).append(' ').append(w).append(' ').append(h);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) s.append(' ').append(Integer.toHexString(b.getPixel(x, y)));
    System.out.println(s);
  }
  public static void main(String[] args) throws Exception {
    android.os.Looper.prepareMainLooper();
    Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
    Class<?> parser = Class.forName("android.util.PathParser");
    for (String data : new String[] { "M1,2 l3-4 h5 v6 c1 2 3 4 5 6 s1 2 3 4 q1 2 3 4 t5 6 a5 5 0 0 1 10 10 z",
        "M10 10 L20 10 L20 20 Z m5 5 l1-1.5.5e1 2 H2 V8 C0 0 1 1 2 2 S3 3 4 4 Q5 5 6 6 T7 7 A 3 4 30 1 0 12 14" }) {
      Path p = (Path) call(parser, "createPathFromPathData", data);
      StringBuilder s = new StringBuilder("path");
      for (float v : p.approximate(0.5f)) s.append(' ').append(v);
      System.out.println(s);
    }
    for (String bad : new String[] { "M1 2 x3 4", "   ", "M1 2 L3 4e99", "M1 2 L3", "M1 2 z 3", "M1 2 Lq" }) {
      try { call(parser, "createPathFromPathData", bad); System.out.println("parsed " + bad); }
      catch (java.lang.reflect.InvocationTargetException e) { System.out.println("error " + e.getCause()); }
    }
    Resources res = Resources.getSystem();
    Resources.Theme theme = res.newTheme();
    theme.applyStyle(android.R.style.Theme_Material_Light, true);
    int check = res.getIdentifier("btn_checkbox_checked_mtrl", "drawable", "android");
    int back = res.getIdentifier("ic_ab_back_material", "drawable", "android");
    Drawable box = res.getDrawable(check, theme);
    System.out.println("size " + box.getIntrinsicWidth() + " " + box.getIntrinsicHeight() + " " + box.getOpacity());
    for (String target : new String[] { "icon_null", "check", "box_dilate", "check_path_merged", "box_inner_merged" }) {
      Object o = call(box, "getTargetByName", target);
      StringBuilder s = new StringBuilder("target ").append(target);
      String[] getters = o.getClass().getSimpleName().equals("VGroup")
        ? new String[] { "getRotation", "getPivotX", "getPivotY", "getScaleX", "getScaleY", "getTranslateX", "getTranslateY" }
        : new String[] { "getStrokeWidth", "getStrokeColor", "getStrokeAlpha", "getFillColor", "getFillAlpha", "getTrimPathStart", "getTrimPathEnd", "getTrimPathOffset" };
      for (String g : getters) s.append(' ').append(call(o, g));
      System.out.println(s);
    }
    pixels("checkbox", box, 24, 24);
    pixels("checkbox-wide", box, 36, 30);
    box.setAlpha(128);
    pixels("checkbox-alpha", box, 24, 24);
    Drawable arrow = res.getDrawable(back, theme);
    pixels("back", arrow, 24, 24);
    arrow.setLayoutDirection(1);
    pixels("back-rtl", arrow, 24, 24);
  }
}
