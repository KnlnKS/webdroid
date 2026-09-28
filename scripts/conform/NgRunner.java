import java.util.Arrays;
import org.testng.ITestResult;
import org.testng.TestListenerAdapter;
import org.testng.TestNG;

/** ConformRunner's counterpart for TestNG classes: one line per test and data row. */
public final class NgRunner {
    public static String run(String className, final String filter) throws Exception {
        final StringBuilder out = new StringBuilder();
        TestNG ng = new TestNG(false);
        ng.setTestClasses(new Class<?>[] {Class.forName(className)});
        ng.setVerbose(0);
        ng.addListener(new TestListenerAdapter() {
            private void line(char status, ITestResult r) {
                String name = r.getMethod().getMethodName() + Arrays.deepToString(r.getParameters()) + "(" + r.getTestClass().getName() + ")";
                if (filter != null && !filter.isEmpty() && !name.contains(filter)) return;
                out.append(status).append('\t').append(name.replace('\n', ' ').replace('\t', ' '));
                if (status == 'F') out.append('\t').append(String.valueOf(r.getThrowable()).replace('\n', ' ').replace('\t', ' '));
                out.append('\n');
            }
            @Override public void onTestSuccess(ITestResult r) { line('P', r); }
            @Override public void onTestFailure(ITestResult r) { line('F', r); }
            @Override public void onTestSkipped(ITestResult r) { line('S', r); }
            @Override public void onTestFailedButWithinSuccessPercentage(ITestResult r) { line('F', r); }
        });
        ng.run();
        return out.toString();
    }
}
