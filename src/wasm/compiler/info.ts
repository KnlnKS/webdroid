// The kinds of host.info(kind, a, b), the host's answers about classes and members that compiled code asks for. The kinds of each
// answering module start at their own hundred, which host.info (link/hostimports.ts) dispatches on.
/** classes: class and field metadata, and the slots of their synthetic functions (link/classes.ts) */
export const Info = { Flags: 0, Primitive: 1, Super: 2, Component: 3, NIfaces: 4, Iface: 5, Inner: 6, NFields: 9, FieldNameLen: 10, FieldNameChar: 11, FieldType: 12, FieldFlags: 13, AllocSlot: 14, CloneSlot: 15, ArraySlot: 16, ArrayOf: 17, EnsureSlot: 18, FieldDesc: 19, CanAccess: 20, HasClinit: 21, FieldOffset: 22 } as const;
export type Info = (typeof Info)[keyof typeof Info];
/** sun.misc.Unsafe and field access (link/unsafe.ts) */
export const UInfo = { FieldGet: 100, FieldPut: 101, FieldCas: 102, ComponentScale: 103, AllocInstance: 104, StaticGet: 105, StaticPut: 106, ObjGet: 107, ObjPut: 108, ObjCas: 109 } as const;
export type UInfo = (typeof UInfo)[keyof typeof UInfo];
/** host.text(kind, a, b): the simple name of class a, or the name of class a, of its method b or of its field b (link/members.ts) */
export const TextKind = { SimpleName: 0, ClassName: 1, MethodName: 2, FieldName: 3 } as const;
export type TextKind = (typeof TextKind)[keyof typeof TextKind];
/** Method and Constructor (link/reflect.ts) */
export const RInfo = { MethodCount: 200, MethodNameLen: 201, MethodNameChar: 202, MethodKind: 203, MethodParams: 204, MethodParamType: 205, MethodRet: 206, MethodFlags: 207, MethodInvoke: 208, MethodCall: 209, MethodCallDirect: 210, IfaceCount: 211, Iface: 212, MemberCount: 213, Member: 214, MethodsNamed: 215, MethodNamedAt: 216, SerialInit: 217, MethodSlot: 218 } as const;
export type RInfo = (typeof RInfo)[keyof typeof RInfo];
/** members, annotations and enclosing classes (link/members.ts) */
export const MInfo = { ExecCount: 300, ExecAt: 301, ClassAnn: 302, ExecAnn: 303, FieldAnn: 304, IsRecord: 305, DeclaringClass: 306, EnclosingClass: 307, EnclosingIndex: 308, CompareParams: 309, ThrowsCount: 310, ThrowsAt: 311, EnclosingOwner: 312, IsAnonymous: 313 } as const;
export type MInfo = (typeof MInfo)[keyof typeof MInfo];
