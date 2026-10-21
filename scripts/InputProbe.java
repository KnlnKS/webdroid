// Records the reference AVD's answers for MotionEvent, VelocityTracker, KeyEvent, KeyCharacterMap
// and InputDevice (pnpm gen-framework --only inputProbe); fwtest runs the same dex against our natives.
import android.view.*;
import android.graphics.Matrix;
import android.os.Parcel;
import java.lang.reflect.*;

public class InputProbe {
  static void p(String s) { System.out.println(s); }
  static Object hidden(Object o, Class<?> c, String name, Class<?>[] types, Object... args) {
    try { Method m = c.getDeclaredMethod(name, types); m.setAccessible(true); return m.invoke(o, args); }
    catch (InvocationTargetException e) { return "threw " + e.getCause(); }
    catch (Throwable t) { return "noaccess " + t; }
  }
  static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }
  static String coords(MotionEvent.PointerCoords c) {
    return "x=" + c.x + " y=" + c.y + " p=" + c.pressure + " s=" + c.size + " tM=" + c.touchMajor + " tm=" + c.touchMinor + " TM=" + c.toolMajor + " Tm=" + c.toolMinor + " o=" + c.orientation + " rx=" + fld(c, "relativeX") + " ry=" + fld(c, "relativeY") + " v=" + c.getAxisValue(MotionEvent.AXIS_VSCROLL) + " g1=" + c.getAxisValue(MotionEvent.AXIS_GENERIC_1);
  }
  static String axes(MotionEvent e) {
    return "x=" + e.getX() + " y=" + e.getY() + " rx=" + e.getRawX() + " ry=" + e.getRawY() + " o=" + e.getOrientation() + " tM=" + e.getTouchMajor() + " xp=" + e.getXPrecision() + " yp=" + e.getYPrecision() + " rot=" + h(e, "getSurfaceRotation") + " cur=" + h(e, "getXCursorPosition") + "," + h(e, "getYCursorPosition");
  }
  public static void main(String[] a) throws Exception {
    // --- input devices
    for (int id : InputDevice.getDeviceIds()) {
      InputDevice d = InputDevice.getDevice(id);
      p("device " + id + " " + d.toString().replace("\n", "|"));
      KeyCharacterMap k = d.getKeyCharacterMap();
      p("devkcm " + id + " type=" + k.getKeyboardType() + " virtual=" + d.isVirtual() + " full=" + h(d, "isFullKeyboard") + " ext=" + d.isExternal() + " enabled=" + d.isEnabled() + " ctrl=" + d.getControllerNumber() + " vendor=" + d.getVendorId() + " product=" + d.getProductId()
        + " hasKeys=" + java.util.Arrays.toString(d.hasKeys(KeyEvent.KEYCODE_A, KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_POWER, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_SEARCH)));
    }
    p("deviceHasKeys " + java.util.Arrays.toString(KeyCharacterMap.deviceHasKeys(new int[] { KeyEvent.KEYCODE_A, KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_POWER, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_SEARCH })));
    p("deviceHasKey SEARCH " + KeyCharacterMap.deviceHasKey(KeyEvent.KEYCODE_SEARCH) + " BACK " + KeyCharacterMap.deviceHasKey(KeyEvent.KEYCODE_BACK));

    // --- motion events
    MotionEvent e = MotionEvent.obtain(1000, 1016, MotionEvent.ACTION_DOWN, 100.3f, 200.7f, 0);
    p("me1 " + axes(e) + " | " + e);
    p("me1 nanos " + e.getEventTimeNanos() + " down " + e.getDownTime() + " p=" + e.getPressure() + " s=" + e.getSize() + " tool=" + e.getToolType(0) + " dev=" + e.getDeviceId() + " src=" + e.getSource() + " flags=" + e.getFlags() + " cls=" + e.getClassification() + " disp=" + h(e, "getDisplayId"));
    e.offsetLocation(10.1f, -5.2f);
    p("me1 offset " + axes(e));
    Matrix m = new Matrix(); m.setRotate(90); m.postTranslate(50, 20);
    e.transform(m);
    p("me1 rot90 " + axes(e));
    Matrix m2 = new Matrix(); m2.setRotate(30); m2.postScale(2, 2);
    e.transform(m2);
    p("me1 rot30 " + axes(e));
    MotionEvent.PointerCoords pc = new MotionEvent.PointerCoords();
    e.getPointerCoords(0, pc);
    p("me1 coords " + coords(pc) + " bits=" + fld(pc, "isResampled"));
    MotionEvent e2 = MotionEvent.obtain(e);
    e2.setLocation(7, 9);
    p("me1 setLocation " + axes(e2));
    hidden(e2, MotionEvent.class, "scale", new Class<?>[] { float.class }, 1.5f);
    p("me1 scale " + axes(e2));
    p("me1 rawoff " + hidden(e2, MotionEvent.class, "nativeGetRawXOffset", new Class<?>[] { long.class }, getPtr(e2)));
    e.recycle(); e2.recycle();

    // multi pointer with history
    MotionEvent.PointerProperties[] pp = { new MotionEvent.PointerProperties(), new MotionEvent.PointerProperties() };
    pp[0].id = 0; pp[0].toolType = MotionEvent.TOOL_TYPE_FINGER;
    pp[1].id = 3; pp[1].toolType = MotionEvent.TOOL_TYPE_STYLUS;
    MotionEvent.PointerCoords[] cs = { new MotionEvent.PointerCoords(), new MotionEvent.PointerCoords() };
    cs[0].x = 10; cs[0].y = 20; cs[0].pressure = 0.5f; cs[0].size = 0.25f; cs[0].touchMajor = 12; cs[0].orientation = 0.5f; cs[0].setAxisValue(MotionEvent.AXIS_GENERIC_1, 3);
    cs[1].x = 30; cs[1].y = 40; cs[1].pressure = 1; cs[1].setAxisValue(MotionEvent.AXIS_VSCROLL, -1); setf(cs[1], "relativeX", 2f); setf(cs[1], "relativeY", 3f);
    MotionEvent mp = MotionEvent.obtain(5000, 5020, MotionEvent.ACTION_POINTER_DOWN | (1 << 8), 2, pp, cs, 0x41, 1, 1.5f, 2.5f, 7, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
    cs[0].x = 11; cs[1].x = 33;
    mp.addBatch(5028, cs, KeyEvent.META_ALT_ON);
    cs[0].x = 12; cs[1].x = 36;
    mp.addBatch(5036, cs, 0);
    p("mp " + mp);
    p("mp hist=" + mp.getHistorySize() + " h0=" + mp.getHistoricalX(1, 0) + " t0=" + mp.getHistoricalEventTime(0) + " cur=" + mp.getX(1) + " meta=" + mp.getMetaState() + " idx3=" + mp.findPointerIndex(3) + " idx1=" + mp.findPointerIndex(1) + " ai=" + mp.getActionIndex() + " bits=" + hidden(mp, MotionEvent.class, "getPointerIdBits", new Class<?>[0]));
    mp.getHistoricalPointerCoords(0, 0, pc);
    p("mp hc00 " + coords(pc));
    mp.getPointerCoords(1, pc);
    p("mp c1 " + coords(pc));
    Matrix m3 = new Matrix(); m3.setRotate(90);
    mp.transform(m3);
    mp.getPointerCoords(1, pc);
    p("mp c1 rot " + coords(pc) + " raw1=" + mp.getRawX(1) + "," + mp.getRawY(1) + " o0=" + mp.getOrientation(0));
    p("mp split3 " + hidden(mp, MotionEvent.class, "split", new Class<?>[] { int.class }, 1 << 3));
    p("mp split0 " + hidden(mp, MotionEvent.class, "split", new Class<?>[] { int.class }, 1));
    p("mp split9 " + hidden(mp, MotionEvent.class, "split", new Class<?>[] { int.class }, 1 << 9));
    MotionEvent nh = MotionEvent.obtainNoHistory(mp);
    p("mp nohist " + nh.getHistorySize() + " " + nh.getX(1) + " " + nh.getEventTime());
    Parcel parcel = Parcel.obtain();
    mp.writeToParcel(parcel, 0);
    p("mp parcel size=" + parcel.dataSize() + " " + hex(parcel.marshall()));
    parcel.setDataPosition(0);
    MotionEvent back = MotionEvent.CREATOR.createFromParcel(parcel);
    p("mp back " + back);
    try { mp.getX(5); } catch (Throwable t) { p("mp getX(5) " + t); }
    try { mp.getHistoricalX(0, 7); } catch (Throwable t) { p("mp getHistoricalX(0,7) " + t); }
    hidden(mp, MotionEvent.class, "applyTransform", new Class<?>[] { Matrix.class }, m3);
    p("mp applyTransform " + axes(mp) + " x1=" + mp.getX(1));

    // joystick ignores offsets
    MotionEvent j = MotionEvent.obtain(0, 0, MotionEvent.ACTION_MOVE, 0.5f, -0.25f, 0);
    j.setSource(InputDevice.SOURCE_JOYSTICK);
    j.offsetLocation(5, 5);
    p("joy " + j.getX() + " " + j.getY() + " raw " + j.getRawX());
    MotionEvent mouse = MotionEvent.obtain(0, 0, MotionEvent.ACTION_HOVER_MOVE, 40, 50, 0);
    mouse.setSource(InputDevice.SOURCE_MOUSE);
    p("mouse cur " + h(mouse, "getXCursorPosition") + "," + h(mouse, "getYCursorPosition"));
    mouse.offsetLocation(5, 5);
    p("mouse cur off " + h(mouse, "getXCursorPosition") + "," + h(mouse, "getYCursorPosition"));
    p("axis " + MotionEvent.axisToString(0) + " " + MotionEvent.axisToString(53) + " " + MotionEvent.axisToString(54) + " " + MotionEvent.axisToString(29) + " " + MotionEvent.axisFromString("AXIS_GESTURE_SWIPE_FINGER_COUNT") + " " + MotionEvent.axisFromString("AXIS_BOGUS") + " " + MotionEvent.axisFromString("12"));

    // --- velocity tracker
    vt("default", VelocityTracker.obtain());
    for (String s : new String[] { "impulse", "lsq1", "lsq2", "lsq3", "wlsq2-delta", "wlsq2-central", "wlsq2-recent", "int1", "int2", "legacy" })
      vt(s, (VelocityTracker) hidden(null, VelocityTracker.class, "obtain", new Class<?>[] { String.class }, s));
    VelocityTracker v = VelocityTracker.obtain();
    p("vt supported " + v.isAxisSupported(MotionEvent.AXIS_X) + v.isAxisSupported(MotionEvent.AXIS_Y) + v.isAxisSupported(MotionEvent.AXIS_SCROLL) + v.isAxisSupported(MotionEvent.AXIS_PRESSURE));
    // scroll axis
    long t = 0;
    for (int i = 0; i < 6; i++) {
      MotionEvent.PointerCoords c = new MotionEvent.PointerCoords();
      c.setAxisValue(MotionEvent.AXIS_SCROLL, i % 2 == 0 ? 0.5f : 0.75f);
      MotionEvent.PointerProperties pr = new MotionEvent.PointerProperties(); pr.id = 0;
      MotionEvent s = MotionEvent.obtain(0, t, MotionEvent.ACTION_SCROLL, 1, new MotionEvent.PointerProperties[] { pr }, new MotionEvent.PointerCoords[] { c }, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_ROTARY_ENCODER, 0);
      v.addMovement(s); s.recycle(); t += 10;
    }
    v.computeCurrentVelocity(1000);
    p("vt scroll " + v.getAxisVelocity(MotionEvent.AXIS_SCROLL) + " x=" + v.getXVelocity());
    // two pointers
    v.clear();
    MotionEvent d0 = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 1, pp, cs, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
    v.addMovement(d0);
    for (int i = 1; i <= 5; i++) {
      cs[0].x = 12 + i * 7; cs[0].y = 20 + i * i; cs[1].x = 36 - i * 5; cs[1].y = 40 + i * 3;
      MotionEvent mv = MotionEvent.obtain(0, i * 9, i == 1 ? MotionEvent.ACTION_POINTER_DOWN | (1 << 8) : MotionEvent.ACTION_MOVE, 2, pp, cs, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
      v.addMovement(mv); mv.recycle();
    }
    v.computeCurrentVelocity(1000, 2000);
    p("vt two " + v.getXVelocity(0) + " " + v.getYVelocity(0) + " " + v.getXVelocity(3) + " " + v.getYVelocity(3) + " active=" + v.getXVelocity() + " none=" + v.getXVelocity(5));

    // --- key character map
    KeyCharacterMap k = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
    p("kcm type " + k.getKeyboardType() + " alpha=" + k.isPrintingKey(KeyEvent.KEYCODE_A) + " mod=" + k.getModifierBehavior());
    int[] codes = { KeyEvent.KEYCODE_A, KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_SPACE, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_AT, KeyEvent.KEYCODE_DEL, KeyEvent.KEYCODE_NUMPAD_5, KeyEvent.KEYCODE_PERIOD, KeyEvent.KEYCODE_GRAVE, KeyEvent.KEYCODE_TAB, KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_E, KeyEvent.KEYCODE_STAR, KeyEvent.KEYCODE_NUMPAD_DOT };
    int[] metas = { 0, KeyEvent.META_SHIFT_ON, KeyEvent.META_ALT_ON, KeyEvent.META_CAPS_LOCK_ON, KeyEvent.META_SHIFT_ON | KeyEvent.META_CAPS_LOCK_ON, KeyEvent.META_CTRL_ON, KeyEvent.META_ALT_RIGHT_ON | KeyEvent.META_ALT_ON, KeyEvent.META_NUM_LOCK_ON, KeyEvent.META_FUNCTION_ON };
    for (int c : codes) {
      StringBuilder s = new StringBuilder("kcm " + c + " label=" + (int) k.getDisplayLabel(c) + " number=" + (int) k.getNumber(c) + " match=" + (int) k.getMatch(c, "aA1!@ ".toCharArray()) + " matchShift=" + (int) k.getMatch(c, "aA1!@ ".toCharArray(), KeyEvent.META_SHIFT_ON) + " printing=" + k.isPrintingKey(c) + " get=");
      for (int me : metas) s.append(k.get(c, me)).append(',');
      Object f = hidden(k, KeyCharacterMap.class, "getFallbackAction", new Class<?>[] { int.class, int.class }, c, KeyEvent.META_ALT_ON | KeyEvent.META_SHIFT_ON);
      s.append(" fallback=").append(fa(f));
      Object f2 = hidden(k, KeyCharacterMap.class, "getFallbackAction", new Class<?>[] { int.class, int.class }, c, KeyEvent.META_CTRL_ON);
      s.append(" fallbackCtrl=").append(fa(f2));
      s.append(" mapped=").append(hidden(k, KeyCharacterMap.class, "getMappedKeyOrDefault", new Class<?>[] { int.class, int.class }, c, 7));
      p(s.toString());
    }
    KeyEvent[] evs = k.getEvents("Hi!\n7".toCharArray());
    for (KeyEvent ke : evs) p("kcm ev " + ke.toString().replaceAll("eventTime=\\d+, downTime=\\d+", "T") + " uc=" + ke.getUnicodeChar() + " ucm=" + ke.getUnicodeChar(KeyEvent.META_SHIFT_ON) + " dl=" + (int) ke.getDisplayLabel() + " num=" + (int) ke.getNumber() + " print=" + ke.isPrintingKey() + " flags=" + ke.getFlags() + " src=" + ke.getSource() + " t=" + (ke.getEventTime() == ke.getDownTime()));
    p("kcm unmappable " + (k.getEvents("é".toCharArray()) == null));
    p("kcm deadChar " + KeyCharacterMap.getDeadChar('`', 'a') + " " + KeyCharacterMap.getDeadChar('^', 'e') + " " + KeyCharacterMap.getDeadChar('x', 'a'));
    Parcel kp = Parcel.obtain();
    k.writeToParcel(kp, 0);
    p("kcm parcel size=" + kp.dataSize());
    kp.setDataPosition(0);
    KeyCharacterMap k2 = KeyCharacterMap.CREATOR.createFromParcel(kp);
    p("kcm parcel back type=" + k2.getKeyboardType() + " eq=" + k.equals(k2) + " a=" + k2.get(KeyEvent.KEYCODE_A, KeyEvent.META_SHIFT_ON));
    Object empty = hidden(null, KeyCharacterMap.class, "obtainEmptyMap", new Class<?>[] { int.class }, 5);
    if (empty instanceof KeyCharacterMap) {
      KeyCharacterMap ek = (KeyCharacterMap) empty;
      p("kcm empty type=" + ek.getKeyboardType() + " get=" + ek.get(KeyEvent.KEYCODE_A, 0) + " label=" + (int) ek.getDisplayLabel(KeyEvent.KEYCODE_A) + " mapped=" + hidden(ek, KeyCharacterMap.class, "getMappedKeyOrDefault", new Class<?>[] { int.class, int.class }, 29, 7) + " events=" + ek.getEvents("a".toCharArray()).length + " number=" + (int) ek.getNumber(8) + " match=" + (int) ek.getMatch(29, "a".toCharArray()) + " fb=" + fa(hidden(ek, KeyCharacterMap.class, "getFallbackAction", new Class<?>[] { int.class, int.class }, 62, 2)) + " eq=" + ek.equals(k));
      Parcel ep = Parcel.obtain(); ek.writeToParcel(ep, 0); p("kcm empty parcel " + hex(ep.marshall()));
    } else p("kcm empty " + empty);

    // --- key events
    p("key " + KeyEvent.keyCodeToString(KeyEvent.KEYCODE_A) + " " + KeyEvent.keyCodeToString(1000) + " " + KeyEvent.keyCodeToString(KeyEvent.getMaxKeyCode()) + " " + KeyEvent.keyCodeFromString("KEYCODE_A") + " " + KeyEvent.keyCodeFromString("A") + " " + KeyEvent.keyCodeFromString("1000") + " " + KeyEvent.keyCodeFromString("17") + " " + KeyEvent.keyCodeFromString("garbage") + " max=" + KeyEvent.getMaxKeyCode());
    KeyEvent ke = new KeyEvent(100, 200, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_Q, 0, KeyEvent.META_SHIFT_ON);
    p("key q " + ke.getUnicodeChar() + " " + ke.getDisplayLabel() + " dev=" + ke.getDeviceId() + " src=" + ke.getSource() + " " + ke.toString().replaceAll("eventTime=\\d+, downTime=\\d+", "T"));
    Parcel kep = Parcel.obtain(); ke.writeToParcel(kep, 0); p("key parcel size=" + kep.dataSize());

    // --- every key the virtual keyboard (any device) and the touchscreen report, and their maps
    int[] all = new int[KeyEvent.getMaxKeyCode() + 1];
    for (int i = 0; i < all.length; i++) all[i] = i;
    for (int id : InputDevice.getDeviceIds()) {
      InputDevice d = InputDevice.getDevice(id);
      if (id != -1 && !d.getName().equals("virtio_input_multi_touch_1")) continue;
      boolean[] has = d.hasKeys(all);
      StringBuilder s = new StringBuilder("hasKeys " + id);
      for (int i = 0; i < all.length; i++) if (has[i]) s.append(' ').append(i);
      p(s.toString());
      InputDevice.MotionRange r = d.getMotionRange(MotionEvent.AXIS_X);
      p("range " + id + " " + (r == null ? "null" : r.getMax() + "/" + r.getSource()) + " " + d.getMotionRange(MotionEvent.AXIS_X, InputDevice.SOURCE_TOUCHSCREEN) + " n=" + d.getMotionRanges().size()
        + " supports=" + d.supportsSource(InputDevice.SOURCE_TOUCHSCREEN) + d.supportsSource(InputDevice.SOURCE_KEYBOARD) + d.supportsSource(InputDevice.SOURCE_MOUSE)
        + " bus=" + h(d, "getDeviceBus") + " disp=" + h(d, "getAssociatedDisplayId") + " id=" + h(d, "getIdentifier"));
      KeyCharacterMap dk = d.getKeyCharacterMap();
      p("devkcm2 " + id + " eqVirtual=" + dk.equals(KeyCharacterMap.load(-1)) + " meta-enter=" + fa(hidden(dk, KeyCharacterMap.class, "getFallbackAction", new Class<?>[] { int.class, int.class }, KeyEvent.KEYCODE_ENTER, KeyEvent.META_META_ON))
        + " button-x=" + fa(hidden(dk, KeyCharacterMap.class, "getFallbackAction", new Class<?>[] { int.class, int.class }, KeyEvent.KEYCODE_BUTTON_X, 0)));
    }
    StringBuilder ascii = new StringBuilder();
    for (char c = 32; c < 127; c++) ascii.append(c);
    ascii.append("\n\t\u00e9");
    StringBuilder strokes = new StringBuilder("ascii");
    for (int i = 0; i < ascii.length(); i++) {
      KeyEvent[] ev = k.getEvents(new char[] { ascii.charAt(i) });
      strokes.append(' ');
      if (ev == null) { strokes.append("null"); continue; }
      for (KeyEvent x : ev) strokes.append(x.getAction() == 0 ? "+" : "-").append(x.getKeyCode()).append(x.getMetaState() != 0 ? "/" + Integer.toHexString(x.getMetaState()) : "");
    }
    p(strokes.toString());
    try { k.getEvents(null); } catch (Throwable x) { p("getEvents(null) " + x); }

    // --- a decelerating fling, sampled every frame, and a batched move
    VelocityTracker f = VelocityTracker.obtain();
    float y = 1500;
    long time = 100;
    f.addMovement(MotionEvent.obtain(100, time, MotionEvent.ACTION_DOWN, 300, y, 0));
    StringBuilder fling = new StringBuilder("fling");
    for (int i = 1; i <= 12; i++) {
      time += 16 + (i % 3);
      y -= 60 - i * 3.3f;
      f.addMovement(MotionEvent.obtain(100, time, MotionEvent.ACTION_MOVE, 300 + i * 0.7f, y, 0));
      f.computeCurrentVelocity(1000, 24000);
      fling.append(' ').append(f.getYVelocity()).append('/').append(f.getXVelocity());
    }
    f.addMovement(MotionEvent.obtain(100, time + 5, MotionEvent.ACTION_UP, 300, y, 0));
    f.computeCurrentVelocity(1000, 24000);
    p(fling.append(" up ").append(f.getYVelocity()).toString());
    VelocityTracker b = VelocityTracker.obtain();
    b.addMovement(MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 0, 0, 0));
    MotionEvent batch = MotionEvent.obtain(0, 8, MotionEvent.ACTION_MOVE, 4, 1, 0);
    batch.addBatch(16, 9, 3, 1, 1, 0); batch.addBatch(24, 15, 4, 1, 1, 0);
    b.addMovement(batch);
    b.computeCurrentVelocity(1000);
    p("batched " + b.getXVelocity() + " " + b.getYVelocity());

    // --- the private orientation flags: set by obtain when a pointer has an orientation
    Matrix r90 = new Matrix(); r90.setRotate(90);
    for (int src : new int[] { 2, 0x1002, 0x2002, 0x101 }) {
      for (float o : new float[] { 0f, 0.5f }) {
        MotionEvent.PointerCoords[] oc = { new MotionEvent.PointerCoords() };
        oc[0].x = 5; oc[0].y = 7; oc[0].orientation = o; oc[0].pressure = 1;
        MotionEvent om = MotionEvent.obtain(0, 0, 0, 1, new MotionEvent.PointerProperties[] { new MotionEvent.PointerProperties() }, oc, 0, 0, 1, 1, 0, 0, src, 0);
        Parcel q = Parcel.obtain(); om.writeToParcel(q, 0); q.setDataPosition(0);
        for (int i = 0; i < 18; i++) q.readInt();
        int flags = q.readInt();
        om.transform(r90);
        om.getPointerCoords(0, pc);
        p("orient src=0x" + Integer.toHexString(src) + " o=" + o + " flags=0x" + Integer.toHexString(flags) + " getO=" + om.getOrientation() + " pcO=" + pc.orientation + " x=" + om.getX());
      }
    }
    MotionEvent tainted = MotionEvent.obtain(0, 0, 0, 5, 7, 0);
    hidden(tainted, MotionEvent.class, "setTainted", new Class<?>[] { boolean.class }, true);
    p("tainted 0x" + Integer.toHexString(tainted.getFlags()));
  }
  static Object h(Object o, String name) { return hidden(o, o.getClass(), name, new Class<?>[0]); }
  static Object fld(Object o, String name) { try { Field f = o.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(o); } catch (Throwable t) { return "nofield " + t; } }
  static void setf(Object o, String name, float v) { try { Field f = o.getClass().getDeclaredField(name); f.setAccessible(true); f.setFloat(o, v); } catch (Throwable t) { p("setf " + t); } }
  static String fa(Object f) { return f == null ? "null" : f instanceof String ? (String) f : fld(f, "keyCode") + "/" + fld(f, "metaState"); }
  static long getPtr(MotionEvent e) {
    try { Field f = MotionEvent.class.getDeclaredField("mNativePtr"); f.setAccessible(true); return f.getLong(e); } catch (Throwable t) { return 0; }
  }
  static void vt(String name, VelocityTracker v) {
    if (v == null) { p("vt " + name + " null"); return; }
    float[][] pts = { { 0, 0 }, { 10, 5 }, { 22, 9 }, { 35, 15 }, { 50, 20 }, { 60, 25 } };
    long[] ts = { 0, 8, 16, 24, 33, 40 };
    for (int i = 0; i < pts.length; i++) {
      MotionEvent e = MotionEvent.obtain(0, ts[i], i == 0 ? MotionEvent.ACTION_DOWN : i == pts.length - 1 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE, pts[i][0], pts[i][1], 0);
      v.addMovement(e); e.recycle();
    }
    v.computeCurrentVelocity(1000);
    StringBuilder s = new StringBuilder("vt " + name + " " + v.getXVelocity() + " " + v.getYVelocity());
    v.computeCurrentVelocity(10, 3);
    s.append(" capped ").append(v.getXVelocity()).append(" ").append(v.getYVelocity());
    // a pause before the up
    v.clear();
    MotionEvent e0 = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 0, 0, 0); v.addMovement(e0);
    MotionEvent e1 = MotionEvent.obtain(0, 10, MotionEvent.ACTION_MOVE, 20, 0, 0); v.addMovement(e1);
    MotionEvent e2 = MotionEvent.obtain(0, 20, MotionEvent.ACTION_MOVE, 45, 0, 0); v.addMovement(e2);
    MotionEvent e3 = MotionEvent.obtain(0, 70, MotionEvent.ACTION_UP, 45, 0, 0); v.addMovement(e3);
    v.computeCurrentVelocity(1000);
    s.append(" paused ").append(v.getXVelocity());
    // one sample only
    v.clear(); v.addMovement(e0); v.computeCurrentVelocity(1000);
    s.append(" single ").append(v.getXVelocity());
    p(s.toString());
    v.recycle();
  }
}
