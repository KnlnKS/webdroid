import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.lang.reflect.Constructor;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import org.testng.IAnnotationTransformer;
import org.testng.ITestContext;
import org.testng.ITestNGMethod;
import org.testng.annotations.DataProvider;
import org.testng.annotations.ITestAnnotation;
import org.testng.ITestResult;
import org.testng.TestListenerAdapter;
import org.testng.TestNG;

/** ConformRunner's counterpart for TestNG classes: one line per test and data row. */
public final class NgRunner {
    private static final String PROVIDERS = "NgRunner.arrayProviders";

    // TestNG 7.4 casts Iterator's element Type to Class. Android also represents
    // concrete array arguments as GenericArrayTypeImpl (ListOfTypes.resolveTypes).
    // A raw Iterator takes TestNG's row path without changing any reflected Type.
    @DataProvider(name = "arrayRows")
    @SuppressWarnings({"rawtypes", "unchecked"})
    public static Iterator arrayRows(ITestNGMethod test, ITestContext context) throws Throwable {
        Map<Method, Method> providers = (Map<Method, Method>) context.getAttribute(PROVIDERS);
        Method method = test.getConstructorOrMethod().getMethod();
        Method provider = providers.get(method);
        provider.setAccessible(true);
        try {
            return (Iterator) provider.invoke(test.getInstance());
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static Method arrayProvider(Class<?> cls, String name) {
        for (Class<?> owner = cls; owner != null; owner = owner.getSuperclass()) {
            for (Method method : owner.getDeclaredMethods()) {
                DataProvider annotation = method.getAnnotation(DataProvider.class);
                if (annotation == null || !name.equals(annotation.name().isEmpty() ? method.getName() : annotation.name())) continue;
                Type type = method.getGenericReturnType();
                if (!(type instanceof ParameterizedType) || method.getReturnType() != Iterator.class) return null;
                Type element = ((ParameterizedType) type).getActualTypeArguments()[0];
                if (!(element instanceof GenericArrayType)) return null;
                // The adapter preserves the default, zero-argument provider contract.
                // Leave other contracts to TestNG rather than silently dropping settings.
                if (method.getParameterTypes().length != 0 || annotation.parallel() || annotation.indices().length != 0) return null;
                return method;
            }
        }
        return null;
    }

    public static String run(String className, final String filter) throws Exception {
        final StringBuilder out = new StringBuilder();
        final Class<?> cls = Class.forName(className);
        final Map<Method, Method> providers = new HashMap<>();
        TestNG ng = new TestNG(false);
        ng.addListener(new IAnnotationTransformer() {
            @Override public void transform(ITestAnnotation annotation, Class testClass, Constructor constructor, Method method) {
                if (method == null || annotation.getDataProvider().isEmpty()) return;
                Class<?> owner = annotation.getDataProviderClass();
                if (owner != null && owner != Object.class) return;
                Method provider = arrayProvider(cls, annotation.getDataProvider());
                if (provider == null) return;
                providers.put(method, provider);
                annotation.setDataProviderClass(NgRunner.class);
                annotation.setDataProvider("arrayRows");
            }
        });
        ng.setTestClasses(new Class<?>[] {cls});
        ng.setVerbose(0);
        ng.addListener(new TestListenerAdapter() {
            @Override public void onStart(ITestContext context) { context.setAttribute(PROVIDERS, providers); }
            private void line(char status, ITestResult r) {
                String name = r.getMethod().getMethodName() + Arrays.deepToString(r.getParameters()) + "(" + r.getTestClass().getName() + ")";
                if (filter != null && !filter.isEmpty() && !name.contains(filter)) return;
                out.append(status).append('\t').append(name.replace('\n', ' ').replace('\t', ' '));
                if (status == 'F' || status == 'S' && (r.getThrowable() != null || providers.containsKey(r.getMethod().getConstructorOrMethod().getMethod()))) {
                    out.append('\t');
                    if (status == 'S' && providers.containsKey(r.getMethod().getConstructorOrMethod().getMethod())) out.append("array provider adapter: ");
                    out.append(String.valueOf(r.getThrowable()).replace('\n', ' ').replace('\t', ' '));
                }
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
