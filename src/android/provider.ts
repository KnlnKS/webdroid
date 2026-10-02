// The system activities behind android.provider's and android.content's intents (DocumentsUI's
// pickers, the photo picker, the chooser, sharing and viewing), over the browser's own.

import { rt, JObj, getDeclared } from "../jvm/runtime";
import { newObj, vcall, scall } from "../jvm/natives/jlang";
import { serviceContext } from "./binder";
import { startActivityFor } from "./server/atm";
import { thisApp } from "./server/am";
import { registerSystemActivity, systemActivity, mkResultIntent, newIntent, intentQuery, mkComponentName, type JIntent } from "./intent";
import { csText } from "../jvm/natives/jchars";
import { frameworkString } from "./res";
import { mkUri } from "./net";
import { toJsArray } from "../jvm/natives/jcoll";
import { pickTree, pickDocument, pickDocuments } from "./documents";

const S = "Ljava/lang/String;";
const typeOf = (intent: JIntent): Promise<string | null> => vcall(intent, "getType", `()${S}`);

// The activities DocumentsUI provides on a device, over the browser's own pickers.
registerSystemActivity("android.intent.action.OPEN_DOCUMENT_TREE",
  async () => { const uri = await pickTree(); return uri ? mkResultIntent(uri, 3 | 0x40 | 0x80) : null; });
registerSystemActivity("android.intent.action.PICK", async (intent) => {
  const mime = await typeOf(intent);
  if (!mime || !/^(image|video|audio)\//.test(mime)) throw rt.unimplemented("PICK for " + (mime ?? await vcall(intent, "getDataString", `()${S}`)));
  const uri = await pickDocument({ mime });
  return uri ? mkResultIntent(uri, 1) : null;
});
// MediaStore.ACTION_PICK_IMAGES, the photo picker: one item as the data, or up to
// EXTRA_PICK_IMAGES_MAX as ClipData, readable and persistable
registerSystemActivity("android.provider.action.PICK_IMAGES", async (intent) => {
  const mime = await typeOf(intent), multiple = await vcall(intent, "getIntExtra", `(${S}I)I`, "android.provider.extra.PICK_IMAGES_MAX", 1) > 1;
  if (mime && !/^(image|video)\//.test(mime)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid picker MIME type " + mime);
  const uris = await pickDocuments({ mime, multiple });
  if (!uris.length) return null;
  const result = await mkResultIntent(multiple ? null : uris[0], 1 | 0x40);
  if (multiple) {
    const [first, ...rest] = await Promise.all(uris.map(mkUri));
    const clip = await scall("android/content/ClipData", "newRawUri", "(Ljava/lang/CharSequence;Landroid/net/Uri;)Landroid/content/ClipData;", null, first);
    for (const uri of rest) await vcall(clip, "addItem", "(Landroid/content/ClipData$Item;)V", await newObj("android/content/ClipData$Item", "(Landroid/net/Uri;)V", uri));
    await vcall(result, "setClipData", "(Landroid/content/ClipData;)V", clip);
  }
  return result;
});
for (const action of ["android.intent.action.OPEN_DOCUMENT", "android.intent.action.GET_CONTENT",
  "android.intent.action.CREATE_DOCUMENT"] as const) {
  registerSystemActivity(action, async (intent) => {
    const title: string | null = await vcall(intent, "getStringExtra", `(${S})${S}`, "android.intent.extra.TITLE"), mime = await typeOf(intent);
    const uri = await pickDocument({
      save: action.endsWith("CREATE_DOCUMENT") ? title ?? "file" : undefined,
      mime: mime && mime !== "*/*" ? mime : null,
    });
    return uri ? mkResultIntent(uri, action === "android.intent.action.GET_CONTENT" ? 1 : 3 | 0x40) : null;
  });
}
registerSystemActivity("android.intent.action.VIEW", async (intent) => (await import("../shell/share")).openInBrowser((await vcall(intent, "getDataString", `()${S}`))!), ["http", "https", "market"]);
for (const action of ["android.intent.action.SEND", "android.intent.action.SEND_MULTIPLE"])
  registerSystemActivity(action, async (intent) => (await import("../shell/share")).shareIntent(intent));
registerSystemActivity("android.intent.action.CHOOSER", async (intent) => {
  const target: JIntent | null = await vcall(intent, "getParcelableExtra", `(${S})Landroid/os/Parcelable;`, "android.intent.extra.INTENT");
  if (!target) throw rt.mkThrowable("java/lang/NullPointerException", "Chooser target");
  const q = await intentQuery(target);
  if (q.action === "android.intent.action.SEND" || q.action === "android.intent.action.SEND_MULTIPLE")
    return (await import("../shell/share")).shareIntent(intent);
  const handler = systemActivity(q);
  if (handler) return handler(target);
  // AOSP's chooser lists the activities that handle the target; with none it only says so, and
  // the user dismissing it is RESULT_CANCELED
  const pm = await vcall(await serviceContext(), "getPackageManager", "()Landroid/content/pm/PackageManager;");
  const matches = await toJsArray(await vcall(pm, "queryIntentActivities", "(Landroid/content/Intent;I)Ljava/util/List;", target, 0x10000));
  if (!matches.length) return null;
  const labels = await Promise.all(matches.map(async (m) => csText(await vcall(m, "loadLabel", "(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;", pm))));
  const title = await vcall(intent, "getCharSequenceExtra", `(${S})Ljava/lang/CharSequence;`, "android.intent.extra.TITLE");
  const choice = await (await import("../shell/share")).chooseActivity(title == null ? frameworkString("chooseActivity") ?? "" : await csText(title), labels);
  if (choice === null) return null;
  const chosen: JIntent = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", target);
  const activity = getDeclared<JObj>(matches[choice], "android/content/pm/ResolveInfo", "activityInfo");
  await vcall(chosen, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await mkComponentName(
    getDeclared<string>(activity, "android/content/pm/PackageItemInfo", "packageName"), getDeclared<string>(activity, "android/content/pm/PackageItemInfo", "name")));
  await startActivityFor(thisApp(), chosen);
  return newIntent();
});
