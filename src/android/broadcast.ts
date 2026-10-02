import { type JObj, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import type { JIntent } from "./intent";
import type { JBundle } from "./os";

export type BroadcastResult = { code: number; data: string | null; extras: JBundle | null; aborted: boolean };
/** a broadcast to every process: `permissions` are those a receiver must hold; it answers the final result */
export const broadcastTransport: { send: ((intent: JIntent, permissions: string[], ordered: boolean, initial?: BroadcastResult) => Promise<BroadcastResult>) | null } = { send: null };
/** broadcasts the system keeps current (BatteryService's BATTERY_CHANGED), by action. As in
 *  ActivityManagerService, a registration matching one gets it back and its receiver hears it at once. */
export const stickyBroadcasts = new Map<string, () => JIntent | Promise<JIntent>>();
/** IntentFilter.match(ContentResolver, Intent, boolean, String), as the broadcast queue matches a registration */
export const filterMatches = driven(function* matches$(filter: JObj, intent: JIntent): Gen<boolean> {
  return (yield vcall(filter, "match", "(Landroid/content/ContentResolver;Landroid/content/Intent;ZLjava/lang/String;)I", null, intent, 0, "ActivityManager")) >= 0;
});
