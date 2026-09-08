import { JObj, rt } from "../jvm/runtime";
import { stringHash } from "../jvm/natives/jlang";

class JAccount extends JObj { name = ""; type = ""; }

rt.register({
  name: "android/accounts/Account", ctor: JAccount, ifaces: ["android/os/Parcelable"],
  fields: { name: "name", type: "type" },
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JAccount, name: string | null, type: string | null) {
      if (!name || !type) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Account name and type must not be empty");
      this.name = name; this.type = type;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JAccount, other: unknown) {
      return other instanceof JAccount && this.name === other.name && this.type === other.type ? 1 : 0;
    },
    "hashCode()I": function (this: JAccount) { return (Math.imul(527 + stringHash(this.name), 31) + stringHash(this.type)) | 0; },
    "toString()Ljava/lang/String;": function (this: JAccount) { return `Account {name=${this.name}, type=${this.type}}`; },
    "describeContents()I": () => 0,
  },
});
