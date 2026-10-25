// The kinds of host.info(kind, a, b), the host's answers about classes and members that compiled code asks for. The kinds of each
// answering module start at their own hundred, which host.info (link/hostimports.ts) dispatches on; the hundreds only the linker's
// code asks for are its own (link/reflect.ts RInfo, link/members.ts MInfo).
/** classes: class and field metadata, and the slots of their synthetic functions (link/classes.ts) */
export const Info = { Flags: 0, Primitive: 1, Super: 2, Component: 3, NIfaces: 4, Iface: 5, Inner: 6, NFields: 9, FieldType: 12, FieldFlags: 13, AllocSlot: 14, CloneSlot: 15, ArraySlot: 16, ArrayOf: 17, EnsureSlot: 18, FieldDesc: 19, CanAccess: 20, HasClinit: 21, FieldOffset: 22 } as const;
export type Info = (typeof Info)[keyof typeof Info];
/** sun.misc.Unsafe and field access (link/unsafe.ts) */
export const UInfo = { FieldGet: 100, FieldPut: 101, FieldCas: 102, ComponentScale: 103, AllocInstance: 104, StaticGet: 105, StaticPut: 106, ObjGet: 107, ObjPut: 108, ObjCas: 109 } as const;
export type UInfo = (typeof UInfo)[keyof typeof UInfo];
