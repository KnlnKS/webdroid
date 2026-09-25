import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import type { JBundle } from "./os";

class JMediaDescription extends JObj {
  mediaId: string | null = null;
  title: unknown = null;
  subtitle: unknown = null;
  description: unknown = null;
  iconBitmap: unknown = null;
  iconUri: unknown = null;
  extras: JBundle | null = null;
  mediaUri: unknown = null;
}
class JMediaDescriptionBuilder extends JObj { value = new JMediaDescription(); }
rt.register({ name: "android/media/MediaDescription", ctor: JMediaDescription, ifaces: ["android/os/Parcelable"], methods: {
  "getMediaId()Ljava/lang/String;": function (this: JMediaDescription) { return this.mediaId; },
  "getTitle()Ljava/lang/CharSequence;": function (this: JMediaDescription) { return this.title; },
  "getSubtitle()Ljava/lang/CharSequence;": function (this: JMediaDescription) { return this.subtitle; },
  "getDescription()Ljava/lang/CharSequence;": function (this: JMediaDescription) { return this.description; },
  "getIconBitmap()Landroid/graphics/Bitmap;": function (this: JMediaDescription) { return this.iconBitmap; },
  "getIconUri()Landroid/net/Uri;": function (this: JMediaDescription) { return this.iconUri; },
  "getExtras()Landroid/os/Bundle;": function (this: JMediaDescription) { return this.extras; },
  "getMediaUri()Landroid/net/Uri;": function (this: JMediaDescription) { return this.mediaUri; },
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JMediaDescription, parcel: unknown, flags: number) {
    await vcall(parcel, "writeString", "(Ljava/lang/String;)V", this.mediaId);
    for (const text of [this.title, this.subtitle, this.description])
      await vcall(parcel, "writeCharSequence", "(Ljava/lang/CharSequence;)V", text);
    await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", this.iconBitmap, flags);
    await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", this.iconUri, flags);
    await vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", this.extras);
    await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", this.mediaUri, flags);
  },
} });
rt.register({ name: "android/media/MediaDescription$Builder", ctor: JMediaDescriptionBuilder, methods: {
  "<init>()V": () => {},
  "setMediaId(Ljava/lang/String;)Landroid/media/MediaDescription$Builder;": function (this: JMediaDescriptionBuilder, value: string | null) { this.value.mediaId = value; return this; },
  "setTitle(Ljava/lang/CharSequence;)Landroid/media/MediaDescription$Builder;": function (this: JMediaDescriptionBuilder, value: unknown) { this.value.title = value; return this; },
  "setSubtitle(Ljava/lang/CharSequence;)Landroid/media/MediaDescription$Builder;": function (this: JMediaDescriptionBuilder, value: unknown) { this.value.subtitle = value; return this; },
  "setDescription(Ljava/lang/CharSequence;)Landroid/media/MediaDescription$Builder;": function (this: JMediaDescriptionBuilder, value: unknown) { this.value.description = value; return this; },
  "setIconBitmap(Landroid/graphics/Bitmap;)Landroid/media/MediaDescription$Builder;": function (this: JMediaDescriptionBuilder, value: unknown) { this.value.iconBitmap = value; return this; },
  "setIconUri(Landroid/net/Uri;)Landroid/media/MediaDescription$Builder;": function (this: JMediaDescriptionBuilder, value: unknown) { this.value.iconUri = value; return this; },
  "setExtras(Landroid/os/Bundle;)Landroid/media/MediaDescription$Builder;": function (this: JMediaDescriptionBuilder, value: JBundle | null) { this.value.extras = value; return this; },
  "setMediaUri(Landroid/net/Uri;)Landroid/media/MediaDescription$Builder;": function (this: JMediaDescriptionBuilder, value: unknown) { this.value.mediaUri = value; return this; },
  "build()Landroid/media/MediaDescription;": function (this: JMediaDescriptionBuilder) { return Object.assign(new JMediaDescription(), this.value); },
} });
