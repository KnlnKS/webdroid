declare module "node-forge/lib/forge" {
  const forge: Pick<typeof import("node-forge"), "asn1" | "pki" | "pkcs7" | "pem" | "md" | "util">;
  export default forge;
}
