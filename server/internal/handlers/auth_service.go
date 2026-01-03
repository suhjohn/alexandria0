package handlers

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/johnsuh/modernfiction/server/internal/models"
)

type CurrentUserProvider interface {
	CurrentUser(r *http.Request) (*models.User, error)
}

type AuthService struct {
	users    *models.UserRepository
	sessions *models.SessionRepository
}

func NewAuthService(users *models.UserRepository, sessions *models.SessionRepository) *AuthService {
	return &AuthService{users: users, sessions: sessions}
}

func (s *AuthService) CurrentUser(r *http.Request) (*models.User, error) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return nil, nil
	}
	sessionID, err := uuid.Parse(cookie.Value)
	if err != nil {
		return nil, nil
	}

	session, err := s.sessions.Get(r.Context(), sessionID)
	if err != nil {
		return nil, err
	}
	if session == nil || session.ExpiresAt.Before(time.Now()) {
		return nil, nil
	}

	_ = s.sessions.Touch(r.Context(), sessionID)
	return s.users.GetByID(r.Context(), session.UserID)
}
