// A native Parcelable's CREATOR. Kept apart from Parcel so a module that owns a Parcelable
// (graphics, location) can reach it without importing the Parcel module's wider graph.
import { JObj, rt } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import type { JParcel } from "./parcel";

class JCreator extends JObj { type = ""; read!: (parcel: JParcel) => unknown; }
rt.register({ name: "webdroid/ParcelableCreator", ctor: JCreator, ifaces: ["android/os/Parcelable$Creator"], methods: {
  "createFromParcel(Landroid/os/Parcel;)Ljava/lang/Object;": function (this: JCreator, parcel: JParcel) { return this.read(parcel); },
  "newArray(I)[Ljava/lang/Object;": function (this: JCreator, size: number) { return jarray(Array(size).fill(null), "L" + this.type + ";"); },
} });
const creators = new Map<string, JCreator>();
export function parcelCreator(type: string, read: JCreator["read"]): JCreator {
  let creator = creators.get(type);
  if (!creator) {
    rt.link("webdroid/ParcelableCreator"); creator = new JCreator(); creator.type = type; creator.read = read; creators.set(type, creator);
  }
  return creator;
}
