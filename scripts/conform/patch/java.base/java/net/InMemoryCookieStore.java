package java.net;

import java.util.List;

public class InMemoryCookieStore implements CookieStore {
    public InMemoryCookieStore(int targetSdkVersion) { throw new UnsupportedOperationException(); }
    public void add(URI uri, HttpCookie cookie) { throw new UnsupportedOperationException(); }
    public List<HttpCookie> get(URI uri) { throw new UnsupportedOperationException(); }
    public List<HttpCookie> getCookies() { throw new UnsupportedOperationException(); }
    public List<URI> getURIs() { throw new UnsupportedOperationException(); }
    public boolean remove(URI uri, HttpCookie cookie) { throw new UnsupportedOperationException(); }
    public boolean removeAll() { throw new UnsupportedOperationException(); }
}
