import { JObj, rt } from "../runtime";

class JHttpParams extends JObj { values = new Map<string, unknown>(); }
const setParam = function (this: JHttpParams, name: string, value: unknown) { this.values.set(name, value); return this; };
rt.register({
  name: "org/apache/http/params/BasicHttpParams", ctor: JHttpParams, ifaces: ["org/apache/http/params/HttpParams"],
  methods: {
    "<init>()V": function () {},
    "getParameter(Ljava/lang/String;)Ljava/lang/Object;": function (this: JHttpParams, name: string) { return this.values.get(name) ?? null; },
    "setParameter(Ljava/lang/String;Ljava/lang/Object;)Lorg/apache/http/params/HttpParams;": setParam,
    "setBooleanParameter(Ljava/lang/String;Z)Lorg/apache/http/params/HttpParams;": setParam,
    "setIntParameter(Ljava/lang/String;I)Lorg/apache/http/params/HttpParams;": setParam,
    "setLongParameter(Ljava/lang/String;J)Lorg/apache/http/params/HttpParams;": setParam,
    "setDoubleParameter(Ljava/lang/String;D)Lorg/apache/http/params/HttpParams;": setParam,
    "getBooleanParameter(Ljava/lang/String;Z)Z": function (this: JHttpParams, name: string, fallback: number) { return this.values.has(name) ? +!!this.values.get(name) : fallback; },
    "getIntParameter(Ljava/lang/String;I)I": function (this: JHttpParams, name: string, fallback: number) { return this.values.has(name) ? Number(this.values.get(name)) : fallback; },
    "getLongParameter(Ljava/lang/String;J)J": function (this: JHttpParams, name: string, fallback: bigint) { return this.values.has(name) ? BigInt(this.values.get(name) as bigint) : fallback; },
    "getDoubleParameter(Ljava/lang/String;D)D": function (this: JHttpParams, name: string, fallback: number) { return this.values.has(name) ? Number(this.values.get(name)) : fallback; },
    "removeParameter(Ljava/lang/String;)Z": function (this: JHttpParams, name: string) { return this.values.delete(name) ? 1 : 0; },
    "isParameterSet(Ljava/lang/String;)Z": function (this: JHttpParams, name: string) { return this.values.has(name) ? 1 : 0; },
    "isParameterSetLocally(Ljava/lang/String;)Z": function (this: JHttpParams, name: string) { return this.values.has(name) ? 1 : 0; },
    "clear()V": function (this: JHttpParams) { this.values.clear(); },
    "copy()Lorg/apache/http/params/HttpParams;": function (this: JHttpParams) { const copy = new JHttpParams(); copy.values = new Map(this.values); return copy; },
    "clone()Ljava/lang/Object;": function (this: JHttpParams) { const copy = new JHttpParams(); copy.values = new Map(this.values); return copy; },
  },
});

class JHttpProcessor extends JObj { requests: unknown[] = []; responses: unknown[] = []; }
rt.register({
  name: "org/apache/http/protocol/BasicHttpProcessor", ctor: JHttpProcessor, ifaces: ["org/apache/http/protocol/HttpProcessor"],
  methods: {
    "<init>()V": function () {},
    "addInterceptor(Lorg/apache/http/HttpRequestInterceptor;)V": function (this: JHttpProcessor, value: unknown) { this.requests.push(value); },
    "addInterceptor(Lorg/apache/http/HttpResponseInterceptor;)V": function (this: JHttpProcessor, value: unknown) { this.responses.push(value); },
  },
});

class JHandlerRegistry extends JObj { handlers = new Map<string, unknown>(); }
rt.register({
  name: "org/apache/http/protocol/HttpRequestHandlerRegistry", ctor: JHandlerRegistry, ifaces: ["org/apache/http/protocol/HttpRequestHandlerResolver"],
  methods: {
    "<init>()V": function () {},
    "register(Ljava/lang/String;Lorg/apache/http/protocol/HttpRequestHandler;)V": function (this: JHandlerRegistry, pattern: string, handler: unknown) { this.handlers.set(pattern, handler); },
    "unregister(Ljava/lang/String;)V": function (this: JHandlerRegistry, pattern: string) { this.handlers.delete(pattern); },
    "lookup(Ljava/lang/String;)Lorg/apache/http/protocol/HttpRequestHandler;": function (this: JHandlerRegistry, uri: string) {
      if (this.handlers.has(uri)) return this.handlers.get(uri);
      let best = "", match: unknown = null;
      for (const [pattern, handler] of this.handlers) {
        const hit = pattern === "*" || pattern.endsWith("*") && uri.startsWith(pattern.slice(0, -1)) || pattern.startsWith("*") && uri.endsWith(pattern.slice(1));
        if (hit && pattern.length > best.length) { best = pattern; match = handler; }
      }
      return match;
    },
  },
});

rt.register({ name: "org/apache/http/protocol/ResponseContent", ctor: class extends JObj {}, ifaces: ["org/apache/http/HttpResponseInterceptor"], methods: { "<init>()V": function () {} } });
rt.register({ name: "org/apache/http/impl/NoConnectionReuseStrategy", ctor: class extends JObj {}, ifaces: ["org/apache/http/ConnectionReuseStrategy"], methods: { "<init>()V": function () {}, "keepAlive(Lorg/apache/http/HttpResponse;Lorg/apache/http/protocol/HttpContext;)Z": () => 0 } });
rt.register({ name: "org/apache/http/impl/DefaultHttpResponseFactory", ctor: class extends JObj {}, ifaces: ["org/apache/http/HttpResponseFactory"], methods: { "<init>()V": function () {} } });
rt.register({ name: "org/apache/http/protocol/HttpService", ctor: class extends JObj {}, methods: {
  "<init>(Lorg/apache/http/protocol/HttpProcessor;Lorg/apache/http/ConnectionReuseStrategy;Lorg/apache/http/HttpResponseFactory;)V": function () {},
  "setHandlerResolver(Lorg/apache/http/protocol/HttpRequestHandlerResolver;)V": function () {},
  "setParams(Lorg/apache/http/params/HttpParams;)V": function () {},
} });

rt.markers("org/apache/http/params/HttpParams", "org/apache/http/protocol/HttpProcessor",
  "org/apache/http/protocol/HttpRequestHandler", "org/apache/http/protocol/HttpRequestHandlerResolver",
  "org/apache/http/HttpRequestInterceptor", "org/apache/http/HttpResponseInterceptor",
  "org/apache/http/ConnectionReuseStrategy", "org/apache/http/HttpResponseFactory");
