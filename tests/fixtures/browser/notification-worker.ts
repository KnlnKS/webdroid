// Actual application Worker entry plus a framework-only diagnostic command. APK code is unchanged.
import "../../../src/process-worker.ts";
import { rt, awaited, type Gen } from "../../../src/jvm/runtime.ts";
import { onMain } from "../../../src/android/mainloop.ts";
import { newObj, vcall } from "../../../src/jvm/natives/jentry.ts";
import { startForegroundNotification, stopForegroundNotification } from "../../../src/android/notification.ts";
import { PROCESS_PID, PROCESS_UID } from "../../../src/android/os.ts";
import { serviceContext, hostedService, exportBinder } from "../../../src/android/binder.ts";

const channelId = "webdroid-worker-contract", B = "Landroid/app/Notification$Builder;", N = "Landroid/app/Notification;";
const bootstrap = globalThis.onmessage;
globalThis.onmessage = event => {
  const request = (event as MessageEvent<{kind:string;action:string}>).data;
  if (request.kind !== "probeNotification") { bootstrap?.call(globalThis as unknown as Window,event); return; }
  void onMain(() => rt.drive(function* (): Gen<unknown> {
    const app = yield* awaited(serviceContext()), manager = yield vcall(app,"getSystemService","(Ljava/lang/String;)Ljava/lang/Object;","notification");
    const binder = yield* awaited(hostedService("notification")), handle = yield* awaited(exportBinder(binder));
    if (request.action === "create") {
      const channel = yield newObj("android/app/NotificationChannel","(Ljava/lang/String;Ljava/lang/CharSequence;I)V",channelId,"Worker contract",3);
      yield vcall(manager,"createNotificationChannel","(Landroid/app/NotificationChannel;)V",channel);
      const read = yield vcall(manager,"getNotificationChannel","(Ljava/lang/String;)Landroid/app/NotificationChannel;",channelId);
      return {pid:PROCESS_PID,uid:PROCESS_UID,handle,importance:yield vcall(read,"getImportance","()I")};
    }
    if (request.action === "post" || request.action === "foreground") {
      let builder = yield newObj("android/app/Notification$Builder","(Landroid/content/Context;Ljava/lang/String;)V",app,channelId);
      builder = yield vcall(builder,"setSmallIcon",`(I)${B}`,0x0108009b);
      builder = yield vcall(builder,"setContentTitle",`(Ljava/lang/CharSequence;)${B}`,"Worker contract");
      const notification = yield vcall(builder,"build",`()${N}`);
      if (request.action === "post") yield vcall(manager,"notify",`(I${N})V`,91,notification);
      else yield startForegroundNotification(92,notification);
    } else if (request.action === "stop") yield stopForegroundNotification(92,true);
    else if (request.action === "cancel") yield vcall(manager,"cancel","(I)V",91);
    const active:unknown[] = yield vcall(manager,"getActiveNotifications","()[Landroid/service/notification/StatusBarNotification;");
    return {pid:PROCESS_PID,handle,active:active.length};
  }())).then(value=>globalThis.postMessage({kind:"notificationReply",value}),error=>{
    globalThis.postMessage({kind:"notificationReply",error:{message:error.msg??error.message,stack:error.stack}});
  });
};
