import { JObj, rt } from "../jvm/runtime";
import { appHost } from "./apphost";
import { FLAG_IS_GAME, getAppInfo } from "./pm";
import { type JParcel, parcelCreator, readInt, writeInt } from "./parcel";

class JGameState extends JObj {
  loading = 0;
  mode = 0;
  label = -1;
  quality = -1;
}
rt.register({ name: "android/app/GameState", ctor: JGameState, ifaces: ["android/os/Parcelable"],
  statics: {
    MODE_UNKNOWN: 0, MODE_NONE: 1, MODE_GAMEPLAY_INTERRUPTIBLE: 2, MODE_GAMEPLAY_UNINTERRUPTIBLE: 3, MODE_CONTENT: 4,
    get CREATOR() { return parcelCreator("android/app/GameState", async (p) => {
      const state = new JGameState();
      state.loading = readInt(p); state.mode = readInt(p); state.label = readInt(p); state.quality = readInt(p);
      return state;
    }); },
  },
  methods: {
    "<init>(ZI)V": function (this: JGameState, loading: number, mode: number) { this.loading = loading; this.mode = mode; },
    "<init>(ZIII)V": function (this: JGameState, loading: number, mode: number, label: number, quality: number) {
      this.loading = loading; this.mode = mode; this.label = label; this.quality = quality;
    },
    "isLoading()Z": function (this: JGameState) { return this.loading; },
    "getMode()I": function (this: JGameState) { return this.mode; },
    "getLabel()I": function (this: JGameState) { return this.label; },
    "getQuality()I": function (this: JGameState) { return this.quality; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": function (this: JGameState, p: JParcel) {
      writeInt(p, this.loading); writeInt(p, this.mode); writeInt(p, this.label); writeInt(p, this.quality);
    },
  },
});

class JGameManager extends JObj {}
rt.register({ name: "android/app/GameManager", ctor: JGameManager, methods: {
  "getGameMode()I": () => {
    const info = appHost ? getAppInfo(appHost) : null;
    return info && (info.category === 0 || info.flags & FLAG_IS_GAME) ? 1 : 0;
  },
  "setGameState(Landroid/app/GameState;)V": (state: JGameState | null) => {
    if (state == null) throw rt.mkThrowable("java/lang/NullPointerException", "gameState");
  },
} });
