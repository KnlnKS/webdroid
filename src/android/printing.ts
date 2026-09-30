import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { after, newObj, vcall } from "../jvm/natives/jlang";
import type { JWebView } from "./webkit";

class JPrintDocumentAdapter extends JObj {
  webView: JWebView | null = null;
  name = "";
}
rt.register({ name: "android/print/PrintDocumentAdapter", ctor: JPrintDocumentAdapter, methods: {
  "<init>()V": function () {},
  "onStart()V": function () {},
  "onFinish()V": function () {},
} });

export function webPrintAdapter(view: JWebView, name: string): JPrintDocumentAdapter {
  const adapter = rt.make("android/print/PrintDocumentAdapter") as JPrintDocumentAdapter;
  adapter.webView = view;
  adapter.name = name;
  return adapter;
}

class JPrintJob extends JObj { info: JObj | null = null; }
const inState = (job: JPrintJob, state: number) => after(vcall(job.info, "getState", "()I"), (s: number) => +(s === state));
rt.register({ name: "android/print/PrintJob", ctor: JPrintJob, methods: {
  "getInfo()Landroid/print/PrintJobInfo;": function (this: JPrintJob) { return this.info; },
  "isCompleted()Z": function (this: JPrintJob) { return inState(this, 5); },
  "isCancelled()Z": function (this: JPrintJob) { return inState(this, 7); },
  "isFailed()Z": function (this: JPrintJob) { return inState(this, 6); },
} });

rt.register({ name: "android/print/PrintManager", ctor: class extends JObj {}, methods: {
  "print(Ljava/lang/String;Landroid/print/PrintDocumentAdapter;Landroid/print/PrintAttributes;)Landroid/print/PrintJob;":
    driven(function* (name: string | null, adapter: JPrintDocumentAdapter | null): Gen {
      if (!name || !adapter) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Print job name and adapter are required");
      if (!adapter.webView) throw rt.unimplemented("PrintDocumentAdapter.onLayout/onWrite");
      if (!adapter.webView.requestPrint()) return null;
      const info = yield newObj("android/print/PrintJobInfo");
      yield vcall(info, "setLabel", "(Ljava/lang/String;)V", name);
      yield vcall(info, "setState", "(I)V", 1);
      const job = rt.make("android/print/PrintJob") as JPrintJob;
      job.info = info;
      return job;
    }),
} });
