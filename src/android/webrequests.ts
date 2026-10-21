// The request and error values the WebView provider hands its clients, and its clients' answer to a
// request: WebViewClient.shouldInterceptRequest.
import { awaited, rt, JObj, type Gen } from "../jvm/runtime.ts";
import { vcall, callOn, newObj, type JThread } from "../jvm/natives/jentry.ts";
import { readStreamFully } from "../jvm/natives/jio.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { mkUri } from "./net.ts";
import type { WebRequest, WebResponse } from "../shell/webpage/protocol.ts";

const inst = <T = JObj>(cls: string): T => rt.make(cls);
export class JReq extends JObj { url = ""; main = true; gesture = false; method = "GET"; headers: unknown = null; }
export function mkRequest(url: string, gesture = false): JReq {
  const r = inst<JReq>("webdroid/WebResourceRequest");
  r.url = url; r.gesture = gesture;
  return r;
}
export class JWebErr extends JObj { code = -1; desc = ""; }
/** a WebResourceError of Chromium's net error `code` */
export function mkError(code: number, desc: string): JWebErr {
  const error = inst<JWebErr>("webdroid/WebResourceError");
  error.code = code; error.desc = desc;
  return error;
}

/** WebViewClient.shouldInterceptRequest, which Chromium calls on its IO thread */
export function interceptRequest(client: JObj, view: JObj, thread: JThread, request: WebRequest): Promise<WebResponse | null> {
  return Promise.resolve(callOn(thread, () => rt.drive(function* (): Gen<WebResponse | null> {
    const req = mkRequest(request.url);
    req.main = request.main; req.method = request.method;
    req.headers = yield newObj("java/util/HashMap");
    for (const [key, value] of Object.entries(request.headers)) yield vcall(req.headers, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, value);
    const response: JObj | null = yield vcall(client, "shouldInterceptRequest", "(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;", view, req);
    if (!response) return null;
    const mime: string | null = yield vcall(response, "getMimeType", "()Ljava/lang/String;");
    const enc: string | null = yield vcall(response, "getEncoding", "()Ljava/lang/String;");
    const status: number = yield vcall(response, "getStatusCode", "()I");
    const reason: string | null = yield vcall(response, "getReasonPhrase", "()Ljava/lang/String;");
    const responseHeaders: JObj | null = yield vcall(response, "getResponseHeaders", "()Ljava/util/Map;");
    const data: JObj | null = yield vcall(response, "getData", "()Ljava/io/InputStream;");
    const headers: Record<string, string> = {};
    const entries = responseHeaders ? yield vcall(responseHeaders, "entrySet", "()Ljava/util/Set;") : null;
    if (entries) for (const entry of yield* awaited(toJsArray(entries))) {
      headers[yield vcall(entry, "getKey", "()Ljava/lang/Object;")] = yield vcall(entry, "getValue", "()Ljava/lang/Object;");
    }
    if (mime) headers["content-type"] = mime + (enc ? "; charset=" + enc : "");
    let body = "";
    if (data) {
      try { body = (yield* awaited(readStreamFully(data))).toBase64(); }
      finally { yield vcall(data, "close", "()V"); }
    }
    return { body, status, reason: reason ?? "OK", headers };
  }())));
}

rt.register({
  name: "webdroid/WebResourceRequest", ctor: JReq, ifaces: ["android/webkit/WebResourceRequest"],
  methods: {
    "getUrl()Landroid/net/Uri;": function (this: JReq) { return mkUri(this.url); },
    "isForMainFrame()Z": function (this: JReq) { return this.main ? 1 : 0; },
    "isRedirect()Z": () => 0,
    "hasGesture()Z": function (this: JReq) { return this.gesture ? 1 : 0; },
    "getMethod()Ljava/lang/String;": function (this: JReq) { return this.method; },
    "getRequestHeaders()Ljava/util/Map;": function (this: JReq) { return this.headers ??= inst("java/util/HashMap"); },
  },
});
rt.register({
  name: "webdroid/WebResourceError", ctor: JWebErr, sup: "android/webkit/WebResourceError",
  methods: {
    "getErrorCode()I": function (this: JWebErr) { return this.code; },
    "getDescription()Ljava/lang/CharSequence;": function (this: JWebErr) { return this.desc; },
  },
});
