package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/johnsuh/modernfiction/server/internal/models"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

type googleUserInfo struct {
	Email         string `json:"email"`
	EmailVerified *bool  `json:"email_verified,omitempty"`
	Sub           string `json:"sub"`
}

func (h *AuthHandler) StartGoogleOAuth(w http.ResponseWriter, r *http.Request) {
	if !h.isGoogleOAuthConfigured() {
		http.Error(w, "Google OAuth not configured", http.StatusNotImplemented)
		return
	}

	redirect := sanitizeRedirect(r.URL.Query().Get("redirect"))
	state, err := generateToken()
	if err != nil {
		http.Error(w, "Failed to generate state", http.StatusInternalServerError)
		return
	}

	expiresAt := time.Now().Add(oauthStateTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookie,
		Value:    state,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.isProduction,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     oauthRedirCookie,
		Value:    url.QueryEscape(redirect),
		Path:     "/",
		HttpOnly: true,
		Secure:   h.isProduction,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
	})

	authURL := h.googleOAuthConfig().AuthCodeURL(
		state,
		oauth2.AccessTypeOnline,
		oauth2.SetAuthURLParam("prompt", "select_account"),
	)
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (h *AuthHandler) GoogleCallback(w http.ResponseWriter, r *http.Request) {
	if !h.isGoogleOAuthConfigured() {
		http.Error(w, "Google OAuth not configured", http.StatusNotImplemented)
		return
	}

	state := strings.TrimSpace(r.URL.Query().Get("state"))
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if state == "" || code == "" {
		http.Error(w, "Missing state or code", http.StatusBadRequest)
		return
	}

	stateCookie, err := r.Cookie(oauthStateCookie)
	if err != nil || strings.TrimSpace(stateCookie.Value) == "" {
		http.Error(w, "Missing OAuth state", http.StatusBadRequest)
		return
	}

	if stateCookie.Value != state {
		http.Error(w, "Invalid OAuth state", http.StatusBadRequest)
		return
	}

	redirectCookie, _ := r.Cookie(oauthRedirCookie)
	redirect := ""
	if redirectCookie != nil {
		redirect, _ = url.QueryUnescape(redirectCookie.Value)
	}

	h.clearOAuthCookies(w)

	ctx := context.WithValue(r.Context(), oauth2.HTTPClient, h.httpClient)
	token, err := h.googleOAuthConfig().Exchange(ctx, code)
	if err != nil {
		http.Error(w, "Failed to exchange code", http.StatusBadRequest)
		return
	}

	info, err := h.fetchGoogleUserInfo(ctx, token.AccessToken)
	if err != nil {
		http.Error(w, "Failed to fetch Google profile", http.StatusBadGateway)
		return
	}

	email := models.NormalizeEmail(info.Email)
	if !isValidEmail(email) {
		http.Error(w, "Google account has no valid email", http.StatusBadRequest)
		return
	}
	if info.EmailVerified != nil && !*info.EmailVerified {
		http.Error(w, "Google email not verified", http.StatusBadRequest)
		return
	}

	user, err := h.users.GetByEmail(r.Context(), email)
	if err != nil {
		http.Error(w, "Failed to look up user", http.StatusInternalServerError)
		return
	}
	if user == nil {
		user, err = h.users.Create(r.Context(), email)
		if err != nil {
			http.Error(w, "Failed to create user", http.StatusInternalServerError)
			return
		}
	}

	sessionID := uuid.New()
	expiresAt := time.Now().Add(sessionTTL)
	if err := h.sessions.Create(r.Context(), sessionID, user.ID, expiresAt); err != nil {
		http.Error(w, "Failed to create session", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sessionID.String(),
		Path:     "/",
		HttpOnly: true,
		Secure:   h.isProduction,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
	})

	http.Redirect(w, r, resolveAppRedirect(h.appURL, redirect), http.StatusFound)
}

func (h *AuthHandler) isGoogleOAuthConfigured() bool {
	return strings.TrimSpace(h.googleClientID) != "" &&
		strings.TrimSpace(h.googleClientSecret) != "" &&
		strings.TrimSpace(h.googleRedirectURI) != ""
}

func (h *AuthHandler) googleOAuthConfig() *oauth2.Config {
	return &oauth2.Config{
		ClientID:     h.googleClientID,
		ClientSecret: h.googleClientSecret,
		RedirectURL:  h.googleRedirectURI,
		Scopes:       []string{"openid", "email", "profile"},
		Endpoint:     google.Endpoint,
	}
}

func (h *AuthHandler) fetchGoogleUserInfo(ctx context.Context, accessToken string) (*googleUserInfo, error) {
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		"https://openidconnect.googleapis.com/v1/userinfo",
		nil,
	)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("unexpected userinfo status %d", resp.StatusCode)
	}
	var info googleUserInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return &info, nil
}

func (h *AuthHandler) clearOAuthCookies(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   h.isProduction,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     oauthRedirCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   h.isProduction,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
