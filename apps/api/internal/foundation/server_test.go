package foundation

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOriginAndRequestMetadata(t *testing.T) {
	app := (&Server{Origin: "https://fluxparcel.example"}).Handler()
	for _, origin := range []string{"", "https://another.example", "null"} {
		request := httptest.NewRequest(http.MethodPost, "/v1/auth/login", nil)
		request.Header.Set("Origin", origin)
		recorder := httptest.NewRecorder()
		app.ServeHTTP(recorder, request)
		if recorder.Code != 403 || recorder.Header().Get("X-Request-ID") == "" || recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unexpected origin response: %d %v", recorder.Code, recorder.Header())
		}
	}
	recorder := httptest.NewRecorder()
	app.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if recorder.Code != 200 {
		t.Fatalf("health: %d", recorder.Code)
	}
}

func TestReadJSONRejectsUnboundedOrAmbiguousInput(t *testing.T) {
	var input struct{ Value string }
	for _, body := range []string{`{"unknown":"x"}`, `{"value":"one"} {"value":"two"}`, `{"value":"` + strings.Repeat("x", 4096) + `"}`} {
		recorder := httptest.NewRecorder()
		if readJSON(recorder, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)), &input) || recorder.Code != 400 {
			t.Fatalf("unexpected result for body of size %d", len(body))
		}
	}
}

func TestPasswordsAndTokens(t *testing.T) {
	hash := hashPassword("synthetic test password")
	if !passwordMatches("synthetic test password", hash) || passwordMatches("other password", hash) {
		t.Fatal("password verification mismatch")
	}
	if string(hash) == string(hashPassword("synthetic test password")) {
		t.Fatal("password salts repeated")
	}
	first, second := token(), token()
	bytes, err := base64.RawURLEncoding.DecodeString(first)
	if err != nil || len(bytes) != 32 || first == second || len(digest(first)) != 32 {
		t.Fatal("unexpected token or digest format")
	}
}

func TestProductionCookies(t *testing.T) {
	recorder := httptest.NewRecorder()
	(&Server{SecureCookies: true}).setCookies(recorder, token(), token())
	cookies := recorder.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("got %d cookies", len(cookies))
	}
	for _, cookie := range cookies {
		if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Domain != "" {
			t.Fatal("session cookie missing protections")
		}
	}
	if cookies[0].Path != "/v1" || cookies[1].Path != "/v1/auth" {
		t.Fatal("unexpected credential scopes")
	}
}
