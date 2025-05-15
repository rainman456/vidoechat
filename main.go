package main

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid" // For generating unique client IDs
	"github.com/gorilla/websocket"
)

// Constants for client status
const (
	statusIdle    = "idle"
	statusCalling = "calling" // Client has initiated a call, waiting for someone to accept
	statusInCall  = "in-call"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // For development. In production, validate the origin.
	},
}

// ClientInfo holds information about a connected client
type ClientInfo struct {
	Conn     *websocket.Conn
	ID       string // Unique ID for this client
	Status   string // "idle", "calling", "in-call"
	CallID   string // If Status is "calling" or "in-call", this is the associated call ID
	isCaller bool   // True if this client initiated the current/pending call
}

// Message defines the structure for WebSocket messages
type Message struct {
	Type     string `json:"type"`
	CallID   string `json:"callId,omitempty"`
	Data     string `json:"data,omitempty"`     // For SDP offer, answer, ICE candidate
	CallerID string `json:"callerId,omitempty"` // ID of the client who initiated the call
	Reason   string `json:"reason,omitempty"`   // Optional reason for rejection etc.
}

// Room holds information about an active call session
type Room struct {
	ID           string
	Participants map[*websocket.Conn]bool // Pointers to participant connections
	// OfferSDP  string // The initial offer, might be useful if a late joiner needs it
}

var (
	clients     = make(map[*websocket.Conn]*ClientInfo) // Map connection to ClientInfo
	clientsByID = make(map[string]*ClientInfo)      // Map client ID to ClientInfo for easy lookup
	rooms       = make(map[string]*Room)            // Map callID to Room

	// Mutexes to protect shared access
	clientsMu sync.RWMutex
	roomsMu   sync.RWMutex
)

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade connection: %v", err)
		return
	}

	clientID := uuid.New().String() // Generate a unique ID for the client
	client := &ClientInfo{
		Conn:   ws,
		ID:     clientID,
		Status: statusIdle,
	}

	clientsMu.Lock()
	clients[ws] = client
	clientsByID[clientID] = client
	log.Printf("Client %s connected. Total clients: %d", clientID, len(clients))
	clientsMu.Unlock()

	defer func() {
		clientsMu.Lock()
		currentClientInfo := clients[ws] // Get the most up-to-date info
		if currentClientInfo != nil {
			log.Printf("Client %s disconnecting. Status: %s, CallID: %s", currentClientInfo.ID, currentClientInfo.Status, currentClientInfo.CallID)
			if currentClientInfo.Status == statusInCall || currentClientInfo.Status == statusCalling {
				// If client was in a call or initiating one, notify the other party / clean up room
				handleHangupInternal(ws, currentClientInfo.CallID, "peer_disconnected_unexpectedly")
			}
			delete(clientsByID, currentClientInfo.ID)
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
				log.Printf("Client %s read error (unexpected close): %v", clientID, err)
			} else if err.Error() == "websocket: close 1001 (going away)" || err.Error() == "websocket: close 1000 (normal)" {
				log.Printf("Client %s disconnected gracefully.", clientID)
			} else {
				log.Printf("Client %s read error: %v", clientID, err)
			}
			break // Exit loop on read error (client disconnected or other issue)
		}

		log.Printf("Received message from %s: Type=%s, CallID=%s", clientID, msg.Type, msg.CallID)

		// Associate sender's client ID with the message if not already present
		// This is more for server-side logic than for forwarding, as client already knows its ID.
		// msg.SenderID = clientID // Not strictly needed for client-server messages if client doesn't use it

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
			// Optionally send an error back to the client
			// client.Conn.WriteJSON(Message{Type: "error", Data: "Unknown message type"})
		}
	}
}

func handleInitiateCall(caller *ClientInfo, msg Message) {
	clientsMu.Lock()
	if caller.Status != statusIdle {
		log.Printf("Client %s tried to initiate call but is not idle (status: %s)", caller.ID, caller.Status)
		caller.Conn.WriteJSON(Message{Type: "error", CallID: msg.CallID, Data: "Cannot initiate call, already in a call or calling."})
		clientsMu.Unlock()
		return
	}
	caller.Status = statusCalling
	caller.CallID = msg.CallID
	caller.isCaller = true
	clientsMu.Unlock() // Unlock early before iterating

	log.Printf("Client %s initiated call %s. Broadcasting to idle clients.", caller.ID, msg.CallID)

	// Message to send to potential callees
	incomingCallMsg := Message{
		Type:     "incoming_call",
		CallID:   msg.CallID,
		Data:     msg.Data, // This is the offer SDP
		CallerID: caller.ID,
	}

	clientsMu.RLock() // Use RLock for reading clients map
	idleClientCount := 0
	for conn, potentialCallee := range clients {
		if potentialCallee.ID != caller.ID && potentialCallee.Status == statusIdle {
			log.Printf("Sending incoming_call for %s to idle client %s", msg.CallID, potentialCallee.ID)
			if err := conn.WriteJSON(incomingCallMsg); err != nil {
				log.Printf("Error sending incoming_call to %s: %v", potentialCallee.ID, err)
				// Consider marking this client for cleanup if write fails
			}
			idleClientCount++
		}
	}
	clientsMu.RUnlock()

	if idleClientCount == 0 {
		log.Printf("No idle clients found for call %s initiated by %s.", msg.CallID, caller.ID)
		// Notify caller that no one is available
		caller.Conn.WriteJSON(Message{Type: "error", CallID: msg.CallID, Data: "No idle users available to call."})
		clientsMu.Lock()
		caller.Status = statusIdle // Reset caller's status
		caller.CallID = ""
		caller.isCaller = false
		clientsMu.Unlock()
	}
}

func handleAcceptCall(callee *ClientInfo, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	clientsMu.Lock() // Lock clientsMu as well for updating client statuses
	defer clientsMu.Unlock()

	if _, roomExists := rooms[msg.CallID]; roomExists {
		log.Printf("Call %s already taken. Client %s tried to accept.", msg.CallID, callee.ID)
		callee.Conn.WriteJSON(Message{Type: "call_taken", CallID: msg.CallID, Data: "This call has already been accepted."})
		return
	}

	// Find the original caller
	var caller *ClientInfo
	for _, c := range clientsByID { // Iterate through clientsByID for easier lookup
		if c.CallID == msg.CallID && c.isCaller {
			caller = c
			break
		}
	}

	if caller == nil || caller.Status != statusCalling {
		log.Printf("No active caller found for call ID %s, or caller not in 'calling' state. Callee: %s", msg.CallID, callee.ID)
		callee.Conn.WriteJSON(Message{Type: "error", CallID: msg.CallID, Data: "Call not found or caller no longer available."})
		return
	}
	
	if callee.Status != statusIdle {
        log.Printf("Client %s tried to accept call %s but is not idle (status: %s)", callee.ID, msg.CallID, callee.Status)
        callee.Conn.WriteJSON(Message{Type: "error", CallID: msg.CallID, Data: "Cannot accept call, you are not idle."})
        return
    }


	// Create the room
	room := &Room{
		ID:           msg.CallID,
		Participants: make(map[*websocket.Conn]bool),
	}
	room.Participants[caller.Conn] = true
	room.Participants[callee.Conn] = true
	rooms[msg.CallID] = room

	// Update statuses
	caller.Status = statusInCall
	callee.Status = statusInCall
	callee.CallID = msg.CallID // Ensure callee's callID is set
	callee.isCaller = false    // Callee is not the initiator

	log.Printf("Call %s accepted by %s. Room created with caller %s.", msg.CallID, callee.ID, caller.ID)

	// Send the answer back to the original caller
	answerMsg := Message{
		Type:   "answer",
		CallID: msg.CallID,
		Data:   msg.Data, // This is the answer SDP from the callee
	}
	if err := caller.Conn.WriteJSON(answerMsg); err != nil {
		log.Printf("Error sending answer to caller %s for call %s: %v", caller.ID, msg.CallID, err)
		// Handle error, potentially tear down room
	}

	// Notify other potential callees that the call was taken
	takenMsg := Message{Type: "call_taken", CallID: msg.CallID}
	for conn, otherClient := range clients { // Iterate through the main clients map (conn -> ClientInfo)
		// Check if this otherClient was a potential callee for this call
		// This is a bit tricky without explicitly tracking who received the "incoming_call"
		// A simpler approach: send to all clients that are NOT the caller or the current callee,
		// and let the client-side logic decide if the modal was for this callID.
		if otherClient.ID != caller.ID && otherClient.ID != callee.ID {
			if err := conn.WriteJSON(takenMsg); err != nil {
				log.Printf("Error sending call_taken to %s: %v", otherClient.ID, err)
			}
		}
	}
}

func handleRejectCall(client *ClientInfo, msg Message) {
	log.Printf("Client %s rejected call %s. Reason: %s", client.ID, msg.CallID, msg.Reason)
	// Optional: Notify the original caller that *a* callee rejected.
	// This can get noisy if many reject. A simple log might be enough.
	// If you want to notify, find the caller by msg.CallID and send a specific message.
	// For now, the server just logs this. The client-side modal handles UI.
}

func handleICECandidate(sender *ClientInfo, msg Message) {
	roomsMu.RLock() // Use RLock as we are only reading the rooms map
	room, exists := rooms[msg.CallID]
	roomsMu.RUnlock()

	if !exists {
		log.Printf("ICE candidate for non-existent room %s from %s. Ignoring.", msg.CallID, sender.ID)
		return
	}

	// Relay ICE candidate to the other participant in the room
	iceMsg := Message{
		Type:   "ice-candidate",
		CallID: msg.CallID,
		Data:   msg.Data,
	}
	forwarded := false
	for participantConn := range room.Participants {
		if participantConn != sender.Conn { // Don't send back to self
			if err := participantConn.WriteJSON(iceMsg); err != nil {
				log.Printf("Error sending ICE candidate to participant in room %s: %v", msg.CallID, err)
			} else {
				log.Printf("Relayed ICE candidate from %s for call %s to other participant.", sender.ID, msg.CallID)
				forwarded = true
			}
		}
	}
	if !forwarded {
		log.Printf("ICE candidate from %s for call %s had no other participant to relay to.", sender.ID, msg.CallID)
	}
}

// handleHangupInternal is called on explicit hangup or unexpected disconnect
func handleHangupInternal(disconnectedClientConn *websocket.Conn, callID string, reason string) {
	if callID == "" {
		log.Printf("Hangup attempt with no callID for client. Reason: %s", reason)
		return // No specific call to hang up from
	}

	roomsMu.Lock()
	defer roomsMu.Unlock()
	clientsMu.Lock() // Also lock clients for status updates
	defer clientsMu.Unlock()

	room, roomExists := rooms[callID]
	if !roomExists {
		log.Printf("Hangup for non-existent room %s. Reason: %s", callID, reason)
		// Client might have been 'calling' but no room was formed yet.
		// Find the client who was 'calling' with this callID and reset their status.
		for _, c := range clientsByID {
			if c.CallID == callID && c.Status == statusCalling {
				log.Printf("Resetting status for client %s who was calling (call %s never formed).", c.ID, callID)
				c.Status = statusIdle
				c.CallID = ""
				c.isCaller = false
				// Notify them if it was an explicit hangup request from them
				if c.Conn == disconnectedClientConn && reason == "hangup_request" {
					// No one to notify if room wasn't formed
				}
				break
			}
		}
		return
	}

	log.Printf("Processing hangup for room %s. Disconnected client conn: %p. Reason: %s", callID, disconnectedClientConn, reason)

	// Notify other participants in the room
	hangupMsg := Message{Type: "peer_disconnected", CallID: callID, Data: reason}
	for participantConn := range room.Participants {
		if participantConn != disconnectedClientConn { // Don't send to the client who initiated the hangup/disconnected
			log.Printf("Notifying participant in room %s about hangup.", callID)
			if err := participantConn.WriteJSON(hangupMsg); err != nil {
				log.Printf("Error sending hangup notification in room %s: %v", callID, err)
			}
		}
		// Reset status of all participants in this room
		if pInfo, ok := clients[participantConn]; ok {
			log.Printf("Resetting status for participant %s from room %s.", pInfo.ID, callID)
			pInfo.Status = statusIdle
			pInfo.CallID = ""
			pInfo.isCaller = false
		}
	}

	// Delete the room
	delete(rooms, callID)
	log.Printf("Room %s deleted.", callID)
}


func main() {
	// Serve static files for the client (HTML, JS, CSS)
	// Ensure your client files are in a "./client" directory relative to where the server binary runs.
	fs := http.FileServer(http.Dir("./client"))
	http.Handle("/", fs)

	http.HandleFunc("/ws", handleConnections)

	log.Println("HTTP server started on :8000. WebSocket on /ws")
	err := http.ListenAndServe(":8000", nil)
	if err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
}