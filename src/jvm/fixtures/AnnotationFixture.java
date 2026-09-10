package webdroid;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@AnnotationFixture.Tag(type = AnnotationFixture.class, nested = @AnnotationFixture.Nested(9))
public class AnnotationFixture {
    public static Class<?> lookup(String name) throws ClassNotFoundException { return Class.forName(name); }
    public enum Mode { FIRST, SECOND }
    @Retention(RetentionPolicy.RUNTIME)
    public @interface Nested { int value(); }
    @Retention(RetentionPolicy.RUNTIME)
    public @interface Tag {
        Class<?> type();
        Nested nested();
        Mode mode() default Mode.SECOND;
    }
    @Tag(type = AnnotationFixture.class, nested = @Nested(7))
    public int value;
    @Tag(type = String.class, nested = @Nested(3))
    public void method(@Tag(type = Integer.class, nested = @Nested(5)) int parameter) {}
}
