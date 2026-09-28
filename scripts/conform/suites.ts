/** conformance suites: Maven jars to fetch and the JUnit classes to run */
export const SUITES = {
  guava: {
    maven: ["com.google.guava:guava-testlib:33.3.1-jre", "com.google.guava:guava:33.3.1-jre", "com.google.guava:failureaccess:1.0.2",
      "junit:junit:4.13.2", "org.hamcrest:hamcrest-core:1.3"],
    classes: ["com.google.common.collect.testing.TestsForListsInJavaUtil", "com.google.common.collect.testing.TestsForSetsInJavaUtil",
      "com.google.common.collect.testing.TestsForMapsInJavaUtil", "com.google.common.collect.testing.TestsForQueuesInJavaUtil"],
  },
};
