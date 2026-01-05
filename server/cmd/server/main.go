package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/joho/godotenv"
	"github.com/spf13/cobra"

	"github.com/johnsuh/modernfiction/server/internal/db"
	"github.com/johnsuh/modernfiction/server/internal/gutenberg"
	"github.com/johnsuh/modernfiction/server/internal/handlers"
	"github.com/johnsuh/modernfiction/server/internal/models"
	"github.com/johnsuh/modernfiction/server/internal/storage"
)

var rootCmd = &cobra.Command{
	Use:   "server",
	Short: "ModernFiction server",
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the HTTP server",
	RunE:  runServe,
}

var syncGutenbergCmd = &cobra.Command{
	Use:   "sync-gutenberg",
	Short: "Sync books from Project Gutenberg",
	RunE:  runSyncGutenberg,
}

var migrateCmd = &cobra.Command{
	Use:   "migrate",
	Short: "Run database migrations",
	RunE:  runMigrate,
}

var (
	syncCount  int
	serverPort string
	envFile    string
	envName    string
)

func init() {
	syncGutenbergCmd.Flags().IntVarP(&syncCount, "count", "n", 10, "Number of books to sync")
	syncGutenbergCmd.Flags().Bool("skip-existing", false, "Skip books that already exist")
	serveCmd.Flags().StringVarP(&serverPort, "port", "p", "8080", "Port to run the server on")

	rootCmd.PersistentFlags().StringVar(
		&envFile,
		"env-file",
		"",
		"Path to a dotenv file (overrides APP_ENV)",
	)
	rootCmd.PersistentFlags().StringVar(
		&envName,
		"env",
		"",
		"Environment name (e.g., local or production)",
	)

	rootCmd.AddCommand(serveCmd)
	rootCmd.AddCommand(syncGutenbergCmd)
	rootCmd.AddCommand(migrateCmd)
}

func main() {
	loadEnv()

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func loadEnv() {
	if envFile != "" {
		_ = godotenv.Load(envFile)
		return
	}

	activeEnv := envName
	if activeEnv == "" {
		activeEnv = os.Getenv("APP_ENV")
	}

	if strings.EqualFold(activeEnv, "production") {
		_ = godotenv.Load(".env.production")
		return
	}

	_ = godotenv.Load()
}

func runServe(cmd *cobra.Command, args []string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	database, err := db.New(ctx)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer database.Close()

	bookRepo := models.NewBookRepository(database.Pool)
	jobRepo := models.NewTransformJobRepository(database.Pool)
	userRepo := models.NewUserRepository(database.Pool)
	tokenRepo := models.NewMagicLinkTokenRepository(database.Pool)
	sessionRepo := models.NewSessionRepository(database.Pool)
	authService := handlers.NewAuthService(userRepo, sessionRepo)
	booksHandler := handlers.NewBooksHandler(bookRepo, authService)

	r2Client, err := storage.NewR2Client(ctx)
	if err != nil {
		return fmt.Errorf("failed to create R2 client: %w", err)
	}

	transformHandler := handlers.NewBookTransformHandler(
		bookRepo,
		jobRepo,
		r2Client,
		authService,
		os.Getenv("TRANSFORM_API_URL"),
		os.Getenv("TRANSFORM_API_SECRET_KEY"),
	)
	authHandler := handlers.NewAuthHandler(userRepo, tokenRepo, sessionRepo)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	// CORS middleware
	allowedOrigins := parseAllowedOrigins(os.Getenv("CORS_ALLOW_ORIGINS"))
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && (len(allowedOrigins) == 0 || allowedOrigins[origin]) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
	r.Get("/books", booksHandler.GetAll)
	r.Get("/books/search", booksHandler.Search)
	r.Get("/books/{id}", booksHandler.GetByID)
	r.Post("/books/{id}/transform", transformHandler.StartTransform)
	r.Get("/books/{id}/transform", transformHandler.GetTransform)
	r.Post("/auth/request", authHandler.RequestMagicLink)
	r.Get("/auth/verify", authHandler.VerifyMagicLink)
	r.Get("/auth/me", authHandler.Me)
	r.Post("/auth/logout", authHandler.Logout)

	server := &http.Server{
		Addr:    ":" + serverPort,
		Handler: r,
	}

	go transformHandler.StartWorker(ctx, 20*time.Second)

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		cancel()
		server.Shutdown(shutdownCtx)
	}()

	fmt.Printf("Server starting on http://localhost:%s\n", serverPort)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		return err
	}

	return nil
}

func parseAllowedOrigins(raw string) map[string]bool {
	allowed := make(map[string]bool)
	for _, entry := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(entry)
		if origin != "" {
			allowed[origin] = true
		}
	}
	return allowed
}

func runSyncGutenberg(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	database, err := db.New(ctx)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer database.Close()

	r2Client, err := storage.NewR2Client(ctx)
	if err != nil {
		return fmt.Errorf("failed to create R2 client: %w", err)
	}

	bookRepo := models.NewBookRepository(database.Pool)
	skipExisting, _ := cmd.Flags().GetBool("skip-existing")
	syncer := gutenberg.NewSyncer(bookRepo, r2Client).WithSkipExisting(skipExisting)

	return syncer.SyncBooks(ctx, syncCount)
}

func runMigrate(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	database, err := db.New(ctx)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer database.Close()

	return database.Migrate(ctx)
}
