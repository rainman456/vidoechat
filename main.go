package main

import (
	"log"
	"net/http"
	"sync"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Client statuses
const (
	StatusIdle    = "idle"
	StatusCalling = "calling"
	StatusInCall  = "in-call"
)

// upgrader upgrades HTTP connections to WebSocket connections
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true }, // TODO: secure origin check in production
}

// ClientInfo stores info about each connected client
type ClientInfo struct {
	Conn     *websocket.Conn
	ID       string
	Status   string
	CallID   string
	IsCaller bool
}

// Message is the JSON structure for WebSocket communication
type Message struct {
	Type     string `json:"type"`
	CallID   string `json:"callId,omitempty"`
	Data     string `json:"data,omitempty"`     // SDP or ICE candidate
	CallerID string `json:"callerId,omitempty"` // Initiator client ID
	Reason   string `json:"reason,omitempty"`   // Optional rejection reason
}

// Room represents a call session with participants
type Room struct {
	ID           string
	Participants map[*websocket.Conn]bool
}

var (
	clients     = make(map[*websocket.Conn]*ClientInfo)
	clientsByID = make(map[string]*ClientInfo)
	rooms       = make(map[string]*Room)

	clientsMu sync.RWMutex
	roomsMu   sync.RWMutex
)

// helper: safely send a message to a client connection
func sendMessage(conn *websocket.Conn, msg Message) {
	if err := conn.WriteJSON(msg); err != nil {
		log.Printf("Error sending message to client: %v", err)
	}
}

// helper: reset client state to idle
func resetClientState(client *ClientInfo) {
	client.Status = StatusIdle
	client.CallID = ""
	client.IsCaller = false
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade failed: %v", err)
		return
	}

	clientID := uuid.New().String()
	client := &ClientInfo{
		Conn:   ws,
		ID:     clientID,
		Status: StatusIdle,
	}

	clientsMu.Lock()
	clients[ws] = client
	clientsByID[clientID] = client
	log.Printf("Client %s connected. Total clients: %d", clientID, len(clients))
	clientsMu.Unlock()

	defer func() {
		clientsMu.Lock()
		if c, ok := clients[ws]; ok {
			log.Printf("Client %s disconnecting. Status: %s, CallID: %s", c.ID, c.Status, c.CallID)
			if c.Status == StatusInCall || c.Status == StatusCalling {
				handleHangupInternal(ws, c.CallID, "peer_disconnected_unexpectedly")
			}
			delete(clientsByID, c.ID)
		}
		delete(clients, ws)
		log.Printf("Client %s removed. Total clients: %d", clientID, len(clients))
		clientsMu.Unlock()
		ws.Close()
	}()

	for {
		var msg Message
		err := ws.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNormalClosure) {
				log.Printf("Client %s unexpected close error: %v", clientID, err)
			} else {
				log.Printf("Client %s read error: %v", clientID, err)
			}
			break
		}

		log.Printf("Received from %s: Type=%s, CallID=%s", clientID, msg.Type, msg.CallID)

		switch msg.Type {
		case "initiate_call":
			handleInitiateCall(client, msg)
		case "accept_call":
			handleAcceptCall(client, msg)
		case "reject_call":
			handleRejectCall(client, msg)
		case "ice-candidate":
			handleICECandidate(client, msg)
		case "hangup":
			handleHangupInternal(ws, msg.CallID, "hangup_request")
		default:
			log.Printf("Unknown message type from %s: %s", clientID, msg.Type)
			sendMessage(ws, Message{Type: "error", Data: "Unknown message type"})
		}
	}
}

func handleInitiateCall(caller *ClientInfo, msg Message) {
	clientsMu.Lock()
	if caller.Status != StatusIdle {
		clientsMu.Unlock()
		log.Printf("Client %s tried to initiate call but status is %s", caller.ID, caller.Status)
		sendMessage(caller.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Cannot initiate call, already busy."})
		return
	}

	// Try to find an idle callee
	var callee *ClientInfo
	for _, c := range clientsByID {
		if c.ID != caller.ID && c.Status == StatusIdle {
			callee = c
			break
		}
	}

	if callee == nil {
		log.Printf("No idle clients for call %s from %s", msg.CallID, caller.ID)
		sendMessage(caller.Conn, Message{Type: "error", CallID: msg.CallID, Data: "No idle users available."})
		caller.Status = StatusIdle
		caller.CallID = ""
		caller.IsCaller = false
		clientsMu.Unlock()
		return
	}

	// Set up statuses and room
	callID := msg.CallID
	caller.Status = StatusInCall
	caller.CallID = callID
	caller.IsCaller = true

	callee.Status = StatusInCall
	callee.CallID = callID
	callee.IsCaller = false
	clientsMu.Unlock()

	roomsMu.Lock()
	room := &Room{
		ID:           callID,
		Participants: map[*websocket.Conn]bool{caller.Conn: true, callee.Conn: true},
	}
	rooms[callID] = room
	roomsMu.Unlock()

	log.Printf("Auto-matched call %s between caller %s and callee %s", callID, caller.ID, callee.ID)

	// Notify both clients that call is connected
	sendMessage(caller.Conn, Message{
		Type:   "answer",
		CallID: callID,
		Data:   msg.Data, // SDP from caller (if any), or can be empty
	})
	sendMessage(callee.Conn, Message{
		Type:     "incoming_call",
		CallID:   callID,
		Data:     msg.Data,
		CallerID: caller.ID,
	})
}

func handleAcceptCall(callee *ClientInfo, msg Message) {
	// Lock rooms first, then clients to avoid deadlock
	roomsMu.Lock()
	defer roomsMu.Unlock()
	clientsMu.Lock()
	defer clientsMu.Unlock()

	if _, exists := rooms[msg.CallID]; exists {
		log.Printf("Call %s already accepted, callee %s tried to accept", msg.CallID, callee.ID)
		sendMessage(callee.Conn, Message{Type: "call_taken", CallID: msg.CallID, Data: "Call already accepted"})
		return
	}

	// Find caller who initiated the call
	var caller *ClientInfo
	for _, c := range clientsByID {
		if c.CallID == msg.CallID && c.IsCaller {
			caller = c
			break
		}
	}
	if caller == nil || caller.Status != StatusCalling {
		log.Printf("No active caller for call %s, callee %s", msg.CallID, callee.ID)
		sendMessage(callee.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Call not found or caller unavailable"})
		return
	}

	if callee.Status != StatusIdle {
		log.Printf("Client %s not idle (status %s), cannot accept call %s", callee.ID, callee.Status, msg.CallID)
		sendMessage(callee.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Cannot accept call, you are not idle"})
		return
	}

	room := &Room{
		ID:           msg.CallID,
		Participants: map[*websocket.Conn]bool{caller.Conn: true, callee.Conn: true},
	}
	rooms[msg.CallID] = room

	caller.Status = StatusInCall
	callee.Status = StatusInCall
	callee.CallID = msg.CallID
	callee.IsCaller = false

	log.Printf("Call %s accepted by %s; room created with caller %s", msg.CallID, callee.ID, caller.ID)

	// Send answer SDP to caller
	sendMessage(caller.Conn, Message{
		Type:   "answer",
		CallID: msg.CallID,
		Data:   msg.Data,
	})

	// Notify other clients that call was taken
	takenMsg := Message{Type: "call_taken", CallID: msg.CallID}
	for conn, c := range clients {
		if c.ID != caller.ID && c.ID != callee.ID {
			sendMessage(conn, takenMsg)
		}
	}
}

func handleRejectCall(client *ClientInfo, msg Message) {
	log.Printf("Client %s rejected call %s. Reason: %s", client.ID, msg.CallID, msg.Reason)
	// Could notify caller here if desired
}

func handleICECandidate(sender *ClientInfo, msg Message) {
	roomsMu.RLock()
	room, exists := rooms[msg.CallID]
	roomsMu.RUnlock()

	if !exists {
		log.Printf("ICE candidate for unknown room %s from %s", msg.CallID, sender.ID)
		return
	}

	iceMsg := Message{
		Type:   "ice-candidate",
		CallID: msg.CallID,
		Data:   msg.Data,
	}

	for participantConn := range room.Participants {
		if participantConn != sender.Conn {
			if err := participantConn.WriteJSON(iceMsg); err != nil {
				log.Printf("Error forwarding ICE candidate in room %s: %v", msg.CallID, err)
			} else {
				log.Printf("Forwarded ICE candidate from %s in call %s", sender.ID, msg.CallID)
			}
		}
	}
}

func handleHangupInternal(disconnectedConn *websocket.Conn, callID string, reason string) {
	if callID == "" {
		log.Printf("Hangup called with empty callID, reason: %s", reason)
		return
	}

	// Lock rooms then clients
	roomsMu.Lock()
	defer roomsMu.Unlock()
	clientsMu.Lock()
	defer clientsMu.Unlock()

	room, exists := rooms[callID]
	if !exists {
		// No room formed yet, reset caller who initiated call
		for _, c := range clientsByID {
			if c.CallID == callID && c.Status == StatusCalling {
				log.Printf("Resetting caller %s state for unformed call %s", c.ID, callID)
				resetClientState(c)
				break
			}
		}
		return
	}

	log.Printf("Processing hangup for room %s, reason: %s", callID, reason)

	// Notify other participants and reset states
	hangupMsg := Message{Type: "peer_disconnected", CallID: callID, Data: reason}
	for participantConn := range room.Participants {
		if participantConn != disconnectedConn {
			sendMessage(participantConn, hangupMsg)
		}
		if clientInfo, ok := clients[participantConn]; ok {
			resetClientState(clientInfo)
		}
	}

	delete(rooms, callID)
	log.Printf("Deleted room %s after hangup", callID)
}

func main() {
	http.Handle("/", http.FileServer(http.Dir("./client")))
	http.HandleFunc("/ws", handleConnections)

	log.Println("Server started on :8000")
	if err := http.ListenAndServe(":8000", nil); err != nil {
		log.Fatalf("ListenAndServe error: %v", err)
	}
}
