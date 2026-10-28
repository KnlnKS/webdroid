import dns from "node:dns/promises";
import type { LookupFunction } from "node:net";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { Agent, buildConnector, fetch as upstreamFetch, type RequestInit as UpstreamInit } from "undici";
import { isPublicHost } from "../src/native/net-address.ts";
import { toWeb } from "../scripts/serve.ts";

export async function resolvePublic(host: string, family = 0) {
  const name = host.replace(/^\[(.*)\]$/, "$1");
  if (!isPublicHost(name)) throw Object.assign(new Error("Private network is unreachable"), { code: "EACCES" });
  const addresses = await dns.lookup(name, { all: true, family });
  if (!addresses.length || addresses.some(({ address }) => !isPublicHost(address)))
    throw Object.assign(new Error("Private network is unreachable"), { code: "EACCES" });
  return addresses;
}

// Pin the checked DNS answer to the connection, including every redirect and pooled reconnect.
const publicLookup: LookupFunction = (name, options, callback) => {
  void resolvePublic(name, Number(options.family) || 0).then(addresses => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }, error => callback(error, "", 0));
};
const connect = buildConnector({ lookup: publicLookup });
const dispatcher = new Agent({ connect: (options, callback) => {
  if (!isPublicHost(options.hostname)) return callback(new Error("Private network is unreachable"), null);
  connect(options, callback);
}, connections: 16 });
export const publicFetch = (url: string, init: RequestInit) => {
  if (!isPublicHost(new URL(url).hostname)) return Promise.reject(new Error("Private network is unreachable"));
  return upstreamFetch(url, { ...init, dispatcher } as UpstreamInit) as unknown as Promise<Response>;
};

export async function fetchEncoded(url: string, init: RequestInit, publicOnly = false): Promise<Response> {
  const target = new URL(url);
  if (publicOnly && !isPublicHost(target.hostname)) throw new Error("Private network is unreachable");
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const body = init.body ? Buffer.from(init.body as ArrayBuffer) : undefined, headers = Object.fromEntries(new Headers(init.headers));
    if (body) headers["content-length"] ??= String(body.length);
    const req = (target.protocol === "https:" ? https : http).request(target, {
      method: init.method, headers, lookup: publicOnly ? publicLookup : undefined, signal: init.signal ?? undefined,
    }, resolve);
    req.setTimeout(60_000, () => req.destroy(Object.assign(new Error("Upstream timeout"), { code: "ETIMEDOUT" })));
    req.once("error", reject).end(body);
  });
  const status = res.statusCode!, headers = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  const empty = init.method === "HEAD" || [204, 205, 304].includes(status);
  if (empty) res.resume();
  return new Response(empty ? null : toWeb(res), { status, statusText: res.statusMessage, headers });
}
