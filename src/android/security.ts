// android.security.keystore: KeyGenParameterSpec (+Builder) and KeyProperties — the description
// of a key the AndroidKeyStore KeyGenerator (jcrypto) generates under an alias.

import { rt, JObj, fieldGetters, flagGetters } from "../jvm/runtime";
import { jarray } from "../jvm/abi";

const strs = (a: string[]) => jarray(a.slice(), "Ljava/lang/String;");
export class JKeyGenSpec extends JObj {
  alias = ""; purposes = 0; keySize = -1;
  blockModes: string[] = []; paddings: string[] = []; digests: string[] = []; sigPaddings: string[] = [];
  userAuth = false; authSeconds = -1; randomizedEncryption = true; strongBox = false;
  keyValidityStart: unknown = null; keyValidityEnd: unknown = null; keyValidityConsumptionEnd: unknown = null;
  unlockedDeviceRequired = false; invalidatedByEnrollment = true; attestation: Int8Array | null = null;
  uid = -1;
  devicePropertiesAttestation = false;
  certificateSubject: unknown = null; certificateSerial: unknown = null;
  certificateNotBefore: unknown = null; certificateNotAfter: unknown = null;
}
const specGetters = {
  "getBlockModes()[Ljava/lang/String;": function (this: JKeyGenSpec) { return strs(this.blockModes); },
  "getEncryptionPaddings()[Ljava/lang/String;": function (this: JKeyGenSpec) { return strs(this.paddings); },
  "getSignaturePaddings()[Ljava/lang/String;": function (this: JKeyGenSpec) { return strs(this.sigPaddings); },
  "getDigests()[Ljava/lang/String;": function (this: JKeyGenSpec) { return strs(this.digests); },
  ...fieldGetters({ "getKeystoreAlias()Ljava/lang/String;": "alias", "getPurposes()I": "purposes",
    "getKeySize()I": "keySize", "getUserAuthenticationValidityDurationSeconds()I": "authSeconds",
    "getKeyValidityStart()Ljava/util/Date;": "keyValidityStart",
    "getKeyValidityForOriginationEnd()Ljava/util/Date;": "keyValidityEnd",
    "getKeyValidityForConsumptionEnd()Ljava/util/Date;": "keyValidityConsumptionEnd",
    "getAttestationChallenge()[B": "attestation", "getUid()I": "uid" }),
  ...flagGetters({ "isUserAuthenticationRequired()Z": "userAuth",
    "isDevicePropertiesAttestationIncluded()Z": "devicePropertiesAttestation",
    "isRandomizedEncryptionRequired()Z": "randomizedEncryption", "isStrongBoxBacked()Z": "strongBox",
    "isUnlockedDeviceRequired()Z": "unlockedDeviceRequired",
    "isInvalidatedByBiometricEnrollment()Z": "invalidatedByEnrollment" }),
};
rt.register({ name: "android/security/keystore/KeyGenParameterSpec", ctor: JKeyGenSpec, ifaces: ["java/security/spec/AlgorithmParameterSpec"], methods: specGetters });

class JKeyGenSpecBuilder extends JObj { spec = new JKeyGenSpec(); }
const B = "Landroid/security/keystore/KeyGenParameterSpec$Builder;";
const set = (f: (s: JKeyGenSpec, ...a: any[]) => void) => function (this: JKeyGenSpecBuilder, ...a: unknown[]) { f(this.spec, ...a); return this; };
const strList = (a: string[] | null) => (a ?? []).slice();
rt.register({
  name: "android/security/keystore/KeyGenParameterSpec$Builder", ctor: JKeyGenSpecBuilder,
  methods: {
    "<init>(Ljava/lang/String;I)V": function (this: JKeyGenSpecBuilder, alias: string, purposes: number) {
      if (alias == null) throw rt.mkThrowable("java/lang/NullPointerException", "keystoreAlias == null");
      if (!alias) throw rt.mkThrowable("java/lang/IllegalArgumentException", "keystoreAlias must not be empty");
      this.spec.alias = alias; this.spec.purposes = purposes;
    },
    "<init>(Landroid/security/keystore/KeyGenParameterSpec;)V": function (this: JKeyGenSpecBuilder, s: JKeyGenSpec) { Object.assign(this.spec, s); },
    [`setKeySize(I)${B}`]: set((s, n: number) => { if (n < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "keySize < 0"); s.keySize = n; }),
    [`setBlockModes([Ljava/lang/String;)${B}`]: set((s, a) => { s.blockModes = strList(a); }),
    [`setEncryptionPaddings([Ljava/lang/String;)${B}`]: set((s, a) => { s.paddings = strList(a); }),
    [`setSignaturePaddings([Ljava/lang/String;)${B}`]: set((s, a) => { s.sigPaddings = strList(a); }),
    [`setDigests([Ljava/lang/String;)${B}`]: set((s, a) => { s.digests = strList(a); }),
    [`setUserAuthenticationRequired(Z)${B}`]: set((s, v: number) => { s.userAuth = !!v; }),
    [`setUserAuthenticationValidityDurationSeconds(I)${B}`]: set((s, v: number) => { if (v < -1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "seconds must be -1 or larger"); s.authSeconds = v; }),
    [`setUserAuthenticationParameters(II)${B}`]: set((s, v: number) => { s.authSeconds = v; }),
    [`setRandomizedEncryptionRequired(Z)${B}`]: set((s, v: number) => { s.randomizedEncryption = !!v; }),
    [`setIsStrongBoxBacked(Z)${B}`]: set((s, v: number) => { s.strongBox = !!v; }),
    [`setUnlockedDeviceRequired(Z)${B}`]: set((s, v: number) => { s.unlockedDeviceRequired = !!v; }),
    [`setInvalidatedByBiometricEnrollment(Z)${B}`]: set((s, v: number) => { s.invalidatedByEnrollment = !!v; }),
    [`setUserConfirmationRequired(Z)${B}`]: set(() => {}),
    [`setUserPresenceRequired(Z)${B}`]: set(() => {}),
    [`setKeyValidityStart(Ljava/util/Date;)${B}`]: set((s, d) => { s.keyValidityStart = d; }),
    [`setKeyValidityEnd(Ljava/util/Date;)${B}`]: set((s, d) => { s.keyValidityEnd = d; s.keyValidityConsumptionEnd = d; }),
    [`setKeyValidityForOriginationEnd(Ljava/util/Date;)${B}`]: set((s, d) => { s.keyValidityEnd = d; }),
    [`setKeyValidityForConsumptionEnd(Ljava/util/Date;)${B}`]: set((s, d) => { s.keyValidityConsumptionEnd = d; }),
    [`setDevicePropertiesAttestationIncluded(Z)${B}`]: set((s, value: number) => { s.devicePropertiesAttestation = !!value; }),
    [`setAttestationChallenge([B)${B}`]: set((s, b) => { s.attestation = b; }),
    [`setCertificateSubject(Ljavax/security/auth/x500/X500Principal;)${B}`]: set((s, value) => { s.certificateSubject = value; }),
    [`setCertificateSerialNumber(Ljava/math/BigInteger;)${B}`]: set((s, value) => { s.certificateSerial = value; }),
    [`setCertificateNotBefore(Ljava/util/Date;)${B}`]: set((s, value) => { s.certificateNotBefore = value; }),
    [`setCertificateNotAfter(Ljava/util/Date;)${B}`]: set((s, value) => { s.certificateNotAfter = value; }),
    [`setAlgorithmParameterSpec(Ljava/security/spec/AlgorithmParameterSpec;)${B}`]: set(() => {}),
    "build()Landroid/security/keystore/KeyGenParameterSpec;": function (this: JKeyGenSpecBuilder) { return Object.assign(new JKeyGenSpec(), this.spec); },
  },
});

rt.register({
  name: "android/security/keystore/KeyProperties", ctor: class extends JObj {},
  statics: {
    PURPOSE_ENCRYPT: 1, PURPOSE_DECRYPT: 2, PURPOSE_SIGN: 4, PURPOSE_VERIFY: 8, PURPOSE_WRAP_KEY: 32, PURPOSE_AGREE_KEY: 64,
    KEY_ALGORITHM_AES: "AES", KEY_ALGORITHM_HMAC_SHA256: "HmacSHA256", KEY_ALGORITHM_RSA: "RSA", KEY_ALGORITHM_EC: "EC",
    BLOCK_MODE_ECB: "ECB", BLOCK_MODE_CBC: "CBC", BLOCK_MODE_CTR: "CTR", BLOCK_MODE_GCM: "GCM",
    ENCRYPTION_PADDING_NONE: "NoPadding", ENCRYPTION_PADDING_PKCS7: "PKCS7Padding", ENCRYPTION_PADDING_RSA_PKCS1: "PKCS1Padding", ENCRYPTION_PADDING_RSA_OAEP: "OAEPPadding",
    SIGNATURE_PADDING_RSA_PKCS1: "PKCS1", SIGNATURE_PADDING_RSA_PSS: "PSS",
    DIGEST_NONE: "NONE", DIGEST_SHA1: "SHA-1", DIGEST_SHA256: "SHA-256", DIGEST_SHA384: "SHA-384", DIGEST_SHA512: "SHA-512",
    AUTH_BIOMETRIC_STRONG: 2, AUTH_DEVICE_CREDENTIAL: 1,
    SECURITY_LEVEL_SOFTWARE: 1, SECURITY_LEVEL_TRUSTED_ENVIRONMENT: 2, SECURITY_LEVEL_STRONGBOX: 3,
  },
});

// The cleartext policy an HTTP stack checks before a plain http:// request. The dev server's
// proxy will fetch either scheme, so the answer is the permissive one a debug manifest gives.
class JNetSecPolicy extends JObj {}
const NET_SEC_POLICY = new JNetSecPolicy();
rt.register({
  name: "android/security/NetworkSecurityPolicy", ctor: JNetSecPolicy,
  methods: {
    "static getInstance()Landroid/security/NetworkSecurityPolicy;": () => NET_SEC_POLICY,
    "isCleartextTrafficPermitted()Z": () => 1,
    "isCleartextTrafficPermitted(Ljava/lang/String;)Z": () => 1,
  },
});
