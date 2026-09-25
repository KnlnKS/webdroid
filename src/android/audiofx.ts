import { jarray } from "../jvm/abi";
import { uuidFromString } from "../jvm/natives/jvalues";
import { JObj, rt } from "../jvm/runtime";

class JEffectDescriptor extends JObj {
  type: unknown = null;
  uuid: unknown = null;
  connectMode = "";
  name = "";
  implementor = "";
}

rt.register({
  name: "android/media/audiofx/AudioEffect$Descriptor", ctor: JEffectDescriptor,
  fields: ["type", "uuid", "connectMode", "name", "implementor"],
});

rt.register({
  name: "android/media/audiofx/AudioEffect", ctor: class extends JObj {},
  clinit: () => {
    const ctor = rt.link("android/media/audiofx/AudioEffect").ctor;
    ctor.s$EFFECT_TYPE_LOUDNESS_ENHANCER = uuidFromString("fe3199be-aed0-413f-87bb-11260eb63cf1");
  },
  methods: {
    "static queryEffects()[Landroid/media/audiofx/AudioEffect$Descriptor;": () =>
      jarray([], "Landroid/media/audiofx/AudioEffect$Descriptor;"),
  },
});
