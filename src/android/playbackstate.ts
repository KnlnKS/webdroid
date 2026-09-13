import { JObj, rt, fieldGetters } from "../jvm/runtime";
import { type JBundle } from "./os";

class JPlaybackState extends JObj {
  state = 0; position = 0n; speed = 0; updated = 0n; buffered = 0n; actions = 0n;
  error: unknown = null; activeId = -1n; extras: JBundle | null = null;
  custom: unknown[] = [];
}
class JPlaybackBuilder extends JObj { value = new JPlaybackState(); }
function copy(state: JPlaybackState) { const result = Object.assign(new JPlaybackState(), state); result.custom = state.custom.slice(); return result; }
rt.register({ name: "android/media/session/PlaybackState", ctor: JPlaybackState, ifaces: ["android/os/Parcelable"], methods: {
  ...fieldGetters({ "getState()I": "state", "getPosition()J": "position", "getPlaybackSpeed()F": "speed", "getLastPositionUpdateTime()J": "updated",
    "getBufferedPosition()J": "buffered", "getActions()J": "actions", "getErrorMessage()Ljava/lang/CharSequence;": "error", "getActiveQueueItemId()J": "activeId", "getExtras()Landroid/os/Bundle;": "extras" }),
  "describeContents()I": () => 0,
} });
rt.register({ name: "android/media/session/PlaybackState$Builder", ctor: JPlaybackBuilder, methods: {
  "<init>()V": () => {},
  "<init>(Landroid/media/session/PlaybackState;)V": function (this: JPlaybackBuilder, state: JPlaybackState | null) {
    if (!state) throw rt.mkThrowable("java/lang/IllegalArgumentException", "state must not be null");
    this.value = copy(state);
  },
  "setState(IJFJ)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackBuilder, state: number, position: bigint, speed: number, updated: bigint) {
    Object.assign(this.value, { state, position, speed, updated }); return this;
  },
  "setBufferedPosition(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackBuilder, value: bigint) { this.value.buffered = value; return this; },
  "setActions(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackBuilder, value: bigint) { this.value.actions = value; return this; },
  "setErrorMessage(Ljava/lang/CharSequence;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackBuilder, value: unknown) { this.value.error = value; return this; },
  "setActiveQueueItemId(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackBuilder, value: bigint) { this.value.activeId = value; return this; },
  "setExtras(Landroid/os/Bundle;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackBuilder, value: JBundle | null) { this.value.extras = value; return this; },
  "addCustomAction(Landroid/media/session/PlaybackState$CustomAction;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackBuilder, value: unknown) {
    if (!value) throw rt.mkThrowable("java/lang/IllegalArgumentException", "custom action must not be null");
    this.value.custom.push(value); return this;
  },
  "build()Landroid/media/session/PlaybackState;": function (this: JPlaybackBuilder) { rt.link("android/media/session/PlaybackState"); return copy(this.value); },
} });
