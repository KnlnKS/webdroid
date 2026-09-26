import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { newObj, stringHash, vcall } from "../jvm/natives/jlang";
import { newArrayList, type JList } from "../jvm/natives/jutil";
import { parcelCreator, type JParcel } from "./parcel";

class JWorkChain extends JObj {
  uids: number[] = [];
  tags: (string | null)[] = [];
  copy() { const result = new JWorkChain(); result.uids = this.uids.slice(); result.tags = this.tags.slice(); return result; }
  equals(other: JWorkChain) { return this.uids.length === other.uids.length && this.uids.every((uid, i) => uid === other.uids[i] && this.tags[i] === other.tags[i]); }
}
function workChain(value: unknown): JWorkChain {
  if (!(value instanceof JWorkChain)) throw rt.mkThrowable("java/lang/ClassCastException", "expected WorkChain");
  return value;
}
class JWorkSource extends JObj {
  uids: number[] = [];
  names: string[] | null = null;
  chains: JList | null = null;
  copy(other: JWorkSource | null) {
    this.uids = other?.uids.slice() ?? []; this.names = other?.names?.slice() ?? null;
    this.chains = other?.chains ? newArrayList(other.chains.a.map(chain => workChain(chain).copy())) : null;
  }
  add(uid: number, name: string | null) {
    if (this.uids.length && (this.names === null) !== (name === null))
      throw rt.mkThrowable("java/lang/IllegalArgumentException", "cannot mix named and unnamed work sources");
    let i = 0;
    while (i < this.uids.length && (this.uids[i] < uid || this.uids[i] === uid && name !== null && this.names![i] < name)) i++;
    if (this.uids[i] === uid && (name === null || this.names![i] === name)) return 0;
    this.uids.splice(i, 0, uid);
    if (name !== null) (this.names ??= []).splice(i, 0, name); else this.names = null;
    return 1;
  }
  diff(other: JWorkSource) {
    return this.uids.length !== other.uids.length || this.uids.some((uid, i) => uid !== other.uids[i]
      || this.names !== null && other.names !== null && this.names[i] !== other.names[i]);
  }
}
rt.register({ name: "android/os/WorkSource$WorkChain", ctor: JWorkChain, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/os/WorkSource$WorkChain", async p => {
    const chain = new JWorkChain(), size: number = await vcall(p, "readInt", "()I");
    const uids: Int32Array = await vcall(p, "createIntArray", "()[I");
    const tags: (string | null)[] = await vcall(p, "createStringArray", "()[Ljava/lang/String;");
    chain.uids = Array.from(uids.subarray(0, size)); chain.tags = tags.slice(0, size); return chain;
  }); } }, methods: {
    "<init>()V": function () {},
    "addNode(ILjava/lang/String;)Landroid/os/WorkSource$WorkChain;": function (this: JWorkChain, uid: number, tag: string | null) { this.uids.push(uid); this.tags.push(tag); return this; },
    "getAttributionUid()I": function (this: JWorkChain) { return this.uids[0] ?? -1; },
    "getAttributionTag()Ljava/lang/String;": function (this: JWorkChain) { return this.tags[0] ?? null; },
    "hashCode()I": function (this: JWorkChain) {
      let uids = 1, tags = 1;
      for (let i = 0; i < this.uids.length; i++) { uids = Math.imul(uids, 31) + this.uids[i] | 0; tags = Math.imul(tags, 31) + (this.tags[i] === null ? 0 : stringHash(this.tags[i]!)) | 0; }
      return Math.imul(this.uids.length + Math.imul(uids, 31), 31) + tags | 0;
    },
    "getSize()I": function (this: JWorkChain) { return this.uids.length; },
    "getUids()[I": function (this: JWorkChain) { return Int32Array.from(this.uids); },
    "getTags()[Ljava/lang/String;": function (this: JWorkChain) { return jarray(this.tags.slice(), "Ljava/lang/String;"); },
    "equals(Ljava/lang/Object;)Z": function (this: JWorkChain, other: unknown) { return +(other instanceof JWorkChain && this.equals(other)); },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JWorkChain, p: JParcel): Gen {
      (yield vcall(p, "writeInt", "(I)V", this.uids.length));
      (yield vcall(p, "writeIntArray", "([I)V", Int32Array.from(this.uids)));
      (yield vcall(p, "writeStringArray", "([Ljava/lang/String;)V", this.tags));
    }),
  },
});
rt.register({ name: "android/os/WorkSource", ctor: JWorkSource, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/os/WorkSource", async p => {
    const source = new JWorkSource(), size: number = await vcall(p, "readInt", "()I");
    const uids: Int32Array | null = await vcall(p, "createIntArray", "()[I");
    const names: string[] | null = await vcall(p, "createStringArray", "()[Ljava/lang/String;");
    source.uids = uids ? Array.from(uids.subarray(0, size)) : []; source.names = names?.slice(0, size) ?? null;
    const chains: number = await vcall(p, "readInt", "()I");
    if (chains > 0) {
      source.chains = newArrayList();
      const count: number = await vcall(p, "readInt", "()I");
      for (let i = 0; i < count; i++) source.chains.a.push(await vcall(p, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null));
    }
    return source;
  }); } }, methods: {
    "<init>()V": function () {},
    "<init>(Landroid/os/WorkSource;)V": function (this: JWorkSource, other: JWorkSource | null) { this.copy(other); },
    "<init>(I)V": function (this: JWorkSource, uid: number) { this.add(uid, null); },
    "<init>(ILjava/lang/String;)V": function (this: JWorkSource, uid: number, name: string) { if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", "name"); this.add(uid, name); },
    "size()I": function (this: JWorkSource) { return this.uids.length; },
    "isEmpty()Z": function (this: JWorkSource) { return +(!this.uids.length && !this.chains?.a.length); },
    "get(I)I": function (this: JWorkSource, i: number) { return this.uids[i] ?? 0; },
    "getUid(I)I": function (this: JWorkSource, i: number) { return this.uids[i] ?? 0; },
    "getName(I)Ljava/lang/String;": function (this: JWorkSource, i: number) { return this.names?.[i] ?? null; },
    "getPackageName(I)Ljava/lang/String;": function (this: JWorkSource, i: number) { return this.names?.[i] ?? null; },
    "getAttributionUid()I": function (this: JWorkSource) { return this.uids[0] ?? (this.chains?.a.length ? workChain(this.chains.a[0]).uids[0] : undefined) ?? -1; },
    "clear()V": function (this: JWorkSource) { this.uids = []; if (this.names) this.names = []; if (this.chains) this.chains.a.length = 0; },
    "set(Landroid/os/WorkSource;)V": function (this: JWorkSource, other: JWorkSource | null) { this.copy(other); },
    "add(I)Z": function (this: JWorkSource, uid: number) { return this.add(uid, null); },
    "add(ILjava/lang/String;)Z": function (this: JWorkSource, uid: number, name: string) { if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", "name"); return this.add(uid, name); },
    "add(Landroid/os/WorkSource;)Z": function (this: JWorkSource, other: JWorkSource) {
      let changed = 0;
      for (let i = 0; i < other.uids.length; i++) changed |= this.add(other.uids[i], other.names?.[i] ?? null);
      for (const chain of other.chains?.a ?? []) {
        const chains = this.chains ??= newArrayList();
        if (!chains.a.some(existing => workChain(existing).equals(workChain(chain)))) { chains.a.push(workChain(chain).copy()); changed = 1; }
      }
      return changed;
    },
    "remove(Landroid/os/WorkSource;)Z": function (this: JWorkSource, other: JWorkSource) {
      if ((this.names === null) !== (other.names === null) && this.uids.length && other.uids.length)
        throw rt.mkThrowable("java/lang/IllegalArgumentException", "cannot mix named and unnamed work sources");
      let changed = 0;
      for (let i = this.uids.length - 1; i >= 0; i--) if (other.uids.some((uid, j) => uid === this.uids[i] && this.names?.[i] === other.names?.[j])) {
        this.uids.splice(i, 1); this.names?.splice(i, 1); changed = 1;
      }
      if (this.chains) for (let i = this.chains.a.length - 1; i >= 0; i--)
        if (other.chains?.a.some(chain => workChain(chain).equals(workChain(this.chains!.a[i])))) { this.chains.a.splice(i, 1); changed = 1; }
      return changed;
    },
    "createWorkChain()Landroid/os/WorkSource$WorkChain;": driven(function* (this: JWorkSource): Gen {
      const chain = (yield newObj("android/os/WorkSource$WorkChain")); (this.chains ??= newArrayList()).a.push(chain); return chain;
    }),
    "getWorkChains()Ljava/util/List;": function (this: JWorkSource) { return this.chains; },
    "diff(Landroid/os/WorkSource;)Z": function (this: JWorkSource, other: JWorkSource) { return +this.diff(other); },
    "equals(Ljava/lang/Object;)Z": function (this: JWorkSource, other: unknown) {
      return +(other instanceof JWorkSource && !this.diff(other) && (this.chains?.a.length ?? 0) === (other.chains?.a.length ?? 0)
        && (this.chains?.a.every((chain, i) => workChain(chain).equals(workChain(other.chains!.a[i]))) ?? true));
    },
    "hashCode()I": driven(function* (this: JWorkSource): Gen {
      let hash = 0;
      for (const uid of this.uids) hash = (hash << 4 | hash >>> 28) ^ uid;
      for (const name of this.names ?? []) hash = (hash << 4 | hash >>> 28) ^ stringHash(name);
      if (this.chains) hash = (hash << 4 | hash >>> 28) ^ (yield vcall(this.chains, "hashCode", "()I"));
      return hash;
    }),
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JWorkSource, p: JParcel, flags: number): Gen {
      (yield vcall(p, "writeInt", "(I)V", this.uids.length));
      (yield vcall(p, "writeIntArray", "([I)V", this.uids.length ? Int32Array.from(this.uids) : null));
      (yield vcall(p, "writeStringArray", "([Ljava/lang/String;)V", this.names));
      (yield vcall(p, "writeInt", "(I)V", this.chains?.a.length ?? -1));
      if (this.chains) {
        (yield vcall(p, "writeInt", "(I)V", this.chains.a.length));
        for (const chain of this.chains.a) (yield vcall(p, "writeParcelable", "(Landroid/os/Parcelable;I)V", chain, flags));
      }
    }),
  },
});
