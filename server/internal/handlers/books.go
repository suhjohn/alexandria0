package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/johnsuh/modernfiction/server/internal/models"
	"github.com/johnsuh/modernfiction/server/internal/storage"
)

type BooksHandler struct {
	repo *models.BookRepository
	auth CurrentUserProvider
	r2   *storage.R2Client
}

var errPersonalQuotaExceeded = errors.New("personal upload quota exceeded")

func NewBooksHandler(repo *models.BookRepository, auth CurrentUserProvider, r2 *storage.R2Client) *BooksHandler {
	return &BooksHandler{repo: repo, auth: auth, r2: r2}
}

func (h *BooksHandler) GetAll(w http.ResponseWriter, r *http.Request) {
	books, err := h.repo.GetAllPublic(r.Context())
	if err != nil {
		respondError(w, r, "Failed to fetch books", http.StatusInternalServerError, err)
		return
	}

	if books == nil {
		books = []models.Book{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(books)
}

func (h *BooksHandler) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		q = r.URL.Query().Get("query")
	}

	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "public"
	}

	limit := parseInt(r.URL.Query().Get("limit"), 50)
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	cursor, err := decodeCursor[models.BookCursor](r.URL.Query().Get("cursor"))
	if err != nil {
		respondError(w, r, "Invalid cursor", http.StatusBadRequest, err)
		return
	}

	var result *models.BookSearchResult
	switch scope {
	case "public":
		result, err = h.repo.SearchPublic(r.Context(), q, limit, cursor)
	case "personal":
		if h.auth == nil {
			respondError(w, r, "Unauthorized", http.StatusUnauthorized, nil)
			return
		}
		user, err := h.auth.CurrentUser(r)
		if err != nil {
			respondError(w, r, "Failed to resolve user", http.StatusInternalServerError, err)
			return
		}
		if user == nil {
			respondError(w, r, "Unauthorized", http.StatusUnauthorized, nil)
			return
		}
		result, err = h.repo.SearchPersonal(r.Context(), user.ID, user.Email, q, limit, cursor)
	default:
		respondError(w, r, "Invalid scope", http.StatusBadRequest, nil)
		return
	}
	if err != nil {
		respondError(w, r, "Failed to search books", http.StatusInternalServerError, err)
		return
	}

	var nextCursor *string
	if result.NextCursor != nil {
		raw, err := encodeCursor(*result.NextCursor)
		if err != nil {
			respondError(w, r, "Failed to encode cursor", http.StatusInternalServerError, err)
			return
		}
		nextCursor = &raw
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(CursorPageResponse[models.Book]{
		Items:      result.Books,
		Total:      result.Total,
		Limit:      limit,
		NextCursor: nextCursor,
	})
}

func (h *BooksHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	rawID := chi.URLParam(r, "id")
	bookID, err := uuid.Parse(rawID)
	if err != nil {
		respondError(w, r, "Invalid book id", http.StatusBadRequest, err)
		return
	}

	var userID *uuid.UUID
	email := ""
	if h.auth != nil {
		user, err := h.auth.CurrentUser(r)
		if err != nil {
			respondError(w, r, "Failed to resolve user", http.StatusInternalServerError, err)
			return
		}
		if user != nil {
			userID = &user.ID
			email = user.Email
		}
	}

	ok, err := h.repo.HasAccess(r.Context(), bookID, userID, email)
	if err != nil {
		respondError(w, r, "Failed to check book access", http.StatusInternalServerError, err)
		return
	}
	if !ok {
		respondError(w, r, "Book not found", http.StatusNotFound, nil)
		return
	}

	book, err := h.repo.GetByID(r.Context(), bookID)
	if err != nil {
		respondError(w, r, "Failed to fetch book", http.StatusInternalServerError, err)
		return
	}
	if book == nil {
		respondError(w, r, "Book not found", http.StatusNotFound, nil)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(book)
}

func (h *BooksHandler) GetFile(w http.ResponseWriter, r *http.Request) {
	if h.r2 == nil {
		respondError(w, r, "File storage unavailable", http.StatusBadGateway, nil)
		return
	}

	bookID, err := parseBookID(r)
	if err != nil {
		respondError(w, r, "Invalid book id", http.StatusBadRequest, err)
		return
	}

	var userID *uuid.UUID
	email := ""
	if h.auth != nil {
		user, err := h.auth.CurrentUser(r)
		if err != nil {
			respondError(w, r, "Failed to resolve user", http.StatusInternalServerError, err)
			return
		}
		if user != nil {
			userID = &user.ID
			email = user.Email
		}
	}

	ok, err := h.repo.HasAccess(r.Context(), bookID, userID, email)
	if err != nil {
		respondError(w, r, "Failed to check book access", http.StatusInternalServerError, err)
		return
	}
	if !ok {
		respondError(w, r, "Book not found", http.StatusNotFound, nil)
		return
	}

	book, err := h.repo.GetByID(r.Context(), bookID)
	if err != nil {
		respondError(w, r, "Failed to fetch book", http.StatusInternalServerError, err)
		return
	}
	if book == nil {
		respondError(w, r, "Book not found", http.StatusNotFound, nil)
		return
	}

	variant := strings.TrimSpace(r.URL.Query().Get("variant"))
	if variant == "" {
		variant = "original"
	}

	key, err := resolveBookFileKey(book, h.r2, variant)
	if err != nil {
		respondError(w, r, "Failed to resolve book file", http.StatusBadRequest, err)
		return
	}

	rc, meta, err := h.r2.Download(r.Context(), key)
	if err != nil {
		if errors.Is(err, storage.ErrObjectNotFound) {
			respondError(w, r, "Book file not found", http.StatusNotFound, err)
			return
		}
		respondError(w, r, "Failed to fetch book file", http.StatusBadGateway, err)
		return
	}
	defer rc.Close()

	w.Header().Set("Cache-Control", "private, max-age=0, no-store")
	if meta.ContentType != "" {
		w.Header().Set("Content-Type", meta.ContentType)
	} else {
		w.Header().Set("Content-Type", "application/epub+zip")
	}
	if meta.ContentLength > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(meta.ContentLength, 10))
	}
	filename := path.Base(key)
	if filename != "" {
		w.Header().Set("Content-Disposition", `inline; filename="`+filename+`"`)
	}

	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, rc)
}

func (h *BooksHandler) Upload(w http.ResponseWriter, r *http.Request) {
	if h.auth == nil {
		respondError(w, r, "Unauthorized", http.StatusUnauthorized, nil)
		return
	}
	if h.r2 == nil {
		respondError(w, r, "File storage unavailable", http.StatusBadGateway, nil)
		return
	}

	user, err := h.auth.CurrentUser(r)
	if err != nil {
		respondError(w, r, "Failed to resolve user", http.StatusInternalServerError, err)
		return
	}
	if user == nil {
		respondError(w, r, "Unauthorized", http.StatusUnauthorized, nil)
		return
	}

	const maxUploadBytes = int64(50 << 20) // 50MB
	const maxMemoryBytes = int64(10 << 20) // 10MB
	const maxPersonalLibraryBytes = int64(10) << 30 // 10GiB
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxMemoryBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) || strings.Contains(err.Error(), "request body too large") {
			respondError(w, r, "Upload too large (max 50MB)", http.StatusRequestEntityTooLarge, err)
			return
		}
		respondError(w, r, "Invalid upload payload", http.StatusBadRequest, err)
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		respondError(w, r, "Missing file", http.StatusBadRequest, err)
		return
	}
	defer file.Close()

	if header != nil && header.Size > 0 && header.Size > maxUploadBytes {
		respondError(w, r, "Upload too large (max 50MB)", http.StatusRequestEntityTooLarge, nil)
		return
	}
	if err := validateEPUBUpload(file, header); err != nil {
		respondError(w, r, err.Error(), http.StatusBadRequest, err)
		return
	}

	currentBytes, err := h.repo.TotalSourceBytesForUser(r.Context(), user.ID)
	if err != nil {
		respondError(w, r, "Failed to check upload quota", http.StatusInternalServerError, err)
		return
	}
	remainingBytes := maxPersonalLibraryBytes - currentBytes
	if remainingBytes <= 0 {
		respondError(w, r, "Personal library storage limit reached (10GB)", http.StatusRequestEntityTooLarge, nil)
		return
	}
	if header != nil && header.Size > 0 && header.Size > remainingBytes {
		respondError(w, r, "Personal library storage limit reached (10GB)", http.StatusRequestEntityTooLarge, nil)
		return
	}

	bookID := uuid.New()
	destKey := storage.SourceEPUBKey(bookID)
	contentLength := int64(0)
	if header != nil && header.Size > 0 {
		contentLength = header.Size
	}
	reader := &quotaReader{r: io.LimitReader(file, maxUploadBytes), maxBytes: remainingBytes}
	_, err = h.r2.UploadReader(r.Context(), reader, destKey, "application/epub+zip", contentLength)
	if err != nil {
		if errors.Is(err, errPersonalQuotaExceeded) {
			respondError(w, r, "Personal library storage limit reached (10GB)", http.StatusRequestEntityTooLarge, err)
			return
		}
		respondError(w, r, "Failed to store upload", http.StatusBadGateway, err)
		return
	}

	sourceSizeBytes := contentLength
	if sourceSizeBytes <= 0 {
		sourceSizeBytes = reader.bytesRead
	}

	title := strings.TrimSpace(r.FormValue("title"))
	if title == "" {
		title = strings.TrimSpace(strings.TrimSuffix(header.Filename, path.Ext(header.Filename)))
	}
	if title == "" {
		title = "Untitled"
	}

	book := &models.Book{
		ID:                 bookID,
		URL:                destKey,
		Title:              title,
		Authors:            []string{},
		ThumbnailURL:       "",
		TransformationData: map[string][]string{},
		SourceSizeBytes:    sourceSizeBytes,
		Visibility:         "private",
		OwnerUserID:        &user.ID,
	}

	if err := h.repo.Create(r.Context(), book); err != nil {
		_ = h.r2.Delete(r.Context(), destKey)
		respondError(w, r, "Failed to create book", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(book)
}

func parseInt(raw string, fallback int) int {
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return v
}

func resolveBookFileKey(book *models.Book, r2 *storage.R2Client, variant string) (string, error) {
	if book == nil {
		return "", errors.New("Missing book")
	}
	v := strings.TrimSpace(variant)
	if v == "" {
		v = "original"
	}

	if v == "original" {
		return resolveR2Key(book.URL, r2)
	}

	if book.TransformationData == nil {
		return "", errors.New("No transformed variants available")
	}
	urls := book.TransformationData[v]
	if len(urls) == 0 || strings.TrimSpace(urls[0]) == "" {
		return "", errors.New("Requested variant not available")
	}
	return resolveR2Key(urls[0], r2)
}

func resolveR2Key(raw string, r2 *storage.R2Client) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", errors.New("Missing source reference")
	}

	if r2 != nil {
		if key, ok := r2.KeyFromPublicURL(value); ok {
			return key, nil
		}
	}

	if strings.HasPrefix(value, "r2://") {
		trimmed := strings.TrimPrefix(value, "r2://")
		if idx := strings.Index(trimmed, "/"); idx >= 0 {
			key := strings.TrimSpace(trimmed[idx+1:])
			if key != "" && !strings.HasPrefix(key, "/") {
				return key, nil
			}
		}
	}

	if strings.Contains(value, "://") {
		return "", errors.New("Source reference is not a supported R2 URL")
	}
	if strings.HasPrefix(value, "/") {
		value = strings.TrimPrefix(value, "/")
	}
	if value == "" {
		return "", errors.New("Invalid source key")
	}
	return value, nil
}

func validateEPUBUpload(file multipart.File, header *multipart.FileHeader) error {
	if header == nil {
		return errors.New("Missing file metadata")
	}
	filename := strings.TrimSpace(header.Filename)
	if filename != "" && strings.ToLower(path.Ext(filename)) != ".epub" {
		return errors.New("Only .epub files are supported")
	}

	// EPUBs are ZIP containers; sniff the first few bytes.
	head := make([]byte, 4)
	n, err := io.ReadFull(file, head)
	if err != nil || n < 4 {
		return errors.New("Invalid EPUB")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return errors.New("Failed to read upload")
	}
	if head[0] != 'P' || head[1] != 'K' {
		return errors.New("Invalid EPUB (expected a ZIP container)")
	}
	return nil
}

type quotaReader struct {
	r         io.Reader
	maxBytes  int64
	bytesRead int64
}

func (q *quotaReader) Read(p []byte) (int, error) {
	if q.maxBytes >= 0 {
		remaining := q.maxBytes - q.bytesRead
		if remaining <= 0 {
			var one [1]byte
			n, err := q.r.Read(one[:])
			if n > 0 {
				return 0, errPersonalQuotaExceeded
			}
			if err != nil {
				return 0, err
			}
			return 0, io.EOF
		}
		if int64(len(p)) > remaining {
			p = p[:remaining]
		}
	}

	n, err := q.r.Read(p)
	q.bytesRead += int64(n)
	return n, err
}
