import java.io.*;
import java.util.HexFormat;
import java.util.ArrayList;
import java.util.HashSet;

public class SerializationProbe {
    public static final class Value implements Serializable {
        final long seconds;
        final int nanos;
        Value(long seconds, int nanos) { this.seconds = seconds; this.nanos = nanos; }
        private Object writeReplace() { return new Payload(this); }
    }
    public static final class Payload implements Externalizable {
        private static final long serialVersionUID = 7L;
        Value value;
        public Payload() {}
        Payload(Value value) { this.value = value; }
        public void writeExternal(ObjectOutput out) throws IOException {
            out.writeLong(value.seconds);
            out.writeInt(value.nanos);
            out.writeUTF("\u0000\ud83d\ude80");
            out.writeObject(this);
            out.writeInt(999);
        }
        public void readExternal(ObjectInput in) throws IOException, ClassNotFoundException {
            value = new Value(in.readLong(), in.readInt());
            if (!in.readUTF().equals("\u0000\ud83d\ude80") || in.readObject() != this) throw new IOException("bad payload");
        }
        private Object readResolve() { return value; }
    }
    public static class Base { public transient int initialized = 31; }
    public static final class Graph extends Base implements Serializable {
        public boolean flag = true;
        public byte small = -123;
        public char letter = '\uffff';
        public short medium = -32000;
        public int integer = 1234567;
        public long large = -987654321012345L;
        public float single = 1.25f;
        public double wide = -9.75;
        public Object cycle = this;
        public int[] numbers = { 17, -23 };
        public ArrayList<Object> list = new ArrayList<>();
        public HashSet<String> set = new HashSet<>();
        public Graph() { list.add("hello"); list.add(numbers); list.add(this); set.add("one"); set.add("two"); }
        private void writeObject(ObjectOutputStream out) throws IOException {
            out.defaultWriteObject(); out.writeInt(123);
        }
        private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
            in.defaultReadObject();
            if (in.readInt() != 123) throw new IOException("bad custom data");
        }
    }
    public static final class Replacing extends ObjectOutputStream {
        public int calls;
        public Replacing(OutputStream out) throws IOException { super(out); enableReplaceObject(true); }
        protected Object replaceObject(Object value) { calls++; return value.equals("first") ? "written" : value; }
    }
    public static final class Resolving extends ObjectInputStream {
        public int calls;
        public Resolving(InputStream in) throws IOException { super(in); enableResolveObject(true); }
        protected Object resolveObject(Object value) { calls++; return value.equals("written") ? "resolved" : value; }
    }
    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("graph")) {
            if (args.length == 1) {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                ObjectOutputStream out = new ObjectOutputStream(buffer);
                out.writeObject(new Graph()); out.close();
                System.out.println(HexFormat.of().formatHex(buffer.toByteArray()));
            } else {
                ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(HexFormat.of().parseHex(args[1])));
                Graph graph = (Graph) in.readObject();
                if (graph.cycle != graph || graph.list.get(2) != graph || graph.numbers != graph.list.get(1) || graph.initialized != 31 || graph.wide != -9.75) throw new AssertionError();
            }
            return;
        }
        byte[] bytes;
        if (args.length == 0) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            ObjectOutputStream out = new ObjectOutputStream(buffer);
            Value value = new Value(-17L, 123456789);
            out.writeObject(value);
            out.writeObject(value);
            out.close();
            bytes = buffer.toByteArray();
            System.out.println(HexFormat.of().formatHex(bytes));
        } else bytes = HexFormat.of().parseHex(args[0]);
        ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(bytes));
        Value first = (Value) in.readObject();
        if (first.seconds != -17L || first.nanos != 123456789 || in.readObject() != first) throw new AssertionError();
    }
}
