package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/johnsuh/modernfiction/server/internal/models"
)

type BooksHandler struct {
	repo *models.BookRepository
	auth CurrentUserProvider
}

func NewBooksHandler(repo *models.BookRepository, auth CurrentUserProvider) *BooksHandler {
	return &BooksHandler{repo: repo, auth: auth}
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
