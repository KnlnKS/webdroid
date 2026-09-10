export const SYSTEM_PACKAGES = [
  {
    pkg: "com.google.android.gms",
    file: "com.google.android.gms-252432032.apk",
    sha256: "169a53df557e6577322e7cc8aa3389cb82b3d6408dd162433cc94f1d084a73d4",
    indexSha256: "a25bdb8be43a5e78d659d0d78e82336862df733e59d16cf6f97b8dfd78ad152f",
    signatureMetadata: "fake-signature",
    grants: ["android.permission.FAKE_PACKAGE_SIGNATURE", "org.microg.gms.PROVISION"],
    // Browser geolocation supplies the platform provider; radio scans are unavailable.
    disabledComponents: ["org.microg.gms.location.network.NetworkLocationService"],
    provision: { component: "org.microg.gms.provision.ProvisionService", extras: { checkin_enabled: true, gcm_enabled: true } },
  },
  {
    pkg: "com.android.vending",
    file: "com.android.vending-84022632.apk",
    sha256: "638f712d267bb9bc57311acbc49e769932bdea9f7fdda26a6ea98b921e632916",
    indexSha256: "09e63f8651e840a8ef805803a7afa55bb4dcb7f042dcf37767245247964eb98a",
    signatureMetadata: "fake-signature",
    grants: ["android.permission.FAKE_PACKAGE_SIGNATURE"],
    disabledComponents: [],
    provision: null,
  },
] as const;

export const SYSTEM_PACKAGE_RELEASE = "https://github.com/microg/GmsCore/releases/download/v0.3.16.252432/";
