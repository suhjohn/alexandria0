package handlers

import (
	"encoding/json"
	"net/http"

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
