// Where the backend's proxy and socket relays may connect. The dev server reaches this machine's network, as the developer's
// device would; the public backend reaches public addresses only, checked as each connection resolves its name, so that no
// redirect, pooled reconnect or second DNS answer leads to a private one.
import dns from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";
import { isPublicHost } from "../src/native/net-address.ts";
import type { ProxyOptions } from "../src/shell/proxy.ts";
import { toWeb } from "../scripts/serve.ts";

/** the proxy's upstream, and a name's addresses for the relays' connections */
export type Network = Required<Omit<ProxyOptions, "bridgeCall">> & { lookup: LookupFunction };

const unreachable = (host: string) => Object.assign(new Error(`${host} is not reachable from this server`), { code: "ECONNREFUSED" });

const publicLookup: LookupFunction = (name, options, callback) => {
  if (!isPublicHost(name)) return callback(unreachable(name), "", 0);
  dns.lookup(name, { all: true, family: options.family }, (error, addresses) => {
    if (!error && (!addresses.length || addresses.some(({ address }) => !isPublicHost(address)))) error = unreachable(name);
    if (error) callback(error, "", 0);
    else if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

/** one exchange that leaves the body encoded: fetch always decodes, and a guest that asked for an encoding decodes it itself */
const encodedFetch = (lookup: LookupFunction) => async (url: string, init: RequestInit): Promise<Response> => {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const body = init.body ? Buffer.from(init.body as ArrayBuffer) : undefined, headers = Object.fromEntries(new Headers(init.headers));
    if (body) headers["content-length"] ??= String(body.length);
    const req = (url.startsWith("https:") ? https : http).request(url, { method: init.method, headers, lookup, signal: init.signal ?? undefined }, resolve);
    req.setTimeout(60_000, () => req.destroy(Object.assign(new Error("Upstream timeout"), { code: "ETIMEDOUT" })));
    req.once("error", reject).end(body);
  });
  const status = res.statusCode!, headers = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  const empty = init.method === "HEAD" || [204, 205, 304].includes(status);
  if (empty) res.resume();
  return new Response(empty ? null : toWeb(res), { status, statusText: res.statusMessage, headers });
};

function network(reachable: (host: string) => boolean, lookup: LookupFunction): Network {
  const connect = buildConnector({ lookup });
  // a redirect to an address literal reaches the connector without a lookup
  const dispatcher = new Agent({ connections: 16, connect: (options, callback) =>
    reachable(options.hostname) ? connect(options, callback) : callback(unreachable(options.hostname), null) });
  return { reachable, lookup, fetchEncoded: encodedFetch(lookup),
    // undici's own fetch, since Node's built-in one rejects this package's dispatcher; its Response is the web one in all but type
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher } as UndiciInit) as unknown as Promise<Response> };
}

export const localNetwork = network(() => true, dns.lookup);
export const publicNetwork = network(isPublicHost, publicLookup);
