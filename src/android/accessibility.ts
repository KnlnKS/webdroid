// android.view.accessibility: the node and action types views and their delegates hand around.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { currentResources } from "./res";
import { csText } from "../jvm/natives/jchars";

class JA11yAction extends JObj { actionId = 0; label: string | null = null; }
rt.register({ name: "android/view/accessibility/AccessibilityNodeInfo", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable"] });
rt.markers("android/view/accessibility/AccessibilityRecord");
// The standard actions: the original ones are bits, later ones are android.R.id.accessibilityAction*
// resources (read on first use, once the framework package is loaded).
const a11yAction = (actionId: number) => Object.assign(new JA11yAction(), { actionId });
const a11yActions: Record<string, unknown> = Object.fromEntries(("FOCUS CLEAR_FOCUS SELECT CLEAR_SELECTION CLICK LONG_CLICK ACCESSIBILITY_FOCUS " +
  "CLEAR_ACCESSIBILITY_FOCUS NEXT_AT_MOVEMENT_GRANULARITY PREVIOUS_AT_MOVEMENT_GRANULARITY NEXT_HTML_ELEMENT PREVIOUS_HTML_ELEMENT SCROLL_FORWARD " +
  "SCROLL_BACKWARD COPY PASTE CUT SET_SELECTION EXPAND COLLAPSE DISMISS SET_TEXT").split(" ").map((name, bit) => ["ACTION_" + name, a11yAction(1 << bit)]));
for (const name of ("SHOW_ON_SCREEN SCROLL_TO_POSITION SCROLL_UP SCROLL_LEFT SCROLL_DOWN SCROLL_RIGHT CONTEXT_CLICK SET_PROGRESS MOVE_WINDOW " +
  "SHOW_TOOLTIP HIDE_TOOLTIP PAGE_UP PAGE_DOWN PAGE_LEFT PAGE_RIGHT PRESS_AND_HOLD IME_ENTER DRAG_START DRAG_DROP DRAG_CANCEL " +
  "SHOW_TEXT_SUGGESTIONS SCROLL_IN_DIRECTION").split(" ")) {
  const resName = "accessibilityAction" + name.toLowerCase().replace(/(^|_)(\w)/g, (_, _sep: string, c: string) => c.toUpperCase());
  Object.defineProperty(a11yActions, "ACTION_" + name, { enumerable: true, get: () => a11yAction(currentResources()?.idFor("id", resName, "android") ?? 0) });
}
rt.register({
  name: "android/view/accessibility/AccessibilityNodeInfo$AccessibilityAction", ctor: JA11yAction, statics: a11yActions,
  methods: {
    "<init>(ILjava/lang/CharSequence;)V": driven(function* (this: JA11yAction, id: number, label: unknown): Gen {
      this.actionId = id;
      this.label = label === null ? null : yield csText(label);
    }),
    "getId()I": function (this: JA11yAction) { return this.actionId; },
    "getLabel()Ljava/lang/CharSequence;": function (this: JA11yAction) { return this.label; },
  },
});
