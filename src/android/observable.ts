// android.database observers: Observable and its DataSetObservable/ContentObservable, and the
// ContentObserver callbacks they notify (DataSetObserver is AOSP's).

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { newArrayList, toJsArray } from "../jvm/natives/jutil";
import type { JHandler, JFnRunnable } from "./os";

// Observable / DataSetObservable. `mObservers` is the protected ArrayList subclasses walk
// directly (RecyclerView's AdapterDataObservable does), so it is a real java.util.ArrayList.
class JObservable extends JObj {
  list = newArrayList();
  get observers(): unknown[] { return this.list.a; }
}
rt.register({
  name: "android/database/Observable", ctor: JObservable,
  fields: { mObservers: "list" },
  methods: {
    "<init>()V": function () {},
    "registerObserver(Ljava/lang/Object;)V": function (this: JObservable, o: unknown) {
      if (o == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "The observer is null.");
      if (this.observers.includes(o)) throw rt.mkThrowable("java/lang/IllegalStateException", "Observer " + o + " is already registered.");
      this.observers.push(o);
    },
    "unregisterObserver(Ljava/lang/Object;)V": function (this: JObservable, o: unknown) {
      if (o == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "The observer is null.");
      const i = this.observers.indexOf(o);
      if (i < 0) throw rt.mkThrowable("java/lang/IllegalStateException", "Observer " + o + " was not registered.");
      this.observers.splice(i, 1);
    },
    "unregisterAll()V": function (this: JObservable) { this.observers.length = 0; },
  },
});
const notifyObservers = driven(function* (observable: JObservable, name: string, desc: string, ...args: unknown[]): Gen {
  for (const o of [...observable.observers]) yield vcall(o, name, desc, ...args);
});
rt.register({
  name: "android/database/DataSetObservable", ctor: class extends JObservable {}, sup: "android/database/Observable",
  methods: {
    "<init>()V": function () {},
    "notifyChanged()V": function (this: JObservable) { return notifyObservers(this, "onChanged", "()V"); },
    "notifyInvalidated()V": function (this: JObservable) { return notifyObservers(this, "onInvalidated", "()V"); },
  },
});
rt.register({
  name: "android/database/ContentObservable", ctor: class extends JObservable {}, sup: "android/database/Observable",
  methods: {
    "<init>()V": function () {},
    "registerObserver(Landroid/database/ContentObserver;)V": function (this: JObservable, o: unknown) {
      return vcall(this, "registerObserver", "(Ljava/lang/Object;)V", o);
    },
    "dispatchChange(Z)V": function (this: JObservable, self: number) {
      return vcall(this, "dispatchChange", "(ZLandroid/net/Uri;)V", self, null);
    },
    "dispatchChange(ZLandroid/net/Uri;)V": driven(function* (this: JObservable, self: number, uri: unknown): Gen {
      for (const o of [...this.observers]) {
        if (!self || (yield vcall(o, "deliverSelfNotifications", "()Z"))) yield vcall(o, "dispatchChange", "(ZLandroid/net/Uri;)V", self, uri);
      }
    }),
    "notifyChange(Z)V": function (this: JObservable, self: number) { return notifyObservers(this, "onChange", "(ZLandroid/net/Uri;)V", self, null); },
  },
});
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
      const uris = newArrayList(); uris.a.push(uri);
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
