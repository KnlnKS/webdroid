// android.util natives: Log, EventLog and StatsLog.

import { rt } from "../jvm/runtime.ts";
import { unbox as boxedValue } from "../jvm/natives/jbox.ts";
import { utf8Length } from "../jvm/abi.ts";

const PRIORITY = ["", "", "V", "D", "I", "W", "E", "A"];
const logFn = (lvl: string, tag: string | null, msg: string, tr?: unknown) => {
  const t = tr as { msg?: string; stack?: string } | undefined;
  console.log(`[${lvl}/${tag}]`, msg, tr ? `(${t?.msg ?? tr})` : "", t?.stack ?? "");
};
/** the bytes liblog's writer reports for a record: priority, then tag and message as C strings */
const recordSize = (tag: string, msg: string) => 3 + utf8Length(tag) + utf8Length(msg);
// libcore's System.logI/W/E: tag "System", priority from the type char, as its native logs them
rt.registerJnis("java/lang/System", {
  "log(CLjava/lang/String;Ljava/lang/Throwable;)V": (type: number, msg: string, tr: unknown) =>
    logFn(({ D: "D", W: "W", E: "E" } as Record<string, string>)[String.fromCharCode(type)] ?? "I", "System", msg, tr ?? undefined),
});
// android_util_Log.cpp: every buffer (main, radio, events, system, crash) is the page's one log, and
// liblog's default level is INFO with no log.tag.* property to lower it
rt.registerJnis("android/util/Log", {
  "isLoggable(Ljava/lang/String;I)Z": (_tag: string, level: number) => +(level >= 4),
  "logger_entry_max_payload_native()I": () => 4068,
  "println_native(IILjava/lang/String;Ljava/lang/String;)I": (buffer: number, priority: number, tag: string | null, msg: string | null) => {
    if (msg === null) throw rt.mkThrowable("java/lang/NullPointerException", "println needs a message");
    if (buffer < 0 || buffer > 7) throw rt.mkThrowable("java/lang/IllegalArgumentException", "bad bufID");
    logFn(PRIORITY[priority] ?? "P", tag, msg);
    return recordSize(tag ?? "", msg);
  },
});
// EventLog: the binary events buffer, written to the one log here. Each write answers the bytes
// liblog's android_log_event_list encodes: the tag, then each value as its type byte and payload
// (a list adds its type byte and count).
const eventSize = (value: unknown): number => typeof value === "string" ? 5 + utf8Length(value)
  : typeof value === "bigint" ? 9 : Array.isArray(value) ? 2 + value.reduce((n: number, v) => n + eventSize(boxedValue(v) ?? v), 0) : 5;
const writeEvent = (tag: number, value: unknown) => {
  const shown = Array.isArray(value) ? value.map((v) => String(boxedValue(v) ?? v)).join(",") : String(value);
  console.log("[I/EventLog]", tag, `[${shown}]`);
  return 4 + eventSize(value);
};
rt.registerJnis("android/util/EventLog", {
  "writeEvent(II)I": writeEvent, "writeEvent(IJ)I": writeEvent, "writeEvent(IF)I": writeEvent,
  "writeEvent(ILjava/lang/String;)I": (tag: number, value: string | null) => writeEvent(tag, value ?? "NULL"),
  "writeEvent(I[Ljava/lang/Object;)I": (tag: number, values: unknown[] | null) => writeEvent(tag, values ? [...values] : "NULL"),
});
// libstats_jni (the statsd apex's): with no statsd socket, libstatssocket drops the event
rt.claimNativeLib("stats_jni");
rt.registerJni("android/util/StatsLog", "writeImpl([BII)V", () => {});
