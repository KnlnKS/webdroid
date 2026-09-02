// Two small declarations apps reference but nothing produced yet: the <uses-feature>
// record PackageInfo.reqFeatures is made of, and the XML namespace resolver interface.

import { rt, JObj } from "../jvm/runtime";

class JFeatureInfo extends JObj {
  name: string | null = null;   // null on the glEsVersion entry, as AOSP leaves it
  version = 0;
  reqGlEsVersion = 0;           // GL_ES_VERSION_UNDEFINED
  flags = 0;
}
rt.register({
  name: "android/content/pm/FeatureInfo", ctor: JFeatureInfo, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_REQUIRED: 1, GL_ES_VERSION_UNDEFINED: 0 },
  fields: { name: "name", version: "version", reqGlEsVersion: "reqGlEsVersion", flags: "flags" },
  methods: {
    "<init>()V": function () {},
    "getGlEsVersion()Ljava/lang/String;": function (this: JFeatureInfo) {
      return (this.reqGlEsVersion >> 16) + "." + (this.reqGlEsVersion & 0xffff);
    },
    "toString()Ljava/lang/String;": function (this: JFeatureInfo) {
      return this.name ? "FeatureInfo{" + this.name + "}" : "FeatureInfo{glEsVers=" + (this.reqGlEsVersion >> 16) + "}";
    },
  },
});

// Implemented by app/library code, never handed out by us — it only has to exist so a
// class declaring `implements NamespaceContext` links instead of being auto-stubbed.
rt.register({ name: "javax/xml/namespace/NamespaceContext", ctor: class extends JObj {} });
