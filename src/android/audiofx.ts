import { jarray } from "../jvm/abi.ts";
import { rt } from "../jvm/runtime.ts";

// No audio effect library is loaded: the effects factory lists nothing to query.
rt.claimNativeLib("audioeffect_jni");
rt.registerJnis("android/media/audiofx/AudioEffect", {
  "native_init()V": () => {},
  "native_query_effects()[Ljava/lang/Object;": () => jarray([], "Landroid/media/audiofx/AudioEffect$Descriptor;"),
  "native_query_pre_processing(I)[Ljava/lang/Object;": () => jarray([], "Landroid/media/audiofx/AudioEffect$Descriptor;"),
});
