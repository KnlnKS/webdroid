import { expect, test } from "bun:test";
import { BridgeCalls } from "../src/shell/bridgecalls";

test("bridge replies belong to the peer that received the call", async () => {
  let sent: (message: string) => void = () => {};
  const message = new Promise<string>((resolve) => { sent = resolve; });
  const owner = { send(value: string) { sent(value); } };
  const other = { send(_value: string) {} };
  const bridge = new BridgeCalls<typeof owner>();
  const pending = bridge.call(new Request("http://localhost/webview-call", { method: "POST", body: "{}" }), owner, () => true);
  const seq = (await message).split("\n", 1)[0];
  bridge.reply(other, `${seq}\nwrong`);
  bridge.reply(owner, `${seq}\nright`);
  expect(await (await pending).text()).toBe("right");
});
