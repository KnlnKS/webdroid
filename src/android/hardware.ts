// android.hardware: Sensor value classes and the listener interface apps implement.
// SensorManager itself is a Context system service and lives with the others in app.ts.

import { rt, JObj } from "../jvm/runtime";

rt.register({ name: "android/hardware/SensorEventListener", ctor: class extends JObj {} });

class JSensor extends JObj { type = 0; sname = ""; vendor = ""; maxRange = 0; resolution = 0; minDelay = 0; }
rt.register({
  name: "android/hardware/Sensor", ctor: JSensor,
  statics: {
    TYPE_ACCELEROMETER: 1, TYPE_MAGNETIC_FIELD: 2, TYPE_ORIENTATION: 3, TYPE_GYROSCOPE: 4, TYPE_LIGHT: 5,
    TYPE_PRESSURE: 6, TYPE_PROXIMITY: 8, TYPE_GRAVITY: 9, TYPE_LINEAR_ACCELERATION: 10, TYPE_ROTATION_VECTOR: 11, TYPE_ALL: -1,
  },
  methods: {
    "getType()I": function (this: JSensor) { return this.type; },
    "getName()Ljava/lang/String;": function (this: JSensor) { return this.sname; },
    "getVendor()Ljava/lang/String;": function (this: JSensor) { return this.vendor; },
    "getMaximumRange()F": function (this: JSensor) { return this.maxRange; },
    "getResolution()F": function (this: JSensor) { return this.resolution; },
    "getMinDelay()I": function (this: JSensor) { return this.minDelay; },
  },
});

class JSensorEvent extends JObj { values = new Float32Array(3); accuracy = 0; timestamp = 0n; sensor: JSensor | null = null; }
rt.register({
  name: "android/hardware/SensorEvent", ctor: JSensorEvent,
  fields: { values: "values", accuracy: "accuracy", timestamp: "timestamp", sensor: "sensor" },
});
