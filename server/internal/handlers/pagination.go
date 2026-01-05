package handlers

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
)

type CursorPageResponse[T any] struct {
	Items      []T     `json:"items"`
	Total      int     `json:"total"`
	Limit      int     `json:"limit"`
	NextCursor *string `json:"next_cursor,omitempty"`
}

func decodeCursor[T any](raw string) (*T, error) {
	if raw == "" {
		return nil, nil
	}
	bytes, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid cursor encoding: %w", err)
	}
	var out T
	if err := json.Unmarshal(bytes, &out); err != nil {
		return nil, fmt.Errorf("invalid cursor payload: %w", err)
	}
	return &out, nil
}

func encodeCursor[T any](cursor T) (string, error) {
	bytes, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}
