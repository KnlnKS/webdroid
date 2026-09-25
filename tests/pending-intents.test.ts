import { expect, test } from "bun:test";
import "../src/natives";
import { JIntent } from "../src/android/intent";
import { encodeIntent } from "../src/android/intentipc";
import { PendingIntents } from "../src/shell/pendingintents";

test("activity-stack pending intents match on the final intent and retain the preceding stack", async () => {
  const root = new JIntent(); root.component = "RootActivity";
  const detail = new JIntent(); detail.component = "DetailActivity";
  const rootData = await encodeIntent(root), detailData = await encodeIntent(detail);
  const sent: string[][] = [];
  const store = new PendingIntents(async operation => {
    sent.push([...operation.preceding.map(intent => intent.component ?? ""), operation.intent.component ?? ""]);
  });
  const operation = { pkg: "example", process: "example", uid: 10000, kind: "activity" as const,
    code: 7, flags: 0, intent: detailData, preceding: [rootData] };
  const first = store.create(operation);
  expect(first).not.toBeNull();
  expect(store.create({ ...operation, preceding: [] })).toBe(first);
  expect(await store.send(first ?? 0)).toBe(true);
  expect(sent).toEqual([["RootActivity", "DetailActivity"]]);
});
