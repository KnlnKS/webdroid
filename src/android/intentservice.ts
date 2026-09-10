import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { mkExecutor } from "../jvm/natives/jconc";
import { JService } from "./runningservices";
import type { JIntent } from "./intent";

class JIntentService extends JService { executor: unknown = null; redeliver = false; }
class JIntentTask extends JObj { service!: JIntentService; intent: JIntent | null = null; startId = 0; }
rt.register({ name: "webdroid/IntentServiceTask", ctor: JIntentTask, ifaces: ["java/lang/Runnable"], methods: {
  "run()V": async function (this: JIntentTask) {
    await vcall(this.service, "onHandleIntent", "(Landroid/content/Intent;)V", this.intent);
    await vcall(this.service, "stopSelf", "(I)V", this.startId);
  },
} });
rt.register({ name: "android/app/IntentService", ctor: JIntentService, sup: "android/app/Service", methods: {
  "<init>(Ljava/lang/String;)V": function () {},
  "onCreate()V": function (this: JIntentService) { this.executor = mkExecutor(); },
  "onStart(Landroid/content/Intent;I)V": async function (this: JIntentService, intent: JIntent | null, startId: number) {
    rt.link("webdroid/IntentServiceTask");
    const task = new JIntentTask(); task.service = this; task.intent = intent; task.startId = startId;
    await vcall(this.executor, "execute", "(Ljava/lang/Runnable;)V", task);
  },
  "onStartCommand(Landroid/content/Intent;II)I": async function (this: JIntentService, intent: JIntent | null, _flags: number, startId: number) {
    await vcall(this, "onStart", "(Landroid/content/Intent;I)V", intent, startId); return this.redeliver ? 3 : 2;
  },
  "setIntentRedelivery(Z)V": function (this: JIntentService, value: number) { this.redeliver = !!value; },
  "onBind(Landroid/content/Intent;)Landroid/os/IBinder;": () => null,
  "onDestroy()V": async function (this: JIntentService) { await vcall(this.executor, "shutdownNow", "()Ljava/util/List;"); },
} });
