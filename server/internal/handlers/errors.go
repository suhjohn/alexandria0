package handlers

import (
	"log"
	"net/http"

	"github.com/go-chi/chi/v5/middleware"
)

func respondError(w http.ResponseWriter, r *http.Request, msg string, status int, err error) {
	reqID := middleware.GetReqID(r.Context())
	if err != nil {
		log.Printf("error: status=%d method=%s path=%s req_id=%s msg=%s err=%v",
			status, r.Method, r.URL.Path, reqID, msg, err)
	} else {
		log.Printf("error: status=%d method=%s path=%s req_id=%s msg=%s",
			status, r.Method, r.URL.Path, reqID, msg)
	}
	http.Error(w, msg, status)
}
