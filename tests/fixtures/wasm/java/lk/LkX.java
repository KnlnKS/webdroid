/** HotSpot's verifier loads every catch type, so this class is only for the tier under test: ART skips a handler whose exception class cannot be resolved */
public class LkX {
  static String catchGone() { try { throw new RuntimeException("x"); } catch (LkGoneEx e) { return "gone"; } catch (RuntimeException e) { return "rte"; } }
}
