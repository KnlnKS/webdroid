package libcore.test.annotation;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

/** Compile-time stand-in for libcore's test-selection annotation; conform runs every test. */
@Retention(RetentionPolicy.RUNTIME)
public @interface NonMts { long bug() default 0; String reason() default ""; int disabledUntilSdk() default 0; }
