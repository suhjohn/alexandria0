package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/johnsuh/modernfiction/server/internal/models"
)

const (
	sessionCookieName = "session_id"
	magicLinkTTL      = 15 * time.Minute
	sessionTTL        = 30 * 24 * time.Hour
)

type AuthHandler struct {
	users   *models.UserRepository
	tokens  *models.MagicLinkTokenRepository
	sessions *models.SessionRepository
	resendAPIKey string
	resendFrom   string
	appURL       string
	apiURL       string
	isProduction bool
	httpClient   *http.Client
}

type magicLinkRequest struct {
	Email string `json:"email"`
}

type authUserResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

func NewAuthHandler(
	users *models.UserRepository,
	tokens *models.MagicLinkTokenRepository,
	sessions *models.SessionRepository,
) *AuthHandler {
	appURL := strings.TrimSpace(os.Getenv("APP_URL"))
	if appURL == "" {
		appURL = "http://localhost:3000"
	}
	apiURL := strings.TrimSpace(os.Getenv("API_PUBLIC_URL"))
	if apiURL == "" {
		apiURL = "http://localhost:8080"
	}
	return &AuthHandler{
		users:         users,
		tokens:        tokens,
		sessions:      sessions,
		resendAPIKey:  strings.TrimSpace(os.Getenv("RESEND_API_KEY")),
		resendFrom:    strings.TrimSpace(os.Getenv("RESEND_FROM")),
		appURL:        appURL,
		apiURL:        strings.TrimRight(apiURL, "/"),
		isProduction:  strings.EqualFold(os.Getenv("APP_ENV"), "production"),
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}
}

func (h *AuthHandler) RequestMagicLink(w http.ResponseWriter, r *http.Request) {
	var req magicLinkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	email := models.NormalizeEmail(req.Email)
	if !isValidEmail(email) {
		http.Error(w, "Invalid email", http.StatusBadRequest)
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

	token, err := generateToken()
	if err != nil {
		http.Error(w, "Failed to generate token", http.StatusInternalServerError)
		return
	}
	tokenHash := hashToken(token)
	expiresAt := time.Now().Add(magicLinkTTL)

	if err := h.tokens.Create(r.Context(), user.ID, tokenHash, expiresAt); err != nil {
		http.Error(w, "Failed to create magic link", http.StatusInternalServerError)
		return
	}

	verifyURL := fmt.Sprintf("%s/auth/verify?token=%s", h.apiURL, url.QueryEscape(token))
	if err := h.sendMagicLinkEmail(r.Context(), email, verifyURL); err != nil {
		http.Error(w, "Failed to send email", http.StatusBadGateway)
		return
	}

	w.WriteHeader(http.StatusAccepted)
}

func (h *AuthHandler) VerifyMagicLink(w http.ResponseWriter, r *http.Request) {
	rawToken := strings.TrimSpace(r.URL.Query().Get("token"))
	if rawToken == "" {
		http.Error(w, "Missing token", http.StatusBadRequest)
		return
	}

	tokenHash := hashToken(rawToken)
	userID, err := h.tokens.Consume(r.Context(), tokenHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, "Invalid or expired token", http.StatusBadRequest)
			return
		}
		http.Error(w, "Failed to verify token", http.StatusInternalServerError)
		return
	}

	sessionID := uuid.New()
	expiresAt := time.Now().Add(sessionTTL)
	if err := h.sessions.Create(r.Context(), sessionID, *userID, expiresAt); err != nil {
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

	http.Redirect(w, r, h.appURL, http.StatusFound)
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	user, err := h.CurrentUser(r)
	if err != nil {
		http.Error(w, "Failed to load session", http.StatusInternalServerError)
		return
	}
	if user == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	respondJSON(w, authUserResponse{ID: user.ID.String(), Email: user.Email})
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(sessionCookieName)
	if err == nil {
		if sessionID, parseErr := uuid.Parse(cookie.Value); parseErr == nil {
			_ = h.sessions.Delete(r.Context(), sessionID)
		}
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   h.isProduction,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})

	w.WriteHeader(http.StatusNoContent)
}

func (h *AuthHandler) CurrentUser(r *http.Request) (*models.User, error) {
	authService := NewAuthService(h.users, h.sessions)
	return authService.CurrentUser(r)
}

func (h *AuthHandler) sendMagicLinkEmail(ctx context.Context, email, verifyURL string) error {
	if h.resendAPIKey == "" || h.resendFrom == "" {
		return errors.New("Resend not configured")
	}

	payload := map[string]any{
		"from":    h.resendFrom,
		"to":      []string{email},
		"subject": "Your sign-in link",
		"html": fmt.Sprintf(
			`<p>Use this link to sign in:</p><p><a href="%s">%s</a></p>`,
			verifyURL,
			verifyURL,
		),
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"https://api.resend.com/emails",
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+h.resendAPIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Resend returned status %d", resp.StatusCode)
	}
	return nil
}

func isValidEmail(email string) bool {
	if email == "" || len(email) > 320 {
		return false
	}
	at := strings.Index(email, "@")
	return at > 0 && at < len(email)-1
}

func generateToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
