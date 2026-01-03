package gutenberg

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/johnsuh/modernfiction/server/internal/models"
	"github.com/johnsuh/modernfiction/server/internal/storage"
)

// GutenbergNamespace is a UUID namespace for generating deterministic IDs from Gutenberg book IDs
var GutenbergNamespace = uuid.MustParse("a3e5b7c9-1234-4d5e-8f9a-0b1c2d3e4f5a")

const (
	gutenbergBaseURL = "https://www.gutenberg.org"
	gutenbergRDFURL  = "https://www.gutenberg.org/cache/epub/%d/pg%d.rdf"
	gutenbergEPUBURL = "https://www.gutenberg.org/ebooks/%d.epub.images"
)

type Syncer struct {
	repo         *models.BookRepository
	r2           *storage.R2Client
	client       *http.Client
	skipExisting bool
}

func NewSyncer(repo *models.BookRepository, r2 *storage.R2Client) *Syncer {
	return &Syncer{
		repo:   repo,
		r2:     r2,
		client: &http.Client{},
	}
}

func (s *Syncer) WithSkipExisting(skip bool) *Syncer {
	s.skipExisting = skip
	return s
}

type RDFMetadata struct {
	XMLName xml.Name `xml:"RDF"`
	Ebook   struct {
		About   string `xml:"about,attr"`
		Title   string `xml:"title"`
		Creator []struct {
			Agent struct {
				Name string `xml:"name"`
			} `xml:"agent"`
		} `xml:"creator"`
	} `xml:"ebook"`
}

func (s *Syncer) SyncBooks(ctx context.Context, count int) error {
	fmt.Printf("Syncing %d books from Project Gutenberg...\n", count)

	synced := 0
	bookID := 1

	for synced < count {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if s.skipExisting {
			exists, err := s.repo.ExistsByID(ctx, GutenbergBookID(bookID))
			if err != nil {
				return fmt.Errorf("failed to check if book exists: %w", err)
			}
			if exists {
				bookID++
				continue
			}
		}

		book, err := s.fetchBook(ctx, bookID)
		if err != nil {
			fmt.Printf("Skipping book %d: %v\n", bookID, err)
			bookID++
			continue
		}

		if err := s.repo.Upsert(ctx, book); err != nil {
			return fmt.Errorf("failed to save book %d: %w", bookID, err)
		}

		fmt.Printf("Synced: %s by %s\n", book.Title, strings.Join(book.Authors, ", "))
		synced++
		bookID++
	}

	fmt.Printf("Successfully synced %d books\n", synced)
	return nil
}

func (s *Syncer) fetchBook(ctx context.Context, bookID int) (*models.Book, error) {
	// Fetch RDF metadata
	rdfURL := fmt.Sprintf(gutenbergRDFURL, bookID, bookID)
	req, err := http.NewRequestWithContext(ctx, "GET", rdfURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("RDF not found (status %d)", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var rdf RDFMetadata
	if err := xml.Unmarshal(body, &rdf); err != nil {
		return nil, fmt.Errorf("failed to parse RDF: %w", err)
	}

	if rdf.Ebook.Title == "" {
		return nil, fmt.Errorf("book has no title")
	}

	authors := make([]string, 0)
	for _, creator := range rdf.Ebook.Creator {
		if creator.Agent.Name != "" {
			authors = append(authors, creator.Agent.Name)
		}
	}

	epubData, err := s.downloadEPUB(ctx, bookID)
	if err != nil {
		return nil, err
	}

	epubKey := epubObjectKey(GutenbergBookID(bookID), rdf.Ebook.Title)
	epubURL, err := s.r2.Upload(ctx, epubData, epubKey, "application/epub+zip")
	if err != nil {
		return nil, fmt.Errorf("failed to upload EPUB to R2: %w", err)
	}

	thumbnailURL := s.extractAndUploadThumbnailFromEPUB(ctx, epubKey, epubData)

	book := &models.Book{
		ID:                 GutenbergBookID(bookID),
		URL:                epubURL,
		Title:              rdf.Ebook.Title,
		Authors:            authors,
		ThumbnailURL:       thumbnailURL,
		TransformationData: make(map[string][]string),
	}

	return book, nil
}

// GutenbergBookID generates a deterministic UUID from a Gutenberg book ID
func GutenbergBookID(bookID int) uuid.UUID {
	return uuid.NewSHA1(GutenbergNamespace, []byte(fmt.Sprintf("%d", bookID)))
}

func (s *Syncer) downloadEPUB(ctx context.Context, bookID int) ([]byte, error) {
	epubURL := fmt.Sprintf(gutenbergEPUBURL, bookID)

	req, err := http.NewRequestWithContext(ctx, "GET", epubURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to download EPUB: status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return body, nil
}

func (s *Syncer) extractAndUploadThumbnailFromEPUB(ctx context.Context, epubKey string, epubData []byte) string {
	reader, err := zip.NewReader(bytes.NewReader(epubData), int64(len(epubData)))
	if err != nil {
		return ""
	}

	// Look for cover image in EPUB
	for _, file := range reader.File {
		lower := strings.ToLower(file.Name)
		ext := strings.ToLower(filepath.Ext(file.Name))

		if (strings.Contains(lower, "cover") || strings.Contains(lower, "title")) &&
			(ext == ".jpg" || ext == ".jpeg" || ext == ".png") {

			rc, err := file.Open()
			if err != nil {
				continue
			}

			data, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				continue
			}

			coverKey := storage.CoverPathForEPUB(epubKey)
			r2URL, err := s.r2.Upload(ctx, data, coverKey, "")
			if err != nil {
				continue
			}

			return r2URL
		}
	}

	return ""
}

func epubObjectKey(bookID uuid.UUID, title string) string {
	slug := normalizeFilename(title)
	if slug == "" {
		slug = "untitled"
	}
	idPrefix := strings.Split(bookID.String(), "-")[0]
	filename := fmt.Sprintf("%s_%s.epub", slug, idPrefix)
	return filepath.Join("books", filename)
}

func normalizeFilename(input string) string {
	trimmed := strings.TrimSpace(strings.ToLower(input))
	if trimmed == "" {
		return ""
	}
	spaceRe := regexp.MustCompile(`\s+`)
	normalized := spaceRe.ReplaceAllString(trimmed, "_")
	allowedRe := regexp.MustCompile(`[^a-z0-9_]+`)
	return allowedRe.ReplaceAllString(normalized, "")
}
