// android.database.ContentObserver's callbacks (Observable and its subclasses are AOSP's).

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { newArrayList, toJsArray } from "../jvm/natives/jcoll";
import type { JHandler, JFnRunnable } from "./os";

// AOSP's dispatch chain: every dispatchChange overload lands on the Collection one, which runs
// onChange on the observer's Handler (inline without one); each onChange overload falls back
// to the next older one, so an override at any API level sees the change.
class JContentObserver extends JObj { handler: JHandler | null = null; }
const ON_CHANGE_URI = "(ZLandroid/net/Uri;I)V", URIS = "(ZLjava/util/Collection;I)V";
rt.register({
  name: "android/database/ContentObserver", ctor: JContentObserver,
  methods: {
    "<init>(Landroid/os/Handler;)V": function (this: JContentObserver, h: JHandler | null) { this.handler = h; },
    "deliverSelfNotifications()Z": () => 0,
    "onChange(Z)V": () => {},
    "onChange(ZLandroid/net/Uri;)V": function (this: JObj, self: number) { return vcall(this, "onChange", "(Z)V", self); },
    "onChange(ZLandroid/net/Uri;I)V": function (this: JObj, self: number, uri: unknown) { return vcall(this, "onChange", "(ZLandroid/net/Uri;)V", self, uri); },
    "onChange(ZLjava/util/Collection;I)V": driven(function* (this: JObj, self: number, uris: unknown, flags: number): Gen {
      for (const uri of (yield toJsArray(uris)) as unknown[]) yield vcall(this, "onChange", ON_CHANGE_URI, self, uri, flags);
    }),
    "dispatchChange(Z)V": function (this: JObj, self: number) { return vcall(this, "dispatchChange", ON_CHANGE_URI, self, null, 0); },
    "dispatchChange(ZLandroid/net/Uri;)V": function (this: JObj, self: number, uri: unknown) { return vcall(this, "dispatchChange", ON_CHANGE_URI, self, uri, 0); },
    "dispatchChange(ZLandroid/net/Uri;I)V": function (this: JObj, self: number, uri: unknown, flags: number) {
      const uris = newArrayList([uri]);
      return vcall(this, "dispatchChange", URIS, self, uris, flags);
    },
    "dispatchChange(ZLjava/util/Collection;I)V": function (this: JContentObserver, self: number, uris: unknown, flags: number) {
      const change = () => vcall(this, "onChange", URIS, self, uris, flags);
      if (!this.handler) return change();
      const runnable: JFnRunnable = rt.make("webdroid/FnRunnable"); runnable.fn = change;
      this.handler.post(runnable, 0);
    },
  },
});
