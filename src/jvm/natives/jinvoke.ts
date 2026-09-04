// The method-handle path Android proxy bridges use to call an interface's default method.

import { parseMethodDesc } from "../abi";
import { JObj, rt } from "../runtime";
import { type JClass } from "./jlang";
import { boxReturn, JMethod, unboxArg } from "./jreflect";

class JMethodHandle extends JObj {
  method!: JMethod;
  receiver: unknown = null;
}

function handle(method: JMethod, receiver: unknown = null): JMethodHandle {
  const h = new JMethodHandle();
  h.method = method; h.receiver = receiver;
  return h;
}

rt.register({
  name: "java/lang/invoke/MethodHandle", ctor: JMethodHandle,
  methods: {
    "bindTo(Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;": function (this: JMethodHandle, receiver: unknown) {
      return handle(this.method, receiver);
    },
    "invokeWithArguments([Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JMethodHandle, args: unknown[] | null) {
      const fn = this.method.fn;
      if (!fn) throw rt.mkThrowable("java/lang/NoSuchMethodError", `${this.method.owner.name}.${this.method.name}${this.method.desc}`);
      const result = fn.apply(this.receiver, (args ?? []).map(unboxArg));
      return boxReturn(parseMethodDesc(this.method.desc).ret, result instanceof Promise ? await result : result);
    },
  },
});

class JLookup extends JObj {
  lookupClass: JClass | null = null;
}

function lookup(lookupClass: JClass): JLookup {
  const l = new JLookup(); l.lookupClass = lookupClass; return l;
}

rt.register({
  name: "java/lang/invoke/MethodHandles$Lookup", ctor: JLookup,
  methods: {
    "<init>(Ljava/lang/Class;I)V": function (this: JLookup, lookupClass: JClass) { this.lookupClass = lookupClass; },
    "in(Ljava/lang/Class;)Ljava/lang/invoke/MethodHandles$Lookup;": function (requested: JClass) { return lookup(requested); },
    "unreflectSpecial(Ljava/lang/reflect/Method;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;": function (method: JMethod, _caller: JClass) {
      return handle(method);
    },
  },
});

// handle() constructs this class directly, so link it before the first instance is made.
rt.link("java/lang/invoke/MethodHandle");
