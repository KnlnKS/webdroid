/** invokedynamic sites javac 9+ emits and d8 --no-desugaring keeps, which ART cannot link: StringConcatFactory is not in libcore and its LambdaMetafactory.metafactory returns null. */
public class Ind {
  public static int concat(int a) { String s = "x" + a; return s.length(); }
  public static int lambda(int a) { java.util.function.IntSupplier f = () -> a + 1; return f.getAsInt(); }
}
