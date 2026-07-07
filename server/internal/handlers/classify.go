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

	"github.com/google/uuid"

	"github.com/johnsuh/modernfiction/server/internal/models"
	"github.com/johnsuh/modernfiction/server/internal/storage"
)

type ClassificationWorker struct {
	bookRepo *models.BookRepository
	jobRepo  *models.ClassificationJobRepository
	r2       *storage.R2Client
	baseURL  string
	apiKey   string
	client   *http.Client
}

type classifyRequest struct {
	SourceKey string `json:"source_key"`
	CoverKey  string `json:"cover_key"`
}

type classifyResponse struct {
	Encrypted     bool    `json:"encrypted"`
	PageCount     int     `json:"page_count"`
	HasTextLayer  bool    `json:"has_text_layer"`
	Title         *string `json:"title"`
	Author        *string `json:"author"`
	CoverUploaded bool    `json:"cover_uploaded"`
}

func NewClassificationWorker(
	bookRepo *models.BookRepository,
	jobRepo *models.ClassificationJobRepository,
	r2 *storage.R2Client,
	baseURL string,
	apiKey string,
) *ClassificationWorker {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultTransformAPIBaseURL
	}
	return &ClassificationWorker{
		bookRepo: bookRepo,
		jobRepo:  jobRepo,
		r2:       r2,
		baseURL:  strings.TrimRight(baseURL, "/"),
		apiKey:   apiKey,
		client: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

func (w *ClassificationWorker) StartWorker(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.processJobs(ctx)
		}
	}
}

func (w *ClassificationWorker) processJobs(ctx context.Context) {
	if w.bookRepo == nil || w.jobRepo == nil || w.r2 == nil {
		return
	}

	jobs, err := w.jobRepo.ListByStatus(ctx, []string{"pending", "running"}, 50)
	if err != nil {
		return
	}

	staleRunningCutoff := time.Now().Add(-5 * time.Minute)
	for _, job := range jobs {
		if job.Status == "running" && job.UpdatedAt.After(staleRunningCutoff) {
			continue
		}
		w.processJob(ctx, job)
	}
}

func (w *ClassificationWorker) processJob(ctx context.Context, job models.ClassificationJob) {
	runningJob, err := w.jobRepo.Upsert(ctx, job.BookID, "running", "")
	if err != nil {
		return
	}
	if runningJob == nil {
		return
	}

	sourceKey := storage.SourceKey(job.BookID, "pdf")
	coverKey := storage.BookCoverKey(job.BookID)
	resp, err := w.classify(ctx, classifyRequest{
		SourceKey: sourceKey,
		CoverKey:  coverKey,
	})
	if err != nil {
		w.recordClassificationFailure(ctx, job.BookID, runningJob.Attempts, err)
		return
	}
	if resp.Encrypted {
		_, _ = w.jobRepo.Upsert(ctx, job.BookID, "error", "PDF is password-protected")
		return
	}

	title := ""
	if resp.Title != nil {
		title = *resp.Title
	}
	author := ""
	if resp.Author != nil {
		author = *resp.Author
	}
	if err := w.bookRepo.SetClassification(ctx, job.BookID, resp.HasTextLayer, resp.PageCount, title, author); err != nil {
		w.recordClassificationFailure(ctx, job.BookID, runningJob.Attempts, err)
		return
	}
	if resp.CoverUploaded {
		if err := w.bookRepo.SetThumbnailURL(ctx, job.BookID, w.r2.PublicURL(coverKey)); err != nil {
			w.recordClassificationFailure(ctx, job.BookID, runningJob.Attempts, err)
			return
		}
	}
	_, _ = w.jobRepo.Upsert(ctx, job.BookID, "completed", "")
}

func (w *ClassificationWorker) classify(ctx context.Context, payload classifyRequest) (*classifyResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.baseURL+"/classify", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", w.apiKey)

	resp, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(respBody))
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return nil, fmt.Errorf("classification service returned %d: %s", resp.StatusCode, msg)
	}

	var out classifyResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (w *ClassificationWorker) recordClassificationFailure(
	ctx context.Context,
	bookID uuid.UUID,
	attempts int,
	err error,
) {
	if err == nil {
		err = errors.New("classification failed")
	}
	status := "pending"
	if attempts >= 5 {
		status = "error"
	}
	_, _ = w.jobRepo.Upsert(ctx, bookID, status, err.Error())
}
