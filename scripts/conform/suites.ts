/** conformance suites: Maven jars to fetch, optional test sources to compile (an AOSP gitiles
 *  archive of the reference build's tag), and the JUnit classes to run (for sources, every
 *  class whose file name matches `tests`) */
type Suite = { maven: string[]; source?: { archive: string; root: string; tests: RegExp; include?: RegExp; exclude?: RegExp; resources?: string[] }; classes?: string[]; testng?: boolean };
const JUNIT = ["junit:junit:4.13.2", "org.hamcrest:hamcrest-core:1.3"];
/** libcore at Android 14, from LineageOS's mirror, pinned */
const LINEAGE_COMMIT = "81bfea828bc7dc432103cec1331bd6587d98f0a1";
const LINEAGE_LIBCORE = { archive: `https://codeload.github.com/LineageOS/android_libcore/tar.gz/${LINEAGE_COMMIT}`, root: `android_libcore-${LINEAGE_COMMIT}` };
export const SUITES: Record<string, Suite> = {
  guava: {
    maven: ["com.google.guava:guava-testlib:33.3.1-jre", "com.google.guava:guava:33.3.1-jre", "com.google.guava:failureaccess:1.0.2",
      ...JUNIT],
    classes: ["com.google.common.collect.testing.TestsForListsInJavaUtil", "com.google.common.collect.testing.TestsForSetsInJavaUtil",
      "com.google.common.collect.testing.TestsForMapsInJavaUtil", "com.google.common.collect.testing.TestsForQueuesInJavaUtil"],
  },
  jsr166: {
    maven: JUNIT,
    source: {
      archive: "https://android.googlesource.com/platform/libcore/+archive/refs/tags/android-15.0.0_r1/jsr166-tests.tar.gz",
      root: "src/test/java", tests: /^(?!JSR166TestCase|Abstract|BlockingQueueTest|CollectionTest)\w+Test\.java$/,
    },
  },
  // libcore's java.io and java.util.zip tests at Android 14 (LineageOS's mirror, pinned)
  "luni-io": {
    maven: JUNIT,
    source: {
      ...LINEAGE_LIBCORE,
      include: /^((harmony-tests\/src\/test\/java\/org\/apache\/harmony\/tests\/java|luni\/src\/test\/java\/libcore\/java)\/(io|util\/zip)|support\/src\/test\/java\/(tests\/support|org\/apache\/harmony\/testframework|libcore\/testing\/io)|test-rules\/src\/main\/java\/libcore\/junit)\/|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^(?!Support_|Abstract)\w+Test\.java$/,
      // these name platform members android.jar lacks, jdk.internal, mockito or junitparams
      exclude: /(harmony\/tests\/java\/io\/Fil(e|ter)OutputStreamTest|harmony\/tests\/java\/util\/zip\/Zip(File|OutputStream)Test|libcore\/java\/io\/(Console|FileDescriptor|FileInputStream|File|ObjectStreamClassSuid)Test|Zip64FileTest|EnableDeprecatedBouncyCastleAlgorithmsRule)\.java$/,
    },
  },
  // libcore's java.net tests at the same commit, without those that need hidden APIs, mockwebserver
  // or AF_UNIX; ServerSocketConcurrentCloseTest connects in a loop that never suspends, which starves
  // cooperative threads
  "luni-net": {
    maven: ["com.google.mockwebserver:mockwebserver:20130706", ...JUNIT],
    source: {
      ...LINEAGE_LIBCORE,
      include: /^((harmony-tests\/src\/test\/java\/org\/apache\/harmony\/tests\/java|luni\/src\/test\/java\/libcore\/java)\/net|support\/src\/test\/java\/(tests\/support|org\/apache\/harmony\/testframework|libcore\/testing\/io)|test-rules\/src\/main\/java\/libcore\/junit)\/|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^(?!Support_|Abstract)\w+Test\.java$/,
      exclude: /\/net\/(\w*(JarURLConnection|URLClassLoader)\w*|OldUnixSocketTest|ServerSocketConcurrentCloseTest|FtpURLConnectionTest|URLConnectionTest|DelegatingSocketFactory|OldCookieHandlerTest)\.java$|libcore\/java\/net\/(InetAddress|NetworkInterface|DatagramSocket|Socket|SocketTimeout)Test\.java$|harmony\/tests\/java\/net\/(URLDecoder|DatagramSocket|ServerSocket)Test\.java$|EnableDeprecatedBouncyCastleAlgorithmsRule\.java$/,
    },
  },
  // libcore's java.security, javax.crypto and javax.security tests at the same commit
  // (TestKeyStore builds its certificates with upstream bouncycastle; those needing mockito are left out)
  "luni-security": {
    maven: ["org.bouncycastle:bcprov-jdk15on:1.68", "org.bouncycastle:bcpkix-jdk15on:1.68", ...JUNIT],
    source: {
      ...LINEAGE_LIBCORE,
      include: /^(luni\/src\/test\/java\/(libcore\/java\/security|libcore\/javax\/(crypto|security)|tests\/security)|support\/src\/test\/java\/(tests\/support|org\/apache\/harmony\/(testframework|security\/tests\/support)|libcore\/testing\/io|libcore\/java\/(security|io)|libcore\/javax\/net\/ssl)|test-rules\/src\/main\/java\/libcore\/junit)\/|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^(?!Support_|Abstract)\w+Test\.java$/,
      resources: ["support/src/test/java", "luni/src/test/resources"],
      exclude: /(\/security\/SignatureTest|CipherInputStreamTest|CertPathValidatorExceptionTest|X509CertSelectorTest|X509CRLSelector2Test|cert\/TrustAnchorTest|auth\/SubjectTest|ProtectionDomainTest|CodeSourceTest|OldPKIXParametersTest|cert\/X509CRLTest|SubjectAlternativeNameTest|security\/(Provider|SecureRandom)Test|test-rules\/src\/main\/java\/libcore\/junit\/util\/EnableDeprecatedBouncyCastleAlgorithmsRule)\.java$/,
    },
  },
  // libcore's java.nio.file tests at the same commit, without those needing mockito, junitparams or
  // hidden sun.nio.fs classes
  "luni-nio-file": {
    maven: JUNIT,
    source: {
      ...LINEAGE_LIBCORE,
      include: /^(luni\/src\/test\/java\/(libcore|tests)\/java\/nio\/file|test-rules\/src\/main\/java\/libcore\/junit)\/|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^\w+Test\.java$/,
      exclude: /\/nio\/file\/(Files2?Test|SimpleFileVisitorTest|DefaultFileSystemProvider2Test|FileSystemsTest|LinuxFileSystemTest|LinuxPathTest|spi\/FileTypeDetectorTest)\.java$|EnableDeprecatedBouncyCastleAlgorithmsRule\.java$/,
    },
  },
  // libcore's java.nio buffer, charset and file channel tests at the same commit, without sockets,
  // selectors, pipes and asynchronous channels
  "luni-nio": {
    maven: JUNIT,
    source: {
      ...LINEAGE_LIBCORE,
      include: /^((harmony-tests\/src\/test\/java\/org\/apache\/harmony\/tests|luni\/src\/test\/java\/libcore)\/java\/nio\/(\w+\.java|charset|channels\/(\w*(File|Channels|MapMode)\w*|\w+Exception\w*)\.java)|support\/src\/test\/java\/(tests\/support|org\/apache\/harmony\/testframework|libcore\/testing\/io)|test-rules\/src\/main\/java\/libcore\/junit)\/?|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^(?!Abstract|Support_)\w+Test\.java$/,
      // these name hidden platform classes, mockito or junitparams
      exclude: /\/(\w*Direct\w*BufferTest|Asynchronous\w*|FileIOInterruptTest|EnableDeprecatedBouncyCastleAlgorithmsRule|StandardCharsetsEncoderTest)\.java$|harmony\/tests\/java\/nio\/channels\/FileLockTest\.java$|libcore\/java\/nio\/(BufferTest|channels\/(Channels|FileChannel)Test)\.java$/,
    },
  },
  // libcore's java.util tests at the same commit (zip is luni-io's, concurrent is jsr166's); ScannerParseLargeFileBenchmarkTest, 192 MB through a Scanner, is a
  // benchmark that took 364 s of the suite
  "luni-util": {
    maven: JUNIT,
    source: {
      ...LINEAGE_LIBCORE,
      include: /^((harmony-tests\/src\/test\/java\/org\/apache\/harmony\/tests\/java|luni\/src\/test\/java\/libcore\/java)\/util(?!\/zip\/|\/concurrent\/)|support\/src\/test\/java\/(tests\/(support|util)|org\/apache\/harmony\/testframework|libcore\/(testing\/io|java\/lang\/ref))|test-rules\/src\/main\/java\/libcore\/junit)\/|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^(?!Support_|Abstract)\w+Test\.java$/,
      exclude: /EnableDeprecatedBouncyCastleAlgorithmsRule\.java$|(harmony\/tests\/java\/util\/ArraysTest|harmony\/tests\/java\/util\/CollectionsTest|harmony\/tests\/java\/util\/DateTest|harmony\/tests\/java\/util\/ScannerParseLargeFileBenchmarkTest|harmony\/tests\/java\/util\/ResourceBundleTest|harmony\/tests\/java\/util\/jar\/JarEntryTest|harmony\/tests\/java\/util\/prefs\/AbstractPreferencesTest|harmony\/tests\/java\/util\/prefs\/FilePreferencesImplTest|harmony\/tests\/java\/util\/prefs\/PreferencesTest|libcore\/java\/util\/ArraysTest|libcore\/java\/util\/CollectionsTest|libcore\/java\/util\/FormatterTest|libcore\/java\/util\/HashMapTest|libcore\/java\/util\/HashSetTest|libcore\/java\/util\/LegacyLocalesTest|libcore\/java\/util\/LinkedHashMapTest|libcore\/java\/util\/LinkedHashSetTest|libcore\/java\/util\/ListOfTest|libcore\/java\/util\/LocaleInternalsTest|libcore\/java\/util\/LocaleTest|libcore\/java\/util\/OldTimeZoneTest|libcore\/java\/util\/RandomTest|libcore\/java\/util\/SequencedCollectionTest|libcore\/java\/util\/TimeZoneTest|libcore\/java\/util\/UUIDTest|libcore\/java\/util\/jar\/Pack200Test|libcore\/java\/util\/prefs\/OldAbstractPreferencesTest|libcore\/java\/util\/prefs\/OldFilePreferencesImplTest|libcore\/java\/util\/prefs\/OldNodeChangeEventTest|libcore\/java\/util\/prefs\/OldPreferenceChangeEventTest|libcore\/java\/util\/prefs\/OldPreferencesTest|libcore\/java\/util\/prefs\/PreferencesTest|libcore\/java\/util\/random\/RandomGeneratorFactoryTest|libcore\/java\/util\/regex\/MatcherTest)\.java$/,
    },
  },
  "ojluni-time": {
    maven: ["org.testng:testng:7.4.0", "com.beust:jcommander:1.78", ...JUNIT],
    source: {
      archive: "https://android.googlesource.com/platform/libcore/+archive/refs/tags/android-15.0.0_r1/ojluni/src/test/java/time.tar.gz",
      root: ".", tests: /^(TCK|Test)\w+\.java$/,
      // these name hidden platform APIs the public android.jar lacks
      exclude: /(TCKLocalizedPrinterParser|TestJapaneseChronoImpl|TestFormatter)\.java$/,
    },
    testng: true,
  },
};
