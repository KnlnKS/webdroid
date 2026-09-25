import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("offset date-time extracts calendar fields in its own offset", async () => {
  const offset = await vcall(rt.link("java/time/ZoneOffset").ctor, "ofTotalSeconds", "(I)Ljava/time/ZoneOffset;", -5 * 3600);
  const epoch = await vcall(rt.link("java/time/Instant").ctor, "ofEpochMilli", "(J)Ljava/time/Instant;", 0n);
  const dateTime = await vcall(epoch, "atOffset", "(Ljava/time/ZoneOffset;)Ljava/time/OffsetDateTime;", offset);
  const date = await vcall(dateTime, "toLocalDate", "()Ljava/time/LocalDate;");
  const time = await vcall(dateTime, "toLocalTime", "()Ljava/time/LocalTime;");
  expect(await vcall(date, "toString", "()Ljava/lang/String;")).toBe("1969-12-31");
  expect(await vcall(time, "toString", "()Ljava/lang/String;")).toBe("19:00:00");
  expect(await vcall(dateTime, "getHour", "()I")).toBe(19);
  const formatter = rt.link("java/time/format/DateTimeFormatter").ctor.s$ISO_OFFSET_DATE_TIME;
  expect(await vcall(dateTime, "format", "(Ljava/time/format/DateTimeFormatter;)Ljava/lang/String;", formatter))
    .toBe("1969-12-31T19:00-05:00");
});
