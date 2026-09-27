import { JObj, rt } from "../jvm/runtime";
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

class JPrintAttributes extends JObj {
  mediaSize: unknown = null;
  margins: unknown = null;
}
class JPrintAttributesBuilder extends JObj {
  attributes = new JPrintAttributes();
}
rt.register({ name: "android/print/PrintAttributes", ctor: JPrintAttributes, methods: {
  "<init>()V": function () {},
  "getMediaSize()Landroid/print/PrintAttributes$MediaSize;": function (this: JPrintAttributes) { return this.mediaSize; },
  "getMinMargins()Landroid/print/PrintAttributes$Margins;": function (this: JPrintAttributes) { return this.margins; },
} });
rt.register({ name: "android/print/PrintAttributes$Builder", ctor: JPrintAttributesBuilder, methods: {
  "<init>()V": function () {},
  "setMediaSize(Landroid/print/PrintAttributes$MediaSize;)Landroid/print/PrintAttributes$Builder;": function (this: JPrintAttributesBuilder, size: unknown) { this.attributes.mediaSize = size; return this; },
  "setMinMargins(Landroid/print/PrintAttributes$Margins;)Landroid/print/PrintAttributes$Builder;": function (this: JPrintAttributesBuilder, margins: unknown) { this.attributes.margins = margins; return this; },
  "build()Landroid/print/PrintAttributes;": function (this: JPrintAttributesBuilder) { return this.attributes; },
} });
class JPrintMediaSize extends JObj { id = ""; label = ""; width = 0; height = 0; }
rt.register({ name: "android/print/PrintAttributes$MediaSize", ctor: JPrintMediaSize, methods: {
  "<init>(Ljava/lang/String;Ljava/lang/String;II)V": function (this: JPrintMediaSize, id: string, label: string, width: number, height: number) {
    this.id = id; this.label = label; this.width = width; this.height = height;
  },
} });
class JPrintMargins extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
rt.register({ name: "android/print/PrintAttributes$Margins", ctor: JPrintMargins, methods: {
  "<init>(IIII)V": function (this: JPrintMargins, left: number, top: number, right: number, bottom: number) {
    this.left = left; this.top = top; this.right = right; this.bottom = bottom;
  },
} });

class JPrintJobInfo extends JObj { label = ""; state = 1; }
rt.register({ name: "android/print/PrintJobInfo", ctor: JPrintJobInfo,
  fields: ["label", "state"], methods: { "getLabel()Ljava/lang/String;": function (this: JPrintJobInfo) { return this.label; },
    "getState()I": function (this: JPrintJobInfo) { return this.state; } } });
class JPrintJob extends JObj { info = new JPrintJobInfo(); }
rt.register({ name: "android/print/PrintJob", ctor: JPrintJob, methods: {
  "getInfo()Landroid/print/PrintJobInfo;": function (this: JPrintJob) { return this.info; },
  "isCompleted()Z": function (this: JPrintJob) { return +(this.info.state === 5); },
  "isCancelled()Z": function (this: JPrintJob) { return +(this.info.state === 7); },
  "isFailed()Z": function (this: JPrintJob) { return +(this.info.state === 6); },
} });

rt.register({ name: "android/print/PrintManager", ctor: class extends JObj {}, methods: {
  "print(Ljava/lang/String;Landroid/print/PrintDocumentAdapter;Landroid/print/PrintAttributes;)Landroid/print/PrintJob;":
    function (name: string | null, adapter: JPrintDocumentAdapter | null) {
      if (!name || !adapter) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Print job name and adapter are required");
      if (!adapter.webView) throw rt.unimplemented("PrintDocumentAdapter.onLayout/onWrite");
      if (!adapter.webView.requestPrint()) return null;
      const job = rt.make("android/print/PrintJob") as JPrintJob;
      job.info.label = name;
      return job;
    },
} });
