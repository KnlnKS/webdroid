package libcore.junit.util;

import org.junit.rules.TestRule;
import org.junit.runner.Description;
import org.junit.runners.model.Statement;

/** The real rule raises sun.security.jca.Providers' BC deprecation limit, which javac cannot reach
 *  from the unnamed module; tests run under the platform's own limit instead. */
public class EnableDeprecatedBouncyCastleAlgorithmsRule implements TestRule {
    public static TestRule getInstance() { return new EnableDeprecatedBouncyCastleAlgorithmsRule(); }
    @Override public Statement apply(Statement base, Description description) { return base; }
}
