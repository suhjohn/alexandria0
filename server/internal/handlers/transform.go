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
	Status  string `json:"status"`
	DestKey string `json:"dest_key"`
	URL     string `json:"url,omitempty"`
	CallID  string `json:"call_id,omitempty"`
	Error   string `json:"error,omitempty"`
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

	url := modernifyURLFromBook(book, modernifyEPUBKey(book.ID))
	if url != "" {
		respondJSON(w, bookTransformResponse{
			Status:  "ready",
			DestKey: modernifyEPUBKey(book.ID),
			URL:     url,
		})
		return
	}

	var req startTransformRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	sourceKey, err := sourceEPUBKeyFromBook(book, h.r2)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	destKey := modernifyEPUBKey(book.ID)

	job, err := h.jobRepo.GetByBookID(r.Context(), book.ID)
	if err == nil && job != nil && (job.Status == "pending" || job.Status == "running") {
		respondJSON(w, bookTransformResponse{
			Status:  job.Status,
			DestKey: destKey,
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

	modalReq := transformRequest{
		SourceKey: sourceKey,
		DestKey:   destKey,
		Prompt:    req.Prompt,
	}

	respBody, status, err := h.postJSON(r, "/transform", modalReq)
	if err != nil {
		_, _ = h.jobRepo.Upsert(r.Context(), book.ID, destKey, "error", err.Error())
		http.Error(w, err.Error(), status)
		return
	}

	var modalResp transformResponse
	if err := json.Unmarshal(respBody, &modalResp); err != nil {
		http.Error(w, "Failed to parse transform response", http.StatusBadGateway)
		return
	}

	_, err = h.jobRepo.Upsert(r.Context(), book.ID, destKey, "running", "")
	if err != nil {
		http.Error(w, "Failed to persist transform job", http.StatusInternalServerError)
		return
	}

	respondJSON(w, bookTransformResponse{
		Status:  "running",
		DestKey: destKey,
		URL:     modalResp.URL,
		CallID:  modalResp.CallID,
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

	url := modernifyURLFromBook(book, modernifyEPUBKey(book.ID))
	if url != "" {
		respondJSON(w, bookTransformResponse{
			Status:  "ready",
			DestKey: modernifyEPUBKey(book.ID),
			URL:     url,
		})
		return
	}

	destKey := modernifyEPUBKey(book.ID)
	job, err := h.jobRepo.GetByBookID(r.Context(), book.ID)
	if err != nil {
		http.Error(w, "Failed to load transform status", http.StatusInternalServerError)
		return
	}
	if job != nil && job.Status == "error" {
		respondJSON(w, bookTransformResponse{
			Status:  "error",
			DestKey: destKey,
			Error:   job.LastError,
		})
		return
	}
	if job != nil && (job.Status == "pending" || job.Status == "running") {
		respondJSON(w, bookTransformResponse{
			Status:  job.Status,
			DestKey: destKey,
		})
		return
	}

	ready, err := h.r2.Exists(r.Context(), destKey)
	if err == nil && ready {
		url := h.r2.PublicURL(destKey)
		if err := h.repo.SetTransformURLs(r.Context(), book.ID, "modernify", []string{url}); err != nil {
			http.Error(w, "Failed to update transformation data", http.StatusInternalServerError)
			return
		}
		_, _ = h.jobRepo.Upsert(r.Context(), book.ID, destKey, "completed", "")
		respondJSON(w, bookTransformResponse{
			Status:  "ready",
			DestKey: destKey,
			URL:     url,
		})
		return
	}

	respondJSON(w, bookTransformResponse{
		Status:  "pending",
		DestKey: destKey,
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
		if err := h.repo.SetTransformURLs(ctx, job.BookID, "modernify", []string{url}); err != nil {
			continue
		}
		_, _ = h.jobRepo.Upsert(ctx, job.BookID, job.DestKey, "completed", "")
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

func respondJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

func modernifyURLFromBook(book *models.Book, destKey string) string {
	if book.TransformationData == nil {
		return ""
	}
	urls := book.TransformationData["modernify"]
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
