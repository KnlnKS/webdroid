/** Unresolved references: LkGone and LkGoneEx are absent when this runs, LkP, LkI and LkC change between the version this was compiled against (lk/) and the one that runs (lk/v2/). */
public class Lk {
  static String of(Throwable t) { return t.getClass().getName() + ": " + t.getMessage(); }
  static String newGone() { try { new LkGone(); return "ok"; } catch (Throwable t) { return of(t); } }
  static String staticGone() { try { LkGone.sm(); return "ok"; } catch (Throwable t) { return of(t); } }
  static String virtualGone() { try { LkGone g = null; g.vm(); return "ok"; } catch (Throwable t) { return of(t); } }
  static String sgetGone() { try { int x = LkGone.F; return "ok"; } catch (Throwable t) { return of(t); } }
  static String sputGone() { try { LkGone.F = 1; return "ok"; } catch (Throwable t) { return of(t); } }
  static String igetGone() { try { LkGone g = null; int x = g.f; return "ok"; } catch (Throwable t) { return of(t); } }
  static String castGone() { try { Object o = "s"; Object r = (LkGone) o; return "ok"; } catch (Throwable t) { return of(t); } }
  static String instGone() { try { Object o = "s"; boolean b = o instanceof LkGone; return "ok"; } catch (Throwable t) { return of(t); } }
  static String classGone() { try { Class<?> c = LkGone.class; return "ok"; } catch (Throwable t) { return of(t); } }
  static String arrayGone() { try { Object a = new LkGone[2]; return "ok"; } catch (Throwable t) { return of(t); } }
  static String missStatic() { try { LkP.gs(); return "ok"; } catch (Throwable t) { return of(t); } }
  static String missVirtual() { try { new LkP().gv(); return "ok"; } catch (Throwable t) { return of(t); } }
  static String missInit() { try { new LkP(5); return "ok"; } catch (Throwable t) { return of(t); } }
  static String missSget() { try { int x = LkP.gsf; return "ok"; } catch (Throwable t) { return of(t); } }
  static String missIget() { try { int x = new LkP().gif; return "ok"; } catch (Throwable t) { return of(t); } }
  static String missIput() { try { new LkP().gif = 3; return "ok"; } catch (Throwable t) { return of(t); } }
  static String staticNowVirtual() { try { LkP.sm2(); return "ok"; } catch (Throwable t) { return of(t); } }
  static String interfaceNowClass() { try { LkI i = null; i.f(); return "ok"; } catch (Throwable t) { return of(t); } }
  static String classNowInterface() { try { LkC c = null; c.f(); return "ok"; } catch (Throwable t) { return of(t); } }
  /** the executed part of the method before an unresolved site still runs, and a resolved site still works */
  static int partial(int a) { int s = a * 2; if (a > 100) { LkGone.sm(); } return s + 1; }
}
