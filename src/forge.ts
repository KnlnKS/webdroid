// PKCS#7 brings the RSA/X.509 dependencies; the root entry also loads unused TLS/SSH code.
import forge from "node-forge/lib/forge.js";
import "node-forge/lib/pkcs7.js";
import "node-forge/lib/md.all.js";

export default forge;
