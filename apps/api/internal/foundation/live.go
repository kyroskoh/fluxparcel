package foundation

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"
)

const livePath = "/v1/events"

func messageChannel(conversationID string) string {
	return "chat:messages:" + conversationID
}

func (s *Server) notifyMessage(ctx context.Context, conversationID string) {
	notify, cancel := context.WithTimeout(context.WithoutCancel(ctx), 500*time.Millisecond)
	defer cancel()
	// The committed message remains available to cursor synchronization if Redis is unavailable.
	_ = s.Cache.Publish(notify, messageChannel(conversationID), "changed").Err()
}

func (s *Server) liveAllowed(ctx context.Context, sessionHash []byte, conversationID string) (bool, error) {
	check, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var allowed bool
	err := s.DB.QueryRow(check, `SELECT EXISTS (
        SELECT 1 FROM device_sessions d JOIN memberships m ON m.user_id=d.user_id
        WHERE d.access_hash=$1 AND d.access_expires_at>now() AND d.expires_at>now()
        AND m.conversation_id=$2
    )`, sessionHash, conversationID).Scan(&allowed)
	return allowed, err
}

func (s *Server) liveMessages(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != s.Origin {
		problem(w, r, 403, "origin_denied", "Request origin denied.")
		return
	}
	id := r.URL.Query().Get("conversationId")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	session := cookieValue(r, "rv_access")
	if session == "" {
		problem(w, r, 401, "session_required", "Sign in to continue.")
		return
	}
	select {
	case s.liveSlots <- struct{}{}:
		defer func() { <-s.liveSlots }()
	default:
		problem(w, r, 503, "live_busy", "Live chat is temporarily busy.")
		return
	}

	sessionHash := digest(session)
	allowed, err := s.liveAllowed(r.Context(), sessionHash, id)
	if err != nil {
		failure(w, r)
		return
	}
	if !allowed {
		missing(w, r)
		return
	}
	subscribe, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	sub := s.Cache.Subscribe(subscribe, messageChannel(id))
	defer sub.Close()
	if _, err := sub.Receive(subscribe); err != nil {
		problem(w, r, 503, "live_unavailable", "Live chat is temporarily unavailable.")
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := conn.CloseRead(r.Context())
	ready, sent := context.WithTimeout(ctx, 5*time.Second)
	err = conn.Write(ready, websocket.MessageText, []byte("messages.ready"))
	sent()
	if err != nil {
		return
	}
	changes := sub.Channel(redis.WithChannelSize(1), redis.WithChannelSendTimeout(time.Second))
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		var changed bool
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
		case _, ok := <-changes:
			if !ok {
				return
			}
			changed = true
		}
		allowed, err := s.liveAllowed(ctx, sessionHash, id)
		if err != nil {
			return
		}
		if !allowed {
			_ = conn.Close(websocket.StatusPolicyViolation, "Access unavailable")
			return
		}
		operation, done := context.WithTimeout(ctx, 5*time.Second)
		if changed {
			err = conn.Write(operation, websocket.MessageText, []byte("messages.changed"))
		} else {
			err = conn.Ping(operation)
		}
		done()
		if err != nil {
			return
		}
	}
}
