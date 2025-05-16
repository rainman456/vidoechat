package main

import (
	"log"
	"net/http"
	"sync"
	//"time" // Import time for keepalive interval

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Client statuses - Reflecting the call state more accurately
const (
	StatusIdle    = "idle"     // Client is connected and available for a call
	StatusCalling = "calling"  // Client has initiated a call and is waiting for a callee to accept
	StatusRinging = "ringing"  // Client is receiving an incoming call notification
	StatusInCall  = "in-call"  // Client is in an active call
)

// upgrader upgrades HTTP connections to WebSocket connections
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// CheckOrigin: func(r *http.Request) bool { return true }, // Disabled for demo simplicity
	CheckOrigin: func(r *http.Request) bool {
		// Basic origin check for demo - In production, validate against your actual domain(s)
		// For localhost development, this allows requests from localhost
		origin := r.Header.Get("Origin")
		log.Printf("Checking origin: %s", origin)
		// Allow localhost origins for development
		if origin == "http://localhost:8000" || origin == "http://127.0.0.1:8000" {
			return true
		}
		// Add other allowed origins for deployment
		// if origin == "https://your-production-domain.com" {
		// 	return true
		// }
		//log.Printf("Blocked connection from origin: %s", origin)
		return true
	},
}

// ClientInfo stores info about each connected client
type ClientInfo struct {
	Conn     *websocket.Conn
	ID       string
	Status   string
	CallID   string // The ID of the call the client is currently involved in (as caller, callee, or in-call)
	IsCaller bool   // True if this client initiated the current call attempt/session
	// Add a channel to signal closure if needed for more complex goroutine management
	// stop chan struct{}
}

// Message is the JSON structure for WebSocket communication
type Message struct {
	Type     string `json:"type"`
	CallID   string `json:"callId,omitempty"`
	Data     string `json:"data,omitempty"`     // SDP or ICE candidate
	CallerID string `json:"callerId,omitempty"` // Initiator client ID (sent in incoming_call)
	Reason   string `json:"reason,omitempty"`   // Optional rejection/hangup reason
	// Add fields for presence if needed, e.g., "status": "idle", "capabilities": ["video"]
}

// Room represents an active call session with participants
type Room struct {
	ID           string
	Participants map[*websocket.Conn]bool // Using map for easy lookup
	// Could store participant ClientInfo pointers here instead of connections
	CallerConn *websocket.Conn
	CalleeConn *websocket.Conn
}

var (
	clients     = make(map[*websocket.Conn]*ClientInfo)
	clientsByID = make(map[string]*ClientInfo) // Map client ID to ClientInfo pointer
	rooms       = make(map[string]*Room)       // Map CallID to Room
	// Mutexes for concurrent access to maps
	clientsMu sync.RWMutex
	roomsMu   sync.RWMutex
)

// helper: safely send a message to a client connection
func sendMessage(conn *websocket.Conn, msg Message) {
	if conn == nil {
		log.Println("Attempted to send message to nil connection")
		return
	}
	if err := conn.WriteJSON(msg); err != nil {
		// Log error but don't necessarily remove client here, handle in read loop
		log.Printf("Error sending message to client %s: %v", clients[conn].ID, err)
	}
}

// helper: reset client state to idle
func resetClientState(client *ClientInfo) {
	if client == nil {
		return
	}
	log.Printf("Resetting state for client %s (was %s, call %s)", client.ID, client.Status, client.CallID)
	client.Status = StatusIdle
	client.CallID = ""
	client.IsCaller = false
}

// Goroutine to handle incoming messages for a single client
func handleMessages(client *ClientInfo) {
	defer func() {
		// Clean up client state on disconnect
		clientsMu.Lock()
		// Check if the client still exists in the map before accessing
		if c, ok := clients[client.Conn]; ok {
			log.Printf("Client %s read loop breaking. Status: %s, CallID: %s", c.ID, c.Status, c.CallID)
			// If the client was in a call or attempting one, handle hangup
			if c.Status == StatusInCall || c.Status == StatusCalling || c.Status == StatusRinging {
				// Pass the connection that is disconnecting
				handleHangupInternal(client.Conn, c.CallID, "peer_disconnected_unexpectedly")
			}
			delete(clientsByID, c.ID)
			delete(clients, client.Conn)
			log.Printf("Client %s removed. Total clients: %d", client.ID, len(clients))
		} else {
			log.Printf("Client %s not found in map during disconnect cleanup.", client.ID)
		}
		clientsMu.Unlock()
		client.Conn.Close() // Ensure connection is closed
	}()

	// Set a read deadline to prevent stale connections from holding resources indefinitely
	// client.Conn.SetReadDeadline(time.Now().Add(60 * time.Second)) // Example deadline

	for {
		var msg Message
		// ReadJSON is blocking, will return error if connection is closed or error occurs
		err := client.Conn.ReadJSON(&msg)
		if err != nil {
			// Check for specific WebSocket close errors
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNormalClosure) {
				log.Printf("Client %s unexpected close error: %v", client.ID, err)
			} else {
				log.Printf("Client %s read error: %v", client.ID, err)
			}
			return // Exit the goroutine
		}

		// Reset read deadline after a successful read (if using deadlines)
		// client.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		log.Printf("Received from %s (Status: %s, CallID: %s): Type=%s, MsgCallID=%s",
			client.ID, client.Status, client.CallID, msg.Type, msg.CallID)

		// Process message based on type and client's current state
		switch msg.Type {
		case "initiate_call":
			// Only allow initiating if currently idle
			if client.Status == StatusIdle {
				handleInitiateCall(client, msg)
			} else {
				log.Printf("Client %s tried to initiate call but status is %s", client.ID, client.Status)
				sendMessage(client.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Cannot initiate call, already busy."})
			}

		case "accept_call":
			// Only allow accepting if currently ringing for this call
			if client.Status == StatusRinging && client.CallID == msg.CallID {
				handleAcceptCall(client, msg)
			} else {
				log.Printf("Client %s tried to accept call %s but status is %s (expected ringing)", client.ID, msg.CallID, client.Status)
				sendMessage(client.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Cannot accept call, you are not ringing or wrong call ID."})
			}

		case "reject_call":
			// Only allow rejecting if currently ringing for this call
			if client.Status == StatusRinging && client.CallID == msg.CallID {
				handleRejectCall(client, msg)
			} else {
				log.Printf("Client %s tried to reject call %s but status is %s (expected ringing)", client.ID, msg.CallID, client.Status)
				// Optionally send error, but maybe just ignore if not ringing for this call
			}

		case "ice-candidate":
			// Only process ICE candidates if in a call or attempting one with matching call ID
			if (client.Status == StatusInCall || client.Status == StatusCalling || client.Status == StatusRinging) && client.CallID == msg.CallID {
				handleICECandidate(client, msg)
			} else {
				log.Printf("Client %s sent ICE candidate for call %s but status is %s (expected in-call/calling/ringing)", client.ID, msg.CallID, client.Status)
				// Optionally send error or ignore
			}

		case "hangup":
			// Allow hangup if in a call or attempting one with matching call ID
			if (client.Status == StatusInCall || client.Status == StatusCalling || client.Status == StatusRinging) && client.CallID == msg.CallID {
				handleHangupInternal(client.Conn, msg.CallID, "hangup_request")
			} else {
				log.Printf("Client %s sent hangup for call %s but status is %s", client.ID, msg.CallID, client.Status)
				// Optionally send error or ignore
			}

		case "ping":
			// Respond to ping with pong (optional, but good practice)
			// sendMessage(client.Conn, Message{Type: "pong"})
			// The frontend doesn't send 'ping' explicitly, but keepalive could use it.
			// The current frontend sends {type: "ping"}
			sendMessage(client.Conn, Message{Type: "pong"}) // Respond with pong

		default:
			log.Printf("Unknown message type from %s: %s", client.ID, msg.Type)
			sendMessage(client.Conn, Message{Type: "error", Data: "Unknown message type"})
		}
	}
}

// handleConnections upgrades HTTP to WebSocket and sets up client handling
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

	// Start a goroutine to handle messages for this client
	go handleMessages(client)

	// Optional: Start a goroutine for writing/pings if needed,
	// but the current frontend sends pings and expects pong responses.
	// The ReadJSON loop handles detecting disconnects.
}

// handleInitiateCall finds an idle peer and starts the call negotiation
func handleInitiateCall(caller *ClientInfo, msg Message) {
	clientsMu.Lock()
	defer clientsMu.Unlock()

	// Find an idle callee
	var callee *ClientInfo
	for _, c := range clientsByID {
		// Ensure it's not the caller and the client is idle
		if c.ID != caller.ID && c.Status == StatusIdle {
			callee = c
			break // Found an idle callee, auto-match
		}
	}

	if callee == nil {
		log.Printf("No idle clients available for %s", caller.ID)
		sendMessage(caller.Conn, Message{Type: "error", CallID: msg.CallID, Data: "No idle users available."})
		// Keep caller in Idle state if no one is available
		return
	}

	// --- Found a Callee, start the negotiation ---
	callID := uuid.New().String() // Server generates the official CallID
	log.Printf("Auto-matching client %s (caller) with %s (callee) for call %s", caller.ID, callee.ID, callID)

	// Update states and assign CallID
	caller.Status = StatusCalling // Caller is waiting for acceptance
	caller.CallID = callID
	caller.IsCaller = true

	callee.Status = StatusRinging // Callee is being notified
	callee.CallID = callID
	callee.IsCaller = false // Callee is not the initiator

	// Send incoming_call message to the callee
	sendMessage(callee.Conn, Message{
		Type:     "incoming_call",
		CallID:   callID,
		Data:     msg.Data,     // Pass the Offer SDP from the caller
		CallerID: caller.ID, // Send the caller's ID
	})

	// Send a confirmation back to the caller (optional, but good for UI)
	// The frontend expects an 'answer' message eventually, but we can send
	// a 'calling' confirmation now. Let's stick to the frontend's expected flow
	// where it transitions after receiving the 'answer' from the callee.
	// So, no message back to the caller here yet, they wait for the callee's answer.

	log.Printf("Sent incoming_call to %s for call %s from %s", callee.ID, callID, caller.ID)
}

// handleAcceptCall processes the callee's acceptance and forwards the answer
func handleAcceptCall(callee *ClientInfo, msg Message) {
	// Lock rooms then clients to avoid deadlock
	roomsMu.Lock()
	defer roomsMu.Unlock()
	clientsMu.Lock()
	defer clientsMu.Unlock()

	// Find the caller for this call ID
	var caller *ClientInfo
	for _, c := range clientsByID {
		// Find the client that initiated this specific call attempt and is in the Calling state
		if c.CallID == msg.CallID && c.IsCaller && c.Status == StatusCalling {
			caller = c
			break
		}
	}

	// Validate the state and existence of caller and callee
	if caller == nil {
		log.Printf("Accept call %s failed: Caller not found or not in 'calling' state.", msg.CallID)
		sendMessage(callee.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Call not found or caller unavailable."})
		// Reset callee state as they can't proceed with this call
		resetClientState(callee)
		return
	}

	if callee.Status != StatusRinging || callee.CallID != msg.CallID {
		log.Printf("Accept call %s failed: Callee %s not in 'ringing' state or wrong call ID (status: %s, callID: %s)",
			msg.CallID, callee.ID, callee.Status, callee.CallID)
		sendMessage(callee.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Cannot accept this call."})
		// Keep callee state as is, maybe they accepted the wrong call ID?
		return
	}

	// --- Call accepted, establish the room and transition to InCall ---
	log.Printf("Call %s accepted by %s; caller is %s", msg.CallID, callee.ID, caller.ID)

	// Create the room
	room := &Room{
		ID:           msg.CallID,
		Participants: map[*websocket.Conn]bool{caller.Conn: true, callee.Conn: true},
		CallerConn:   caller.Conn, // Store connections directly for easy lookup
		CalleeConn:   callee.Conn,
	}
	rooms[msg.CallID] = room

	// Transition both clients to InCall state
	caller.Status = StatusInCall
	callee.Status = StatusInCall
	// CallID remains the same

	// Send the Answer SDP to the caller
	sendMessage(caller.Conn, Message{
		Type:   "answer",
		CallID: msg.CallID,
		Data:   msg.Data, // This is the Answer SDP from the callee
	})

	// Notify other clients that this call ID is now taken (optional for auto-match,
	// but good if multiple clients *could* have received the incoming_call,
	// although the current logic only sends to one).
	// takenMsg := Message{Type: "call_taken", CallID: msg.CallID}
	// for conn, c := range clients {
	// 	if c.ID != caller.ID && c.ID != callee.ID {
	// 		sendMessage(conn, takenMsg)
	// 	}
	// }

	log.Printf("Sent answer to caller %s for call %s. Clients %s and %s are now in-call.", caller.ID, msg.CallID, caller.ID, callee.ID)
}

// handleRejectCall processes the callee's rejection
func handleRejectCall(callee *ClientInfo, msg Message) {
	clientsMu.Lock()
	defer clientsMu.Unlock()

	// Find the caller for this call ID
	var caller *ClientInfo
	for _, c := range clientsByID {
		// Find the client that initiated this specific call attempt and is in the Calling state
		if c.CallID == msg.CallID && c.IsCaller && c.Status == StatusCalling {
			caller = c
			break
		}
	}

	// Validate the state and existence of caller and callee
	if caller == nil {
		log.Printf("Reject call %s failed: Caller not found or not in 'calling' state.", msg.CallID)
		// Callee's state will be reset below if they are in Ringing state for this call
		return
	}

	if callee.Status != StatusRinging || callee.CallID != msg.CallID {
		log.Printf("Reject call %s failed: Callee %s not in 'ringing' state or wrong call ID (status: %s, callID: %s)",
			msg.CallID, callee.ID, callee.Status, callee.CallID)
		// Ignore rejection if not in the correct state for this call
		return
	}

	// --- Call rejected ---
	log.Printf("Call %s rejected by %s. Notifying caller %s.", msg.CallID, callee.ID, caller.ID)

	// Notify the caller that the call was rejected
	sendMessage(caller.Conn, Message{
		Type:   "call_rejected",
		CallID: msg.CallID,
		Reason: msg.Reason, // Pass the rejection reason if any
	})

	// Reset states of both caller and callee
	resetClientState(caller)
	resetClientState(callee)

	// No room was created, so no need to delete a room
}

// handleICECandidate forwards ICE candidates between participants in a room
func handleICECandidate(sender *ClientInfo, msg Message) {
	roomsMu.RLock()
	room, exists := rooms[msg.CallID]
	roomsMu.RUnlock()

	if !exists {
		log.Printf("ICE candidate received for unknown or inactive room %s from %s", msg.CallID, sender.ID)
		// Optionally send an error back to the sender
		// sendMessage(sender.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Call not active for ICE candidate."})
		return
	}

	// Find the recipient connection in the room
	var recipientConn *websocket.Conn
	if room.CallerConn == sender.Conn {
		recipientConn = room.CalleeConn
	} else if room.CalleeConn == sender.Conn {
		recipientConn = room.CallerConn
	} else {
		log.Printf("ICE candidate received from client %s not in room %s participants", sender.ID, msg.CallID)
		// Optionally send an error back
		// sendMessage(sender.Conn, Message{Type: "error", CallID: msg.CallID, Data: "Not a participant in this call."})
		return
	}

	// Forward the ICE candidate message
	iceMsg := Message{
		Type:   "ice-candidate",
		CallID: msg.CallID,
		Data:   msg.Data, // The ICE candidate data
	}

	log.Printf("Forwarding ICE candidate for call %s from %s to other participant", msg.CallID, sender.ID)
	sendMessage(recipientConn, iceMsg)
}

// handleHangupInternal cleans up state and notifies the other peer when a hangup occurs
// disconnectedConn is the connection that initiated the hangup or disconnected
func handleHangupInternal(disconnectedConn *websocket.Conn, callID string, reason string) {
	if callID == "" {
		log.Printf("Hangup called with empty callID, reason: %s", reason)
		return // Nothing to hang up if no call ID is associated
	}

	// Lock rooms then clients
	roomsMu.Lock()
	defer roomsMu.Unlock()
	clientsMu.Lock()
	defer clientsMu.Unlock()

	// Check if the room exists (meaning the call was established)
	room, roomExists := rooms[callID]

	if roomExists {
		log.Printf("Processing hangup for active room %s, reason: %s", callID, reason)

		// Find the other participant's connection
		var otherParticipantConn *websocket.Conn
		if room.CallerConn == disconnectedConn {
			otherParticipantConn = room.CalleeConn
		} else if room.CalleeConn == disconnectedConn {
			otherParticipantConn = room.CallerConn
		} else {
			log.Printf("Hangup from client not found in room %s participants. CallID: %s, Reason: %s", callID, callID, reason)
			// Client was somehow associated with a call ID but not in the room?
			// Try to find the client by connection and reset their state anyway
			if clientInfo, ok := clients[disconnectedConn]; ok {
				resetClientState(clientInfo)
			}
			// No other participant to notify if the disconnector wasn't in the room map
			return
		}

		// Notify the other participant that the peer disconnected/hung up
		hangupMsg := Message{Type: "peer_disconnected", CallID: callID, Reason: reason}
		sendMessage(otherParticipantConn, hangupMsg)

		// Reset states of both participants
		if clientInfo, ok := clients[disconnectedConn]; ok {
			resetClientState(clientInfo)
		}
		if clientInfo, ok := clients[otherParticipantConn]; ok {
			resetClientState(clientInfo)
		}

		// Delete the room
		delete(rooms, callID)
		log.Printf("Deleted room %s after hangup", callID)

	} else {
		// Room did not exist, meaning the call was not fully established (e.g., in Calling or Ringing state)
		log.Printf("Processing hangup for unestablished call %s, reason: %s", callID, reason)

		// Find the client who initiated the hangup/disconnection
		client := clients[disconnectedConn] // This should exist if handleMessages defer is called

		// If the client was in Calling or Ringing state for this CallID, find the other party
		if client != nil && (client.Status == StatusCalling || client.Status == StatusRinging) && client.CallID == callID {
			var otherParty *ClientInfo
			// Find the other client involved in this call attempt
			for _, c := range clientsByID {
				if c.CallID == callID && c.ID != client.ID {
					otherParty = c
					break
				}
			}

			if otherParty != nil {
				log.Printf("Notifying other party %s of unestablished call %s hangup from %s", otherParty.ID, callID, client.ID)
				// Notify the other party that the call attempt ended
				// Use a specific message type or peer_disconnected with a reason
				notifyMsg := Message{Type: "call_attempt_ended", CallID: callID, Reason: reason}
				sendMessage(otherParty.Conn, notifyMsg)
				// Reset the other party's state as well
				resetClientState(otherParty)
			}
		}

		// Reset the state of the client who initiated the hangup/disconnection
		if client != nil {
			resetClientState(client)
		}
		// No room to delete
	}
}

func main() {
	// Serve static files from the "./client" directory
	http.Handle("/", http.FileServer(http.Dir("./client")))

	// Handle WebSocket connections at the "/ws" endpoint
	http.HandleFunc("/ws", handleConnections)

	log.Println("Signaling server started on :8000")
	log.Println("Serving static files from ./client")

	// Start the HTTP server
	err := http.ListenAndServe(":8000", nil)
	if err != nil {
		log.Fatalf("ListenAndServe error: %v", err)
	}
}
