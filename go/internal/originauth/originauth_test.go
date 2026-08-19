package originauth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func request(remoteAddr string, header map[string]string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8064/health", nil)
	req.RemoteAddr = remoteAddr
	for key, value := range header {
		req.Header.Set(key, value)
	}
	return req
}

func TestRequestIsRemote(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string
		header     map[string]string
		want       bool
	}{
		{"loopback v4", "127.0.0.1:51000", nil, false},
		{"loopback v6", "[::1]:51000", nil, false},
		{"v4-mapped loopback", "::ffff:127.0.0.1:51000", nil, false},
		{"tailnet peer", "100.64.0.7:51000", nil, true},
		// Serve proxies from loopback, so the forwarded header is the only signal.
		{"forwarded from loopback", "127.0.0.1:51000", map[string]string{"X-Forwarded-For": "100.64.0.7"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RequestIsRemote(request(tc.remoteAddr, tc.header)); got != tc.want {
				t.Fatalf("RequestIsRemote = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBrowserOriginAllowed(t *testing.T) {
	exposure := &Exposure{Active: true, TSOrigin: "https://mac.tail1234.ts.net"}
	const web = "https://codingcube.codyh.xyz"

	cases := []struct {
		name   string
		origin string
		opts   OriginOptions
		want   bool
	}{
		{"no origin is same-origin", "", OriginOptions{WebOrigin: web}, true},
		{"loopback page", "http://127.0.0.1:8064", OriginOptions{WebOrigin: web}, true},
		{"localhost page", "http://localhost:5173", OriginOptions{WebOrigin: web}, true},
		{"the hosted cube", web, OriginOptions{WebOrigin: web}, true},
		{"the serve origin", exposure.TSOrigin, OriginOptions{WebOrigin: web, Exposure: exposure}, true},
		{"a stranger", "https://evil.example", OriginOptions{WebOrigin: web}, false},
		// The Host header may only widen access for a request that already has to present
		// a pairing code. Trusting it on a loopback socket would let any site reach the
		// shells by rebinding its DNS.
		{"host match, remote", "https://mac.tail1234.ts.net", OriginOptions{WebOrigin: web, RequestHost: "mac.tail1234.ts.net", Remote: true}, true},
		{"host match, but local", "https://mac.tail1234.ts.net", OriginOptions{WebOrigin: web, RequestHost: "mac.tail1234.ts.net", Remote: false}, false},
		{"garbage", "not a url", OriginOptions{WebOrigin: web}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := BrowserOriginAllowed(tc.origin, tc.opts); got != tc.want {
				t.Fatalf("BrowserOriginAllowed(%q) = %v, want %v", tc.origin, got, tc.want)
			}
		})
	}
}

type fakeIdentity struct {
	headerOK bool
	peerOK   bool
}

func (f fakeIdentity) IdentifyHeaders(http.Header) bool { return f.headerOK }
func (f fakeIdentity) Identify(string) bool             { return f.peerOK }

func TestRequestAuthorized(t *testing.T) {
	const token = "s3cret-token-value-1234"
	const web = "https://codingcube.codyh.xyz"
	withToken, _ := url.Parse("/health?token=" + token)
	noToken, _ := url.Parse("/health")
	wrongToken, _ := url.Parse("/health?token=nope-nope-nope-nope")

	cases := []struct {
		name string
		req  *http.Request
		url  *url.URL
		opts Options
		want bool
	}{
		{
			name: "no token configured is open",
			req:  request("100.64.0.7:1", nil), url: noToken,
			opts: Options{WebOrigin: web}, want: true,
		},
		{
			name: "local tool, no origin",
			req:  request("127.0.0.1:1", nil), url: noToken,
			opts: Options{WebOrigin: web, Token: token}, want: true,
		},
		{
			name: "locally served page",
			req:  request("127.0.0.1:1", map[string]string{"Origin": "http://127.0.0.1:8064"}), url: noToken,
			opts: Options{WebOrigin: web, Token: token}, want: true,
		},
		{
			// The hosted page is cross-origin even from loopback: it must present the code.
			name: "hosted page from loopback without a code",
			req:  request("127.0.0.1:1", map[string]string{"Origin": web}), url: noToken,
			opts: Options{WebOrigin: web, Token: token}, want: false,
		},
		{
			name: "hosted page with the code",
			req:  request("127.0.0.1:1", map[string]string{"Origin": web}), url: withToken,
			opts: Options{WebOrigin: web, Token: token}, want: true,
		},
		{
			name: "remote with the code",
			req:  request("100.64.0.7:1", nil), url: withToken,
			opts: Options{WebOrigin: web, Token: token}, want: true,
		},
		{
			name: "remote with the wrong code and no tailnet",
			req:  request("100.64.0.7:1", nil), url: wrongToken,
			opts: Options{WebOrigin: web, Token: token}, want: false,
		},
		{
			// Serve strips spoofed identity headers and proxies from loopback.
			name: "serve identity header",
			req:  request("127.0.0.1:1", map[string]string{"X-Forwarded-For": "100.64.0.7", "Tailscale-User-Login": "cody@example.com"}), url: noToken,
			opts: Options{WebOrigin: web, Token: token, Tailnet: fakeIdentity{headerOK: true}}, want: true,
		},
		{
			name: "direct tailnet peer via whois",
			req:  request("100.64.0.7:1", nil), url: noToken,
			opts: Options{WebOrigin: web, Token: token, Tailnet: fakeIdentity{peerOK: true}}, want: true,
		},
		{
			// Hosted cross-origin requests must use Serve so identity headers are present;
			// a whois hit must not substitute for the code here.
			name: "hosted origin cannot fall back to whois",
			req:  request("100.64.0.7:1", map[string]string{"Origin": web}), url: noToken,
			opts: Options{WebOrigin: web, Token: token, Tailnet: fakeIdentity{peerOK: true}}, want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RequestAuthorized(tc.req, tc.url, tc.opts); got != tc.want {
				t.Fatalf("RequestAuthorized = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTrustedForSecrets(t *testing.T) {
	const token = "s3cret-token-value-1234"
	withToken, _ := url.Parse("/api/host/info?token=" + token)
	noToken, _ := url.Parse("/api/host/info")

	if !TrustedForSecrets(request("127.0.0.1:1", nil), noToken, token) {
		t.Fatal("a same-origin local request should be trusted with the code")
	}
	if TrustedForSecrets(request("100.64.0.7:1", nil), noToken, token) {
		t.Fatal("a remote request without the code must not receive it")
	}
	if !TrustedForSecrets(request("100.64.0.7:1", map[string]string{"Origin": "https://codingcube.codyh.xyz"}), withToken, token) {
		t.Fatal("a cross-origin request that already holds the code may read it back")
	}
	if TrustedForSecrets(request("127.0.0.1:1", map[string]string{"Origin": "https://evil.example"}), noToken, token) {
		t.Fatal("a cross-origin request without the code must not receive it")
	}
}

func TestTokensMatch(t *testing.T) {
	if !TokensMatch("abc", "abc") {
		t.Fatal("equal tokens must match")
	}
	if TokensMatch("", "abc") || TokensMatch("abcd", "abc") || TokensMatch("abc", "abcd") {
		t.Fatal("unequal tokens must not match")
	}
}
