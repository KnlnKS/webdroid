// PKCS#7 brings the RSA/X.509 dependencies; the root entry also loads unused TLS/SSH code.
import forge from "node-forge/lib/forge";
import "node-forge/lib/pkcs7";
import "node-forge/lib/md.all";

export default forge;
