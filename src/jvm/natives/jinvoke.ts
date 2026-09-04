// The method-handle path Android proxy bridges use to call an interface's default method.

import { parseMethodDesc } from "../abi";
import { JObj, rt } from "../runtime";
import { defineException, type JClass } from "./jlang";
import { boxReturn, JMethod, unboxArg } from "./jreflect";

class JMethodHandle extends JObj {
  method!: JMethod;
  receiver: unknown = null;
  bound = false;
}

function handle(method: JMethod, receiver: unknown = null, bound = false): JMethodHandle {
  const h = new JMethodHandle();
  h.method = method; h.receiver = receiver; h.bound = bound;
  return h;
}

defineException("java/lang/invoke/WrongMethodTypeException", "java/lang/RuntimeException");
rt.link("java/lang/invoke/WrongMethodTypeException");

rt.register({
  name: "java/lang/invoke/MethodHandle", ctor: JMethodHandle,
  methods: {
    "bindTo(Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;": function (this: JMethodHandle, receiver: unknown) {
      if (this.bound) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "binding method arguments is not supported");
      rt.cc(receiver, this.method.owner.name);
      return handle(this.method, receiver, true);
    },
    "invokeWithArguments([Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JMethodHandle, args: unknown[] | null) {
      const fn = this.method.fn;
      if (!fn) throw rt.mkThrowable("java/lang/NoSuchMethodError", `${this.method.owner.name}.${this.method.name}${this.method.desc}`);
      const { params, ret } = parseMethodDesc(this.method.desc);
      const supplied = (args ?? []).slice();
      const receiver = this.bound ? this.receiver : supplied.shift();
      if (supplied.length !== params.length)
        throw rt.mkThrowable("java/lang/invoke/WrongMethodTypeException", `expected ${params.length + (this.bound ? 0 : 1)} arguments`);
      if (receiver == null) rt.npe();
      rt.cc(receiver, this.method.owner.name);
      const result = fn.apply(receiver, supplied.map(unboxArg));
      return boxReturn(ret, result instanceof Promise ? await result : result);
    },
  },
});

class JLookup extends JObj {
  lookupClass: JClass | null = null;
  modes = 0;
}

function lookup(lookupClass: JClass, modes: number): JLookup {
  const l = new JLookup(); l.lookupClass = lookupClass; l.modes = modes; return l;
}

rt.register({
  name: "java/lang/invoke/MethodHandles$Lookup", ctor: JLookup,
  methods: {
    "<init>(Ljava/lang/Class;I)V": function (this: JLookup, lookupClass: JClass, modes: number) {
      if (!lookupClass) rt.npe();
      this.lookupClass = lookupClass; this.modes = modes;
    },
    "in(Ljava/lang/Class;)Ljava/lang/invoke/MethodHandles$Lookup;": function (this: JLookup, requested: JClass) {
      if (!requested) rt.npe();
      return lookup(requested, this.modes);
    },
    "unreflectSpecial(Ljava/lang/reflect/Method;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;": function (this: JLookup, method: JMethod, caller: JClass) {
      if (!method || !caller) rt.npe();
      if (this.modes !== -1) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "only trusted JNI lookups are supported");
      if (method.isStatic) throw rt.mkThrowable("java/lang/IllegalArgumentException", "static method");
      return handle(method);
    },
  },
});

// handle() constructs this class directly, so link it before the first instance is made.
rt.link("java/lang/invoke/MethodHandle");
