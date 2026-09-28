/** conformance suites: Maven jars to fetch, optional test sources to compile (an AOSP gitiles
 *  archive of the reference build's tag), and the JUnit classes to run (for sources, every
 *  class whose file name matches `tests`) */
type Suite = { maven: string[]; source?: { archive: string; root: string; tests: RegExp }; classes?: string[] };
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
};
