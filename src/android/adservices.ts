import { JObj, rt } from "../jvm/runtime";

rt.register({
  name: "android/adservices/measurement/MeasurementManager", ctor: class extends JObj {},
  statics: { MEASUREMENT_API_STATE_DISABLED: 0, MEASUREMENT_API_STATE_ENABLED: 1 },
  methods: {
    "registerTrigger(Landroid/net/Uri;Ljava/util/concurrent/Executor;Landroid/os/OutcomeReceiver;)V": function () {
      throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Measurement APIs are unavailable");
    },
  },
});
