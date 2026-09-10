export const SYSTEM_PACKAGES = [
  {
    pkg: "com.google.android.gms",
    file: "com.google.android.gms-252432032.apk",
    sha256: "169a53df557e6577322e7cc8aa3389cb82b3d6408dd162433cc94f1d084a73d4",
    signatureMetadata: "fake-signature",
    grants: ["android.permission.FAKE_PACKAGE_SIGNATURE", "org.microg.gms.PROVISION"],
    provision: { component: "org.microg.gms.provision.ProvisionService", extras: { checkin_enabled: true, gcm_enabled: true } },
  },
  {
    pkg: "com.android.vending",
    file: "com.android.vending-84022632.apk",
    sha256: "638f712d267bb9bc57311acbc49e769932bdea9f7fdda26a6ea98b921e632916",
    signatureMetadata: "fake-signature",
    grants: ["android.permission.FAKE_PACKAGE_SIGNATURE"],
    provision: null,
  },
] as const;

export const SYSTEM_PACKAGE_RELEASE = "https://github.com/microg/GmsCore/releases/download/v0.3.16.252432/";
