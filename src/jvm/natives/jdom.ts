import { JObj, rt } from "../runtime";

// Android exposes the W3C DOM contracts through its XML stack. Concrete parsers supply the
// behavior; these registrations preserve the interface hierarchy for casts and reflection.
rt.register({ name: "org/w3c/dom/Node", ctor: class extends JObj {} });
rt.register({ name: "org/w3c/dom/Document", ctor: class extends JObj {}, ifaces: ["org/w3c/dom/Node"] });
