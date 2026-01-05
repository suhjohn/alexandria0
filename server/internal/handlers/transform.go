package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/johnsuh/modernfiction/server/internal/models"
	"github.com/johnsuh/modernfiction/server/internal/storage"
)

const defaultTransformAPIBaseURL = "https://suhjohn--modernfiction-api-fastapi-app.modal.run"

type BookTransformHandler struct {
	repo    *models.BookRepository
	jobRepo *models.TransformJobRepository
	r2      *storage.R2Client
	auth    CurrentUserProvider
	baseURL string
	apiKey  string
	client  *http.Client
}

type startTransformRequest struct {
	Type   string `json:"type,omitempty"`
	Lang   string `json:"lang,omitempty"`
	Prompt string `json:"prompt,omitempty"`
}

type transformRequest struct {
	SourceKey string `json:"source_key"`
	DestKey   string `json:"dest_key,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
}

type transformResponse struct {
	CallID  string `json:"call_id"`
	DestKey string `json:"dest_key"`
	URL     string `json:"url,omitempty"`
}

type bookTransformResponse struct {
	Status    string `json:"status"`
	DestKey   string `json:"dest_key"`
	URL       string `json:"url,omitempty"`
	CallID    string `json:"call_id,omitempty"`
	Error     string `json:"error,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

func NewBookTransformHandler(
	repo *models.BookRepository,
	jobRepo *models.TransformJobRepository,
	r2 *storage.R2Client,
	auth CurrentUserProvider,
	baseURL, apiKey string,
) *BookTransformHandler {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultTransformAPIBaseURL
	}
	return &BookTransformHandler{
		repo:    repo,
		jobRepo: jobRepo,
		r2:      r2,
		auth:    auth,
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (h *BookTransformHandler) StartTransform(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(h.apiKey) == "" {
		http.Error(w, "Transform API key not configured", http.StatusInternalServerError)
		return
	}

	bookID, err := parseBookID(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	book, err := h.repo.GetByID(r.Context(), bookID)
	if err != nil {
		http.Error(w, "Failed to fetch book", http.StatusInternalServerError)
		return
	}
	if book == nil {
		http.Error(w, "Book not found", http.StatusNotFound)
		return
	}

	if err := h.ensureAccess(r, book); err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}

	reqVariant := strings.TrimSpace(r.URL.Query().Get("type"))
	if reqVariant == "" {
		reqVariant = strings.TrimSpace(r.URL.Query().Get("variant"))
	}
	reqLang := strings.TrimSpace(r.URL.Query().Get("lang"))

	var req startTransformRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(reqVariant) == "" {
		reqVariant = strings.TrimSpace(req.Type)
	}
	if strings.TrimSpace(reqLang) == "" {
		reqLang = strings.TrimSpace(req.Lang)
	}

	variantKey, variantErr := parseTransformVariantKey(reqVariant, reqLang)
	if variantErr != nil {
		http.Error(w, variantErr.Error(), http.StatusBadRequest)
		return
	}

	url := transformURLFromBook(book, variantKey)
	if url != "" {
		destKey := transformEPUBKey(book.ID, variantKey)
		if h.r2 != nil {
			if key, ok := h.r2.KeyFromPublicURL(url); ok {
				destKey = key
			}
		}
		respondJSON(w, bookTransformResponse{
			Status:  "ready",
			DestKey: destKey,
			URL:     url,
		})
		return
	}

	sourceKey, err := sourceEPUBKeyFromBook(book, h.r2)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	destKey := transformDestKey(book.ID, sourceKey, variantKey)

	job, err := h.jobRepo.GetByBookVariant(r.Context(), book.ID, variantKey)
	if err == nil && job != nil && (job.Status == "pending" || job.Status == "running") {
		jobDestKey := job.DestKey
		if strings.TrimSpace(jobDestKey) == "" {
			jobDestKey = destKey
		}
		respondJSON(w, bookTransformResponse{
			Status:    job.Status,
			DestKey:   jobDestKey,
			CreatedAt: job.CreatedAt.UTC().Format(time.RFC3339),
			UpdatedAt: job.UpdatedAt.UTC().Format(time.RFC3339),
		})
		return
	}

	exists, err := h.r2.Exists(r.Context(), sourceKey)
	if err != nil {
		http.Error(w, "Failed to check source EPUB in R2", http.StatusBadGateway)
		return
	}
	if !exists {
		http.Error(w, "Source EPUB missing from R2", http.StatusBadGateway)
		return
	}

	prompt := strings.TrimSpace(req.Prompt)
	if strings.HasPrefix(variantKey, "translate_") {
		langForPrompt := strings.TrimSpace(reqLang)
		if langForPrompt == "" {
			langForPrompt = strings.ReplaceAll(strings.TrimPrefix(variantKey, "translate_"), "_", " ")
		}
		prompt = translatePrompt(langForPrompt)
	}

	modalReq := transformRequest{
		SourceKey: sourceKey,
		DestKey:   destKey,
		Prompt:    prompt,
	}

	respBody, status, err := h.postJSON(r, "/transform", modalReq)
	if err != nil {
		_, _ = h.jobRepo.Upsert(r.Context(), book.ID, variantKey, destKey, "error", err.Error())
		http.Error(w, err.Error(), status)
		return
	}

	var modalResp transformResponse
	if err := json.Unmarshal(respBody, &modalResp); err != nil {
		http.Error(w, "Failed to parse transform response", http.StatusBadGateway)
		return
	}

	job, err = h.jobRepo.Upsert(r.Context(), book.ID, variantKey, destKey, "running", "")
	if err != nil {
		http.Error(w, "Failed to persist transform job", http.StatusInternalServerError)
		return
	}

	createdAt := ""
	updatedAt := ""
	if job != nil {
		createdAt = job.CreatedAt.UTC().Format(time.RFC3339)
		updatedAt = job.UpdatedAt.UTC().Format(time.RFC3339)
	}
	respondJSON(w, bookTransformResponse{
		Status:    "running",
		DestKey:   destKey,
		URL:       modalResp.URL,
		CallID:    modalResp.CallID,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	})
}

func (h *BookTransformHandler) GetTransform(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(h.apiKey) == "" {
		http.Error(w, "Transform API key not configured", http.StatusInternalServerError)
		return
	}

	bookID, err := parseBookID(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	book, err := h.repo.GetByID(r.Context(), bookID)
	if err != nil {
		http.Error(w, "Failed to fetch book", http.StatusInternalServerError)
		return
	}
	if book == nil {
		http.Error(w, "Book not found", http.StatusNotFound)
		return
	}

	if err := h.ensureAccess(r, book); err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}

	reqVariant := strings.TrimSpace(r.URL.Query().Get("type"))
	if reqVariant == "" {
		reqVariant = strings.TrimSpace(r.URL.Query().Get("variant"))
	}
	reqLang := strings.TrimSpace(r.URL.Query().Get("lang"))
	variantKey, variantErr := parseTransformVariantKey(reqVariant, reqLang)
	if variantErr != nil {
		http.Error(w, variantErr.Error(), http.StatusBadRequest)
		return
	}

	url := transformURLFromBook(book, variantKey)
	if url != "" {
		destKey := transformEPUBKey(book.ID, variantKey)
		if h.r2 != nil {
			if key, ok := h.r2.KeyFromPublicURL(url); ok {
				destKey = key
			}
		}
		respondJSON(w, bookTransformResponse{
			Status:  "ready",
			DestKey: destKey,
			URL:     url,
		})
		return
	}

	sourceKey, sourceKeyErr := sourceEPUBKeyFromBook(book, h.r2)
	destKeys := []string{transformEPUBKey(book.ID, variantKey)}
	if variantKey == "modernify" && sourceKeyErr == nil && strings.TrimSpace(sourceKey) != "" {
		destKeys = append([]string{modernifyDestKeyFromSourceKey(sourceKey)}, destKeys...)
	}

	job, err := h.jobRepo.GetByBookVariant(r.Context(), book.ID, variantKey)
	if err != nil {
		http.Error(w, "Failed to load transform status", http.StatusInternalServerError)
		return
	}
	if job != nil && job.Status == "error" {
		destKey := job.DestKey
		if strings.TrimSpace(destKey) == "" {
			destKey = destKeys[0]
		}
		respondJSON(w, bookTransformResponse{
			Status:    "error",
			DestKey:   destKey,
			Error:     job.LastError,
			CreatedAt: job.CreatedAt.UTC().Format(time.RFC3339),
			UpdatedAt: job.UpdatedAt.UTC().Format(time.RFC3339),
		})
		return
	}
	if job != nil && (job.Status == "pending" || job.Status == "running") {
		destKey := job.DestKey
		if strings.TrimSpace(destKey) == "" {
			destKey = destKeys[0]
		}
		respondJSON(w, bookTransformResponse{
			Status:    job.Status,
			DestKey:   destKey,
			CreatedAt: job.CreatedAt.UTC().Format(time.RFC3339),
			UpdatedAt: job.UpdatedAt.UTC().Format(time.RFC3339),
		})
		return
	}

	var resolvedDestKey string
	for _, key := range destKeys {
		ready, err := h.r2.Exists(r.Context(), key)
		if err == nil && ready {
			resolvedDestKey = key
			break
		}
	}

	if resolvedDestKey != "" {
		url := h.r2.PublicURL(resolvedDestKey)
		if err := h.repo.SetTransformURLs(r.Context(), book.ID, variantKey, []string{url}); err != nil {
			http.Error(w, "Failed to update transformation data", http.StatusInternalServerError)
			return
		}
		_, _ = h.jobRepo.Upsert(r.Context(), book.ID, variantKey, resolvedDestKey, "completed", "")
		respondJSON(w, bookTransformResponse{
			Status:  "ready",
			DestKey: resolvedDestKey,
			URL:     url,
		})
		return
	}

	respondJSON(w, bookTransformResponse{
		Status:  "not_started",
		DestKey: destKeys[0],
	})
}

func (h *BookTransformHandler) postJSON(
	r *http.Request,
	path string,
	payload any,
) ([]byte, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, http.StatusInternalServerError, errors.New("Failed to serialize request")
	}

	req, err := http.NewRequestWithContext(
		r.Context(),
		http.MethodPost,
		h.baseURL+path,
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, http.StatusInternalServerError, errors.New("Failed to create request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", h.apiKey)

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, errors.New("Failed to reach transform service")
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, http.StatusBadGateway, errors.New("Failed to read transform response")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, http.StatusBadGateway, errors.New("Transform service returned an error")
	}

	return respBody, http.StatusOK, nil
}

func (h *BookTransformHandler) StartWorker(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 20 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.processJobs(ctx)
		}
	}
}

func (h *BookTransformHandler) processJobs(ctx context.Context) {
	jobs, err := h.jobRepo.ListByStatus(ctx, []string{"pending", "running"}, 50)
	if err != nil {
		return
	}

	for _, job := range jobs {
		exists, err := h.r2.Exists(ctx, job.DestKey)
		if err != nil || !exists {
			continue
		}
		url := h.r2.PublicURL(job.DestKey)
		if err := h.repo.SetTransformURLs(ctx, job.BookID, job.Variant, []string{url}); err != nil {
			continue
		}
		_, _ = h.jobRepo.Upsert(ctx, job.BookID, job.Variant, job.DestKey, "completed", "")
	}
}

func (h *BookTransformHandler) ensureAccess(r *http.Request, book *models.Book) error {
	if h.auth == nil {
		return nil
	}
	user, err := h.auth.CurrentUser(r)
	if err != nil {
		return errors.New("Failed to load session")
	}

	var (
		userID *uuid.UUID
		email  string
	)
	if user != nil {
		userID = &user.ID
		email = user.Email
	}

	allowed, err := h.repo.HasAccess(r.Context(), book.ID, userID, email)
	if err != nil {
		return errors.New("Failed to verify access")
	}
	if !allowed {
		return errors.New("Access denied")
	}
	return nil
}

func parseBookID(r *http.Request) (uuid.UUID, error) {
	idParam := chi.URLParam(r, "id")
	if idParam == "" {
		return uuid.Nil, errors.New("Missing book id")
	}
	bookID, err := uuid.Parse(idParam)
	if err != nil {
		return uuid.Nil, errors.New("Invalid book id")
	}
	return bookID, nil
}

func modernifyEPUBKey(id uuid.UUID) string {
	return fmt.Sprintf("books/%s/modernify.epub", id.String())
}

func transformEPUBKey(id uuid.UUID, variant string) string {
	v := strings.TrimSpace(variant)
	if v == "" || v == "modernify" {
		return modernifyEPUBKey(id)
	}
	return fmt.Sprintf("books/%s/%s.epub", id.String(), v)
}

func modernifyDestKeyFromSourceKey(sourceKey string) string {
	key := strings.TrimSpace(sourceKey)
	if key == "" {
		return ""
	}
	if strings.HasSuffix(strings.ToLower(key), ".epub") && len(key) >= len(".epub") {
		key = key[:len(key)-len(".epub")]
	}
	return key + "_modernify.epub"
}

func respondJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

func transformURLFromBook(book *models.Book, variantKey string) string {
	if book.TransformationData == nil {
		return ""
	}
	urls := book.TransformationData[variantKey]
	if len(urls) > 0 && strings.TrimSpace(urls[0]) != "" {
		return urls[0]
	}
	return ""
}

func sourceEPUBKeyFromBook(book *models.Book, r2 *storage.R2Client) (string, error) {
	if book == nil || strings.TrimSpace(book.URL) == "" {
		return "", errors.New("Book has no source URL")
	}
	if r2 != nil {
		if key, ok := r2.KeyFromPublicURL(book.URL); ok {
			return key, nil
		}
	}
	return "", errors.New("Book URL is not an R2 public URL")
}

func parseTransformVariantKey(transformType string, lang string) (string, error) {
	t := strings.TrimSpace(transformType)
	if t == "" {
		t = "modernify"
	}
	if t == "modernify" {
		return "modernify", nil
	}
	if strings.HasPrefix(t, "translate_") {
		suffix := strings.TrimSpace(strings.TrimPrefix(t, "translate_"))
		if suffix == "" {
			return "", errors.New("Missing translate language")
		}
		if len([]rune(suffix)) > 30 {
			return "", errors.New("Translate language must be less than 30 characters")
		}
		return "translate_" + suffix, nil
	}
	if t != "translate" {
		return "", errors.New("Unsupported transform type")
	}
	slug, err := normalizeTranslateLang(lang)
	if err != nil {
		return "", err
	}
	return "translate_" + slug, nil
}

func normalizeTranslateLang(lang string) (string, error) {
	raw := strings.TrimSpace(lang)
	if raw == "" {
		return "", errors.New("Missing translate language")
	}
	// Flexible input: just normalize whitespace to underscores and enforce a small length cap.
	slug := strings.Join(strings.Fields(raw), "_")
	if slug == "" {
		return "", errors.New("Missing translate language")
	}
	if len([]rune(slug)) > 30 {
		return "", errors.New("Translate language must be less than 30 characters")
	}
	if strings.Contains(slug, "/") || strings.Contains(slug, "\\") || strings.Contains(slug, "..") {
		return "", errors.New("Invalid translate language")
	}
	return slug, nil
}

func transformDestKey(bookID uuid.UUID, sourceKey string, variantKey string) string {
	if strings.TrimSpace(variantKey) == "" || variantKey == "modernify" {
		return modernifyDestKeyFromSourceKey(sourceKey)
	}
	if strings.HasPrefix(variantKey, "translate_") {
		return transformEPUBKey(bookID, variantKey)
	}
	return transformEPUBKey(bookID, variantKey)
}

func translatePrompt(lang string) string {
	target := strings.TrimSpace(lang)
	if target == "" {
		target = "the requested language"
	}
	return fmt.Sprintf(
		"Translate this text into %s while preserving the original meaning, tone, and proper nouns.",
		target,
	)
}
