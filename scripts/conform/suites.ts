/** conformance suites: Maven jars to fetch, optional test sources to compile (an AOSP gitiles
 *  archive of the reference build's tag), and the JUnit classes to run (for sources, every
 *  class whose file name matches `tests`) */
type Suite = { maven: string[]; source?: { archive: string; root: string; tests: RegExp; include?: RegExp; exclude?: RegExp }; classes?: string[]; testng?: boolean };
const JUNIT = ["junit:junit:4.13.2", "org.hamcrest:hamcrest-core:1.3"];
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
      archive: "https://codeload.github.com/LineageOS/android_libcore/tar.gz/81bfea828bc7dc432103cec1331bd6587d98f0a1",
      root: "android_libcore-81bfea828bc7dc432103cec1331bd6587d98f0a1",
      include: /^((harmony-tests\/src\/test\/java\/org\/apache\/harmony\/tests\/java|luni\/src\/test\/java\/libcore\/java)\/(io|util\/zip)|support\/src\/test\/java\/(tests\/support|org\/apache\/harmony\/testframework|libcore\/testing\/io)|test-rules\/src\/main\/java\/libcore\/junit)\/|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^(?!Support_|Abstract)\w+Test\.java$/,
      // these name platform members android.jar lacks, jdk.internal, mockito or junitparams
      exclude: /(harmony\/tests\/java\/io\/Fil(e|ter)OutputStreamTest|harmony\/tests\/java\/util\/zip\/Zip(File|OutputStream)Test|libcore\/java\/io\/(Console|FileDescriptor|FileInputStream|File|ObjectStreamClassSuid)Test|Zip64FileTest|EnableDeprecatedBouncyCastleAlgorithmsRule)\.java$/,
    },
  },
  // libcore's java.net tests at the same commit, without those that open sockets or servers
  "luni-net": {
    maven: ["com.google.mockwebserver:mockwebserver:20130706", ...JUNIT],
    source: {
      archive: "https://codeload.github.com/LineageOS/android_libcore/tar.gz/81bfea828bc7dc432103cec1331bd6587d98f0a1",
      root: "android_libcore-81bfea828bc7dc432103cec1331bd6587d98f0a1",
      include: /^((harmony-tests\/src\/test\/java\/org\/apache\/harmony\/tests\/java|luni\/src\/test\/java\/libcore\/java)\/net|support\/src\/test\/java\/(tests\/support|org\/apache\/harmony\/testframework|libcore\/testing\/io)|test-rules\/src\/main\/java\/libcore\/junit)\/|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^(?!Support_|Abstract)\w+Test\.java$/,
      exclude: /\/net\/(\w*(Datagram|Multicast|ServerSocket|SocketImpl|JarURLConnection|URLClassLoader|NetworkInterface)\w*|(Old)?Socket(Timeout)?Test|OldSocketTest\w*|OldUnixSocketTest|InterfaceAddressTest|InetAddressThreadTest|ConcurrentCloseTest|FtpURLConnectionTest|URLConnectionTest|DelegatingSocketFactory|OldCookieHandlerTest)\.java$|libcore\/java\/net\/InetAddressTest\.java$|harmony\/tests\/java\/net\/URLDecoderTest\.java$|EnableDeprecatedBouncyCastleAlgorithmsRule\.java$/,
    },
  },
  // libcore's java.nio.file tests at the same commit, without those needing mockito, junitparams or
  // hidden sun.nio.fs classes
  "luni-nio-file": {
    maven: JUNIT,
    source: {
      archive: "https://codeload.github.com/LineageOS/android_libcore/tar.gz/81bfea828bc7dc432103cec1331bd6587d98f0a1",
      root: "android_libcore-81bfea828bc7dc432103cec1331bd6587d98f0a1",
      include: /^(luni\/src\/test\/java\/(libcore|tests)\/java\/nio\/file|test-rules\/src\/main\/java\/libcore\/junit)\/|\/libcore\/libcore\/util\/SerializationTester\.java$/,
      tests: /^\w+Test\.java$/,
      exclude: /\/nio\/file\/(Files2?Test|SimpleFileVisitorTest|DefaultFileSystemProvider2Test|FileSystemsTest|LinuxFileSystemTest|LinuxPathTest|spi\/FileTypeDetectorTest)\.java$|EnableDeprecatedBouncyCastleAlgorithmsRule\.java$/,
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
