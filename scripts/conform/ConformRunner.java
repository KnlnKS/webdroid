import java.util.HashSet;
import java.util.Set;
import org.junit.runner.Description;
import org.junit.runner.JUnitCore;
import org.junit.runner.Request;
import org.junit.runner.manipulation.Filter;
import org.junit.runner.notification.Failure;
import org.junit.runner.notification.RunListener;

/** Runs one JUnit class (a suite() method or test class) and reports each test as a line:
 *  "P\tname", "F\tname\tmessage" or "S\tname". */
public final class ConformRunner {
    public static String run(String className, final String filter) throws Exception {
        final StringBuilder out = new StringBuilder();
        Request request = Request.aClass(Class.forName(className));
        if (filter != null && !filter.isEmpty()) request = request.filterWith(new Filter() {
            @Override public boolean shouldRun(Description d) {
                if (d.isTest()) return d.getDisplayName().contains(filter);
                for (Description child : d.getChildren()) if (shouldRun(child)) return true;
                return false;
            }
            @Override public String describe() { return filter; }
        });
        JUnitCore core = new JUnitCore();
        core.addListener(new RunListener() {
            final Set<Description> failed = new HashSet<>();
            @Override public void testFailure(Failure f) {
                failed.add(f.getDescription());
                String message = f.getException() == null ? "" : f.getException().toString();
                out.append("F\t").append(f.getDescription().getDisplayName()).append('\t')
                        .append(message.replace('\n', ' ').replace('\t', ' ')).append('\n');
            }
            @Override public void testAssumptionFailure(Failure f) { failed.add(f.getDescription()); }
            @Override public void testIgnored(Description d) { out.append("S\t").append(d.getDisplayName()).append('\n'); }
            @Override public void testFinished(Description d) {
                if (!failed.contains(d)) out.append("P\t").append(d.getDisplayName()).append('\n');
            }
        });
        core.run(request);
        return out.toString();
    }
}
