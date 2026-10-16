export const SYSTEM_PACKAGES = [
  {
    pkg: "com.google.android.gms",
    file: "com.google.android.gms-252432034.apk",
    sha256: "e5e6cba078bdec812b5450599350e5c1a12c8b7438da5bf77123af170f8c1a35",
    indexSha256: "185ee02dc556825fdd376cde2adcec87a90e53266f07903896391d432dd1e1f2",
    signatureMetadata: "fake-signature",
    grants: ["android.permission.FAKE_PACKAGE_SIGNATURE", "org.microg.gms.PROVISION"],
    // AOSP's DefaultPermissionGrantPolicy gives the privileged location provider its location
    // permissions at first boot, so it never has to ask the user for them.
    defaultGrants: ["android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_BACKGROUND_LOCATION"],
    // Browser geolocation supplies the platform provider; radio scans are unavailable.
    disabledComponents: ["org.microg.gms.location.network.NetworkLocationService"],
    provision: { component: "org.microg.gms.provision.ProvisionService",
      // Nominatim answers the platform Geocoder, which apps use to turn a fix into an address
      extras: { checkin_enabled: true, gcm_enabled: true, nominatim_enabled: true },
      attestationExtras: { safetynet_enabled: true } },
  },
  {
    pkg: "com.android.vending",
    file: "com.android.vending-84022634.apk",
    sha256: "9b8616011cc8f026bcbbe094df850794abb9d6d9f23214d7a8f8c4d1033ea012",
    indexSha256: "bb40ca47c05472ffd052c72138ea5f4424d9219c5b0a76b312a9ee566a2f63f4",
    signatureMetadata: "fake-signature",
    grants: ["android.permission.FAKE_PACKAGE_SIGNATURE"],
    defaultGrants: [],
    disabledComponents: [],
    provision: null,
  },
] as const;

export const SYSTEM_PACKAGE_RELEASE = "https://github.com/microg/GmsCore/releases/download/v0.3.17.252432/";
