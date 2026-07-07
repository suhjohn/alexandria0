package handlers

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/johnsuh/modernfiction/server/internal/models"
	"github.com/johnsuh/modernfiction/server/internal/storage"
)

type BooksHandler struct {
	repo                  *models.BookRepository
	classificationJobRepo *models.ClassificationJobRepository
	auth                  CurrentUserProvider
	r2                    *storage.R2Client
}

var errPersonalQuotaExceeded = errors.New("personal upload quota exceeded")
var errUploadTooLarge = errors.New("upload too large")

func NewBooksHandler(
	repo *models.BookRepository,
	classificationJobRepo *models.ClassificationJobRepository,
	auth CurrentUserProvider,
	r2 *storage.R2Client,
) *BooksHandler {
	return &BooksHandler{repo: repo, classificationJobRepo: classificationJobRepo, auth: auth, r2: r2}
}

func (h *BooksHandler) GetThumbnail(w http.ResponseWriter, r *http.Request) {
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

	coverKey := storage.BookCoverKey(bookID)
	rc, meta, err := h.r2.Download(r.Context(), coverKey)
	if err != nil {
		if errors.Is(err, storage.ErrObjectNotFound) {
			// Lazy-generate the cover from the source EPUB if possible (useful for
			// older uploads created before thumbnail extraction existed).
			book, bookErr := h.repo.GetByID(r.Context(), bookID)
			if bookErr != nil || book == nil {
				respondError(w, r, "Thumbnail not found", http.StatusNotFound, err)
				return
			}
			if strings.EqualFold(book.Format, "pdf") {
				respondError(w, r, "Thumbnail not found", http.StatusNotFound, err)
				return
			}

			sourceKey, resolveErr := resolveR2Key(book.URL, h.r2)
			if resolveErr != nil {
				respondError(w, r, "Thumbnail not found", http.StatusNotFound, err)
				return
			}

			epubRC, epubMeta, epubErr := h.r2.Download(r.Context(), sourceKey)
			if epubErr != nil {
				respondError(w, r, "Thumbnail not found", http.StatusNotFound, epubErr)
				return
			}
			defer epubRC.Close()

			const maxEPUBBytesForCover = int64(55 << 20) // 55MB
			if epubMeta.ContentLength > maxEPUBBytesForCover {
				respondError(w, r, "Thumbnail not found", http.StatusNotFound, nil)
				return
			}

			epubBytes, readErr := io.ReadAll(io.LimitReader(epubRC, maxEPUBBytesForCover+1))
			if readErr != nil || int64(len(epubBytes)) > maxEPUBBytesForCover {
				respondError(w, r, "Thumbnail not found", http.StatusNotFound, readErr)
				return
			}

			coverBytes, coverContentType := extractCoverImageFromEPUB(bytes.NewReader(epubBytes), int64(len(epubBytes)))
			if len(coverBytes) == 0 {
				respondError(w, r, "Thumbnail not found", http.StatusNotFound, nil)
				return
			}

			if _, uploadErr := h.r2.Upload(r.Context(), coverBytes, coverKey, coverContentType); uploadErr != nil {
				respondError(w, r, "Thumbnail not found", http.StatusNotFound, uploadErr)
				return
			}

			w.Header().Set("Cache-Control", "private, max-age=0, no-store")
			if coverContentType != "" {
				w.Header().Set("Content-Type", coverContentType)
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(coverBytes)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(coverBytes)
			return
		}
		respondError(w, r, "Failed to fetch thumbnail", http.StatusBadGateway, err)
		return
	}
	defer rc.Close()

	w.Header().Set("Cache-Control", "private, max-age=0, no-store")
	if meta.ContentType != "" {
		w.Header().Set("Content-Type", meta.ContentType)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	if meta.ContentLength > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(meta.ContentLength, 10))
	}

	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, rc)
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

func (h *BooksHandler) Delete(w http.ResponseWriter, r *http.Request) {
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

	bookID, err := parseBookID(r)
	if err != nil {
		respondError(w, r, "Invalid book id", http.StatusBadRequest, err)
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
	if book.OwnerUserID == nil || *book.OwnerUserID != user.ID {
		respondError(w, r, "Forbidden", http.StatusForbidden, nil)
		return
	}

	prefix := fmt.Sprintf("books/%s/", bookID.String())
	if _, err := h.r2.DeletePrefix(r.Context(), prefix); err != nil {
		respondError(w, r, "Failed to delete book files", http.StatusBadGateway, err)
		return
	}

	deleted, err := h.repo.DeleteOwned(r.Context(), bookID, user.ID)
	if err != nil {
		respondError(w, r, "Failed to delete book", http.StatusInternalServerError, err)
		return
	}
	if !deleted {
		respondError(w, r, "Book not found", http.StatusNotFound, nil)
		return
	}

	w.WriteHeader(http.StatusNoContent)
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
	if strings.HasSuffix(strings.ToLower(key), ".pdf") {
		if h.r2.IsLocalEndpoint() {
			h.serveFile(w, r, key)
			return
		}
		url, err := h.r2.PresignGet(r.Context(), key, 15*time.Minute)
		if err != nil {
			respondError(w, r, "Failed to create file URL", http.StatusBadGateway, err)
			return
		}
		http.Redirect(w, r, url, http.StatusFound)
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

func (h *BooksHandler) serveFile(w http.ResponseWriter, r *http.Request, key string) {
	byteRange := strings.TrimSpace(r.Header.Get("Range"))
	rc, meta, err := h.r2.DownloadRange(r.Context(), key, byteRange)
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
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	if meta.ContentLength > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(meta.ContentLength, 10))
	}
	if meta.AcceptRanges != "" {
		w.Header().Set("Accept-Ranges", meta.AcceptRanges)
	}
	if meta.ContentRange != "" {
		w.Header().Set("Content-Range", meta.ContentRange)
	}
	if meta.ETag != "" {
		w.Header().Set("ETag", meta.ETag)
	}
	filename := path.Base(key)
	if filename != "" {
		w.Header().Set("Content-Disposition", `inline; filename="`+filename+`"`)
	}

	if byteRange != "" && meta.ContentRange != "" {
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
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

	const maxEPUBUploadBytes = int64(50 << 20)      // 50MB
	const maxPDFUploadBytes = int64(200 << 20)      // 200MB
	const maxMemoryBytes = int64(10 << 20)          // 10MB
	const maxPersonalLibraryBytes = int64(10) << 30 // 10GiB
	r.Body = http.MaxBytesReader(w, r.Body, maxPDFUploadBytes)
	if err := r.ParseMultipartForm(maxMemoryBytes); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) || strings.Contains(err.Error(), "request body too large") {
			respondError(w, r, "Upload too large (max 200MB)", http.StatusRequestEntityTooLarge, err)
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

	format, err := sniffUploadFormat(file, header)
	if err != nil {
		respondError(w, r, err.Error(), http.StatusBadRequest, err)
		return
	}
	maxUploadBytes := maxEPUBUploadBytes
	maxUploadMessage := "Upload too large (max 50MB)"
	contentType := "application/epub+zip"
	if format == "pdf" {
		maxUploadBytes = maxPDFUploadBytes
		maxUploadMessage = "Upload too large (max 200MB)"
		contentType = "application/pdf"
	}
	if header != nil && header.Size > 0 && header.Size > maxUploadBytes {
		respondError(w, r, maxUploadMessage, http.StatusRequestEntityTooLarge, nil)
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
	destKey := storage.SourceKey(bookID, format)
	contentLength := int64(0)
	if header != nil && header.Size > 0 {
		contentLength = header.Size
	}
	sizeReader := &uploadLimitReader{r: file, maxBytes: maxUploadBytes}
	reader := &quotaReader{r: sizeReader, maxBytes: remainingBytes}
	_, err = h.r2.UploadReader(r.Context(), reader, destKey, contentType, contentLength)
	if err != nil {
		if errors.Is(err, errPersonalQuotaExceeded) {
			respondError(w, r, "Personal library storage limit reached (10GB)", http.StatusRequestEntityTooLarge, err)
			return
		}
		if errors.Is(err, errUploadTooLarge) {
			respondError(w, r, maxUploadMessage, http.StatusRequestEntityTooLarge, err)
			return
		}
		respondError(w, r, "Failed to store upload", http.StatusBadGateway, err)
		return
	}

	sourceSizeBytes := contentLength
	if sourceSizeBytes <= 0 {
		sourceSizeBytes = reader.bytesRead
	}

	var coverBytes []byte
	var coverContentType string
	contentLengthForCover := contentLength
	if contentLengthForCover <= 0 {
		contentLengthForCover = sourceSizeBytes
	}
	if format == "epub" {
		coverBytes, coverContentType = extractCoverImageFromEPUBFile(file, contentLengthForCover)
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
		Format:             format,
		Visibility:         "private",
		OwnerUserID:        &user.ID,
	}

	if len(coverBytes) > 0 {
		coverKey := storage.BookCoverKey(bookID)
		if _, err := h.r2.Upload(r.Context(), coverBytes, coverKey, coverContentType); err == nil {
			book.ThumbnailURL = h.r2.PublicURL(coverKey)
		}
	}

	if err := h.repo.Create(r.Context(), book); err != nil {
		_ = h.r2.Delete(r.Context(), destKey)
		respondError(w, r, "Failed to create book", http.StatusInternalServerError, err)
		return
	}
	if format == "pdf" && h.classificationJobRepo != nil {
		if _, err := h.classificationJobRepo.Upsert(r.Context(), bookID, "pending", ""); err != nil {
			_, _ = h.repo.DeleteOwned(r.Context(), bookID, user.ID)
			_, _ = h.r2.DeletePrefix(r.Context(), fmt.Sprintf("books/%s/", bookID.String()))
			respondError(w, r, "Failed to create classification job", http.StatusInternalServerError, err)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(book)
}

type epubContainer struct {
	Rootfiles struct {
		Rootfile []struct {
			FullPath string `xml:"full-path,attr"`
		} `xml:"rootfile"`
	} `xml:"rootfiles"`
}

type opfCoverCandidate struct {
	Properties string
	ID         string
	Href       string
	MediaType  string
}

func extractCoverImageFromEPUBFile(file multipart.File, size int64) ([]byte, string) {
	if file == nil || size <= 0 {
		return nil, ""
	}

	readerAt, ok := file.(io.ReaderAt)
	if !ok {
		return nil, ""
	}

	return extractCoverImageFromEPUB(readerAt, size)
}

func extractCoverImageFromEPUB(readerAt io.ReaderAt, size int64) ([]byte, string) {
	if readerAt == nil || size <= 0 {
		return nil, ""
	}

	zr, err := zip.NewReader(readerAt, size)
	if err != nil {
		return nil, ""
	}

	readFile := func(name string) ([]byte, bool) {
		for _, zf := range zr.File {
			if zf.Name != name {
				continue
			}
			if zf.UncompressedSize64 > 15<<20 {
				return nil, false
			}
			rc, err := zf.Open()
			if err != nil {
				return nil, false
			}
			defer rc.Close()
			data, err := io.ReadAll(rc)
			if err != nil {
				return nil, false
			}
			return data, true
		}

		// Case-insensitive fallback.
		lower := strings.ToLower(name)
		for _, zf := range zr.File {
			if strings.ToLower(zf.Name) != lower {
				continue
			}
			if zf.UncompressedSize64 > 15<<20 {
				return nil, false
			}
			rc, err := zf.Open()
			if err != nil {
				return nil, false
			}
			defer rc.Close()
			data, err := io.ReadAll(rc)
			if err != nil {
				return nil, false
			}
			return data, true
		}

		return nil, false
	}

	// 1) Attempt EPUB-standard cover resolution via container.xml + OPF metadata.
	if containerBytes, ok := readFile("META-INF/container.xml"); ok {
		var container epubContainer
		if err := xml.Unmarshal(containerBytes, &container); err == nil {
			opfPath := ""
			if len(container.Rootfiles.Rootfile) > 0 {
				opfPath = strings.TrimSpace(container.Rootfiles.Rootfile[0].FullPath)
			}
			if opfPath != "" {
				if opfBytes, ok := readFile(opfPath); ok {
					coverPath := resolveCoverPathFromOPF(opfPath, opfBytes)
					if coverPath != "" {
						if coverBytes, ok := readFile(coverPath); ok {
							contentType := http.DetectContentType(coverBytes)
							if strings.HasPrefix(contentType, "image/") {
								return coverBytes, contentType
							}
						}
					}
				}
			}
		}
	}

	// 2) Fallback heuristic: "cover"/"title" + image extensions.
	for _, zf := range zr.File {
		lower := strings.ToLower(zf.Name)
		if !(strings.Contains(lower, "cover") || strings.Contains(lower, "title")) {
			continue
		}
		if !(strings.HasSuffix(lower, ".jpg") || strings.HasSuffix(lower, ".jpeg") || strings.HasSuffix(lower, ".png")) {
			continue
		}
		if zf.UncompressedSize64 > 15<<20 {
			continue
		}
		rc, err := zf.Open()
		if err != nil {
			continue
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			continue
		}
		contentType := http.DetectContentType(data)
		if strings.HasPrefix(contentType, "image/") {
			return data, contentType
		}
	}

	return nil, ""
}

func resolveCoverPathFromOPF(opfPath string, opfBytes []byte) string {
	if len(opfBytes) == 0 {
		return ""
	}

	decoder := xml.NewDecoder(bytes.NewReader(opfBytes))

	coverID := ""
	candidates := make([]opfCoverCandidate, 0, 8)

	for {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		start, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}

		switch start.Name.Local {
		case "meta":
			name := ""
			content := ""
			for _, attr := range start.Attr {
				if attr.Name.Local == "name" {
					name = strings.TrimSpace(attr.Value)
				} else if attr.Name.Local == "content" {
					content = strings.TrimSpace(attr.Value)
				}
			}
			if name == "cover" && content != "" {
				coverID = content
			}
		case "item":
			item := opfCoverCandidate{}
			for _, attr := range start.Attr {
				switch attr.Name.Local {
				case "properties":
					item.Properties = strings.TrimSpace(attr.Value)
				case "id":
					item.ID = strings.TrimSpace(attr.Value)
				case "href":
					item.Href = strings.TrimSpace(attr.Value)
				case "media-type":
					item.MediaType = strings.TrimSpace(attr.Value)
				}
			}
			if item.Href != "" {
				candidates = append(candidates, item)
			}
		}
	}

	chosenHref := ""
	for _, item := range candidates {
		if strings.Contains(item.Properties, "cover-image") {
			chosenHref = item.Href
			break
		}
	}
	if chosenHref == "" && coverID != "" {
		for _, item := range candidates {
			if item.ID == coverID {
				chosenHref = item.Href
				break
			}
		}
	}
	if chosenHref == "" {
		for _, item := range candidates {
			if strings.Contains(strings.ToLower(item.ID), "cover") && strings.HasPrefix(item.MediaType, "image/") {
				chosenHref = item.Href
				break
			}
		}
	}
	if chosenHref == "" {
		return ""
	}

	opfDir := path.Dir(opfPath)
	resolved := path.Clean(path.Join(opfDir, chosenHref))
	resolved = strings.TrimPrefix(resolved, "/")
	return resolved
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

func sniffUploadFormat(file multipart.File, header *multipart.FileHeader) (string, error) {
	if header == nil {
		return "", errors.New("Missing file metadata")
	}
	if file == nil {
		return "", errors.New("Missing file")
	}

	filename := strings.TrimSpace(header.Filename)
	ext := strings.ToLower(path.Ext(filename))
	if ext != ".epub" && ext != ".pdf" {
		return "", errors.New("Only .epub and .pdf files are supported")
	}

	head := make([]byte, 1024)
	n, readErr := file.Read(head)
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", errors.New("Failed to read upload")
	}
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return "", errors.New("Failed to read upload")
	}

	if ext == ".epub" {
		if n < 2 || head[0] != 'P' || head[1] != 'K' {
			return "", errors.New("Invalid EPUB (expected a ZIP container)")
		}
		return "epub", nil
	}

	if !bytes.Contains(head[:n], []byte("%PDF-")) {
		return "", errors.New("Invalid PDF")
	}
	return "pdf", nil
}

type uploadLimitReader struct {
	r         io.Reader
	maxBytes  int64
	bytesRead int64
}

func (u *uploadLimitReader) Read(p []byte) (int, error) {
	if u.maxBytes >= 0 {
		remaining := u.maxBytes - u.bytesRead
		if remaining <= 0 {
			var one [1]byte
			n, err := u.r.Read(one[:])
			if n > 0 {
				return 0, errUploadTooLarge
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

	n, err := u.r.Read(p)
	u.bytesRead += int64(n)
	return n, err
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
