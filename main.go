package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	StatusIdle    = "idle"
	StatusCalling = "calling"
	StatusRinging = "ringing"
	StatusInCall  = "in-call"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:   1024,
	WriteBufferSize:  1024,
	HandshakeTimeout: 10 * time.Second,
	EnableCompression: true,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for development
	},
}

type ClientInfo struct {
	Conn     *websocket.Conn
	ID       string
	Status   string
	CallID   string
	IsCaller bool
	LastSeen time.Time
}

type Message struct {
	Type     string `json:"type"`
	CallID   string `json:"callId,omitempty"`
	Data     string `json:"data,omitempty"`
	CallerID string `json:"callerId,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Peers    []Peer `json:"peers,omitempty"`
	PeerID   string `json:"peerId,omitempty"`
	Status   string `json:"status,omitempty"`
}

type Peer struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type Room struct {
	ID           string
	Participants map[*websocket.Conn]bool
	CallerConn   *websocket.Conn
	CalleeConn   *websocket.Conn
}

var (
	clients     = make(map[*websocket.Conn]*ClientInfo)
	clientsByID = make(map[string]*ClientInfo)
	rooms       = make(map[string]*Room)
	clientsMu   sync.RWMutex
	roomsMu     sync.RWMutex
)

func sendMessage(conn *websocket.Conn, msg Message) {
	 if err := conn.WriteJSON(msg); err != nil {
        log.Printf("Error sending message: %v", err)
        var clientIDForLog string // For logging after removal
        clientsMu.Lock()
        if client, exists := clients[conn]; exists {
            clientIDForLog = client.ID // Get ID for logging before deletion
            conn.Close()
            delete(clientsByID, client.ID)
            delete(clients, conn)
            log.Printf("Removed client %s due to write failure", clientIDForLog) // Use stored ID
            // clientsMu.Unlock() // Moved down
            // broadcastPeerList() // MOVED
        } // else: client might have been removed by another goroutine, which is fine.
        clientsMu.Unlock() // Correct place to unlock

        if clientIDForLog != "" { // Only broadcast if a client was actually removed by this instance
            broadcastPeerList() // Call AFTER releasing the lock
        }
        return // Ensure function returns after handling error
    }
}

func broadcastPeerList() {
	clientsMu.RLock()
	peers := make([]Peer, 0, len(clientsByID))
	for _, c := range clientsByID {
		peers = append(peers, Peer{
			ID:     c.ID,
			Status: c.Status,
		})
	}
	conns := make([]*websocket.Conn, 0, len(clients))
	for conn := range clients {
		conns = append(conns, conn)
	}
	clientsMu.RUnlock()

	msg := Message{
		Type:  "peer_list",
		Peers: peers,
	}

	log.Printf("Broadcasting %d peers", len(peers))
	for _, p := range peers {
		log.Printf("Peer: %s - %s", p.ID, p.Status)
	}

	for _, conn := range conns {
		go sendMessage(conn, msg)
	}
}

func startPingSender(client *ClientInfo) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			clientsMu.RLock()
			if _, ok := clients[client.Conn]; !ok {
				clientsMu.RUnlock()
				return
			}
			clientsMu.RUnlock()

			if err := client.Conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(5*time.Second)); err != nil {
				log.Printf("Error sending ping to %s: %v", client.ID, err)
				return
			}
		}
	}
}

func checkClientTimeouts() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
        <-ticker.C
        clientsToTimeout := make(map[*websocket.Conn]*ClientInfo) // Collect clients to remove

        clientsMu.RLock() // Use RLock for initial scan
        now := time.Now()
        for conn, client := range clients {
            if now.Sub(client.LastSeen) > 2*time.Minute {
                clientsToTimeout[conn] = client
            }
        }
        clientsMu.RUnlock()

        if len(clientsToTimeout) > 0 {
            clientsMu.Lock()
            for conn, client := range clientsToTimeout {
                // Double-check if client still exists and is the same one,
                // as it might have been removed/reconnected between RUnlock and Lock.
                if currentClient, exists := clients[conn]; exists && currentClient.ID == client.ID {
                    log.Printf("Client %s timed out", client.ID)
                    conn.Close()
                    delete(clientsByID, client.ID)
                    delete(clients, conn)
                }
            }
            clientsMu.Unlock()
            broadcastPeerList() // Call AFTER releasing lock and if changes were made
        }
    }

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade failed: %v", err)
		return
	}

	clientID := uuid.New().String()
	client := &ClientInfo{
		Conn:     ws,
		ID:       clientID,
		Status:   StatusIdle,
		LastSeen: time.Now(),
	}

	clientsMu.Lock()
	clients[ws] = client
	clientsByID[clientID] = client
	clientsMu.Unlock()

	log.Printf("Client %s connected", clientID)
	broadcastPeerList()

	go handleClient(client)
}

func handleClient(client *ClientInfo) {
	// Set pong handler
	client.Conn.SetPongHandler(func(string) error {
		clientsMu.Lock()
		if c, ok := clients[client.Conn]; ok {
			c.LastSeen = time.Now()
		}
		clientsMu.Unlock()
		return nil
	})
	client.Conn.SetCloseHandler(func(code int, text string) error {
		log.Printf("Client %s sent close: %s", client.ID, text)
		return nil
	})

	go startPingSender(client)

	defer func() {
        log.Printf("Client %s disconnecting...", client.ID)

        // Step 1: Determine if a hangup is needed based on client's last known state from maps.
        var callIDToHangup string
        var originalConn = client.Conn // Keep original conn for closing at the very end.

        clientsMu.RLock()
        // Fetch the most current state of this client from the global map
        clientStateFromMap, stillConnected := clients[originalConn]
        if stillConnected {
            // Use the state from the map, not the 'client' parameter which might be stale
            if clientStateFromMap.Status == StatusInCall || clientStateFromMap.Status == StatusCalling || clientStateFromMap.Status == StatusRinging {
                callIDToHangup = clientStateFromMap.CallID
            }
        }
        clientsMu.RUnlock()

        // Step 2: Perform hangup if necessary (this function will handle its own locks)
        if callIDToHangup != "" {
            log.Printf("Client %s was in call %s. Handling hangup.", client.ID, callIDToHangup)
            handleHangup(originalConn, callIDToHangup, "disconnected")
        }

        // Step 3: Remove client from global maps
        clientsMu.Lock()
        // Check again before deleting, as handleHangup might have already done it
        // or another process (timeout).
        if c, exists := clients[originalConn]; exists {
             // Only delete if it's the same client instance ID to prevent races
            if c.ID == client.ID {
                delete(clientsByID, client.ID) // Use the original client.ID from the parameter
                delete(clients, originalConn)
                log.Printf("Client %s removed from maps.", client.ID)
            } else {
                log.Printf("Client %s (conn %p) was replaced by %s. Not removing via original client's defer.", client.ID, originalConn, c.ID)
            }
        } else {
            log.Printf("Client %s (conn %p) already removed from 'clients' map.", client.ID, originalConn)
            // It's possible it's still in clientsByID if removal was partial elsewhere, ensure cleanup.
             if _, idExists := clientsByID[client.ID]; idExists {
                 delete(clientsByID, client.ID)
                 log.Printf("Client %s removed from 'clientsByID' map as a fallback.", client.ID)
             }
        }
        clientsMu.Unlock()

        // Step 4: Close the connection
        if originalConn != nil {
            originalConn.Close()
        }

        log.Printf("Broadcasting updated peer list after client %s disconnect.", client.ID)
        broadcastPeerList() // This function correctly handles its own locking
    }()


	for {
		//client.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		_, r, err := client.Conn.NextReader()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Client %s disconnected unexpectedly: %v", client.ID, err)
			}
			return
		}

		var msg Message
		if err := json.NewDecoder(r).Decode(&msg); err != nil {
			log.Printf("Error decoding message from %s: %v", client.ID, err)
			continue
		}

		client.LastSeen = time.Now()
		log.Printf("Received from %s: %+v", client.ID, msg)

		switch msg.Type {
		case "initiate_call":
			handleInitiateCall(client, msg)
		case "accept_call":
			handleAcceptCall(client, msg)
		case "offer":
            handleOffer(client, msg)
		case "reject_call":
			handleRejectCall(client, msg)
		case "ice-candidate":
			handleICECandidate(client, msg)
		case "hangup":
			handleHangup(client.Conn, msg.CallID, "hangup")
		case "ping":
			sendMessage(client.Conn, Message{Type: "pong"})
		case "register":
			handleRegister(client, msg)
		case "presence_update":
			handlePresenceUpdate(client, msg)
		
		default:
			sendMessage(client.Conn, Message{Type: "error", Data: "Unknown message type"})
		}
	}
}

func handleRegister(client *ClientInfo, msg Message) {
	clientsMu.Lock()
	client.Status = StatusIdle
	clientsMu.Unlock()

	sendMessage(client.Conn, Message{
		Type:   "register_success",
		PeerID: client.ID,
	})

	broadcastPeerList()
}

func handleInitiateCall(caller *ClientInfo, msg Message) {
    //clientsMu.Lock()
    //defer clientsMu.Unlock()

    // Validate caller state
   var messagesToSend []struct {
        conn *websocket.Conn
        msg  Message
    }
    var calleeIDForBroadcast string
    var callIDForLog string
    var success bool = false

    clientsMu.Lock()
    // Validate caller state
    if caller.Status != StatusIdle {
        clientsMu.Unlock() // Release lock before sending
        sendMessage(caller.Conn, Message{Type: "error", Data: "Already in a call", CallID: msg.CallID})
        return
    }

    // Validate offer data
    if msg.Data == "" {
        sendMessage(caller.Conn, Message{
            Type: "error",
            Data: "Missing offer data",
            CallID: msg.CallID,
        })
        return
    }

    llog.Printf("Client %s initiating call with ID %s", caller.ID, msg.CallID)
    var callee *ClientInfo
    for _, c := range clientsByID { // Iterate over clientsByID as it's ID-indexed
        if c.ID != caller.ID && c.Status == StatusIdle {
            callee = c
            break
        }
    }

    if callee == nil {
        clientsMu.Unlock() // Release lock before sending
        sendMessage(caller.Conn, Message{Type: "error", Data: "No available peers", CallID: msg.CallID})
        return
    }

    callID := msg.CallID
    if callID == "" {
        callID = uuid.New().String()
        log.Printf("Generated new call ID: %s", callID)
    }
    callIDForLog = callID // For logging after unlock

    // Update caller state
    caller.Status = StatusCalling
    caller.CallID = callID
    caller.IsCaller = true

    // Update callee state
    callee.Status = StatusRinging
    callee.CallID = callID
    callee.IsCaller = false
    calleeIDForBroadcast = callee.ID // For logging & message prep

    // Prepare messages BEFORE room lock, using data already protected by clientsMu
    messagesToSend = append(messagesToSend, struct{conn *websocket.Conn; msg Message}{
        conn: callee.Conn,
        msg: Message{Type: "offer", CallID: callID, Data: msg.Data, CallerID: caller.ID, PeerID: caller.ID},
    })
    messagesToSend = append(messagesToSend, struct{conn *websocket.Conn; msg Message}{
        conn: caller.Conn,
        msg: Message{Type: "call_initiated", CallID: callID, PeerID: callee.ID},
    })

    // Create room
    roomsMu.Lock()
    rooms[callID] = &Room{
        ID:           callID,
        Participants: map[*websocket.Conn]bool{caller.Conn: true, callee.Conn: true},
        CallerConn:   caller.Conn,
        CalleeConn:   callee.Conn,
    }
    roomsMu.Unlock()
    success = true
    clientsMu.Unlock() // ***** RELEASE clientsMu LOCK *****

    // Send messages
    if success {
        for _, m := range messagesToSend {
            go sendMessage(m.conn, m.msg) // Send in goroutine to avoid blocking current handler
        }
        broadcastPeerList()
        log.Printf("Call %s initiated between %s and %s", callIDForLog, caller.ID, calleeIDForBroadcast)
    }

func handlePresenceUpdate(client *ClientInfo, msg Message) {
	if msg.Status == "" {
		return
	}

	clientsMu.Lock()
	client.Status = msg.Status
	client.LastSeen = time.Now()
	clientsMu.Unlock()

	broadcastPeerList() // moved out of lock scope
}

func handleAcceptCall(callee *ClientInfo, msg Message) {
   var callerConnForMessage *websocket.Conn
    var callIDForLog = msg.CallID
    var success bool = false

    clientsMu.Lock() // Take full lock initially for state checks and updates

    caller, callerExists := clientsByID[msg.CallerID]
    if !callerExists || caller == nil {
        clientsMu.Unlock()
        sendMessage(callee.Conn, Message{Type: "error", Data: "Caller not found", CallID: msg.CallID})
        // resetClientState(callee) // This would require clientsMu.Lock again, handle carefully or ensure callee is reset
        return
    }

    // Verify caller is in the expected state for this call
    if caller.CallID != msg.CallID || caller.Status != StatusCalling {
        clientsMu.Unlock()
        sendMessage(callee.Conn, Message{Type: "error", Data: "Call not found or caller not in 'calling' state.", CallID: msg.CallID})
        // resetClientState(callee)
        return
    }
    callerConnForMessage = caller.Conn // Store for sending message later

    // Complete the room setup
    roomsMu.Lock()
    if room, exists := rooms[msg.CallID]; exists {
        room.Participants[callee.Conn] = true
        room.CalleeConn = callee.Conn // Already set in initiate, but confirm
    } else {
        // This is an issue: room doesn't exist for an accepted call.
        roomsMu.Unlock()
        clientsMu.Unlock()
        sendMessage(callee.Conn, Message{Type: "error", Data: "Room for call not found.", CallID: msg.CallID})
        sendMessage(caller.Conn, Message{Type: "error", Data: "Room for call disappeared before acceptance.", CallID: msg.CallID})
        // May need to reset both client states here.
        return
    }
    roomsMu.Unlock()

    caller.Status = StatusInCall
    callee.Status = StatusInCall
    // callee.CallID was already set

    success = true
    clientsMu.Unlock() // ***** RELEASE clientsMu LOCK *****

    if success {
        // Forward the answer to caller
        sendMessage(callerConnForMessage, Message{
            Type:   "answer",
            CallID: msg.CallID,
            Data:   msg.Data,
            PeerID: callee.ID, // Identify who sent the answer
        })
        broadcastPeerList()
        log.Printf("Call %s accepted by %s, now in-call with %s", callIDForLog, callee.ID, msg.CallerID)
    }

func handleOffer(sender *ClientInfo, msg Message) {
    roomsMu.RLock()
    room, exists := rooms[msg.CallID]
    roomsMu.RUnlock()

    if !exists {
        log.Printf("No room found for call %s", msg.CallID)
        return
    }

    var recipient *websocket.Conn
    if sender.Conn == room.CallerConn {
        recipient = room.CalleeConn
    } else {
        recipient = room.CallerConn
    }

    if recipient == nil {
        log.Printf("No recipient found for call %s", msg.CallID)
        return
    }

    log.Printf("Forwarding offer for call %s", msg.CallID)
    sendMessage(recipient, Message{
        Type:   "offer",
        CallID: msg.CallID,
        Data:   msg.Data,
    })
}




func handleRejectCall(callee *ClientInfo, msg Message) {
	 var callerToNotify *ClientInfo
    var messageToSendToCaller Message
    var shouldNotifyCaller bool = false
    var callIDForLog = msg.CallID

    clientsMu.Lock()
    for _, c := range clientsByID { // Iterate clientsByID
        if c.CallID == msg.CallID && c.IsCaller {
            // Ensure caller is in a state that can be rejected (e.g. StatusCalling)
            if c.Status == StatusCalling {
                 callerToNotify = c
                 shouldNotifyCaller = true
                 messageToSendToCaller = Message{Type: "call_rejected", CallID: msg.CallID, Reason: msg.Reason, PeerID: callee.ID}
                 resetClientState(callerToNotify)
            } else {
                log.Printf("RejectCall: Found caller %s for call %s, but status is %s (not 'calling').", c.ID, msg.CallID, c.Status)
            }
            break
        }
    }
    resetClientState(callee)
    clientsMu.Unlock() // ***** RELEASE clientsMu LOCK *****

    // Send notification outside of lock
    if shouldNotifyCaller && callerToNotify != nil {
        sendMessage(callerToNotify.Conn, messageToSendToCaller)
    }

    roomsMu.Lock()
    delete(rooms, msg.CallID)
    roomsMu.Unlock()

    broadcastPeerList()
    log.Printf("Call %s rejected by %s.", callIDForLog, callee.ID)
}

func handleICECandidate(sender *ClientInfo, msg Message) {
	//clientsMu.RLock()
	//defer clientsMu.RUnlock()

	 if sender.CallID != msg.CallID {
        log.Printf("ICE candidate from client %s with mismatched callID: %s (expected %s)", sender.ID, msg.CallID, sender.CallID)
        return
    }

    roomsMu.RLock() // Lock for reading room information
    room, exists := rooms[msg.CallID]
    if !exists {
        roomsMu.RUnlock()
        log.Printf("ICE candidate for non-existing call: %s", msg.CallID)
        return
    }

    var recipient *websocket.Conn
    if room.CallerConn == sender.Conn {
        recipient = room.CalleeConn
    } else if room.CalleeConn == sender.Conn {
        recipient = room.CallerConn
    } else {
        roomsMu.RUnlock()
        log.Printf("ICE candidate sender %s not part of call room %s", sender.ID, msg.CallID)
        return
    }
    roomsMu.RUnlock() // ***** RELEASE roomsMu LOCK *****

    if recipient == nil {
        log.Printf("ICE candidate recipient connection is nil for call %s (sender %s may have disconnected other party)", msg.CallID, sender.ID)
        return
    }

    sendMessage(recipient, Message{
        Type:   "ice-candidate",
        CallID: msg.CallID,
        Data:   msg.Data,
        PeerID: sender.ID, // Identify who this candidate is from
    })
}


func handleHangup(conn *websocket.Conn, callID, reason string) {
	 var otherConn *websocket.Conn
    var clientWhoHungUpID string
    var otherClientID string

    roomsMu.Lock()
    room, exists := rooms[callID]
    if exists {
        if room.CallerConn == conn {
            otherConn = room.CalleeConn
        } else if room.CalleeConn == conn { // Added check to ensure 'conn' is part of the room
            otherConn = room.CallerConn
        } else {
             // conn is not part of this room, log and potentially don't delete
             log.Printf("Hangup from conn %p for callID %s, but conn not in room. Caller: %p, Callee: %p", conn, callID, room.CallerConn, room.CalleeConn)
        }
        delete(rooms, callID) // Delete room if it existed and callID matches
    }
    roomsMu.Unlock()

    var messageForOtherClient Message
    var shouldSendMessageToOther = false

    clientsMu.Lock()
    if c, ok := clients[conn]; ok { // Get ID of client who hung up
        clientWhoHungUpID = c.ID
    }

    if otherConn != nil {
        if client, exists := clients[otherConn]; exists {
            otherClientID = client.ID // Store ID for logging
            messageForOtherClient = Message{Type: "peer_disconnected", CallID: callID, Reason: reason, PeerID: clientWhoHungUpID}
            shouldSendMessageToOther = true
            resetClientState(client)
        }
    }

    if client, ok := clients[conn]; ok {
        resetClientState(client)
    }
    clientsMu.Unlock() // ***** RELEASE clientsMu LOCK *****

    // Send message after lock is released
    if shouldSendMessageToOther && otherConn != nil { // Check otherConn again as it's used outside lock
        log.Printf("Sending peer_disconnected to %s (was %s) because %s hung up", otherClientID, clients[otherConn].ID, reason) // Re-fetch ID for log if needed
        sendMessage(otherConn, messageForOtherClient)
    }

    broadcastPeerList()
    log.Printf("Call %s ended by %s (conn %p). Other party was %s (conn %p). Reason: %s", callID, clientWhoHungUpID, conn, otherClientID, otherConn, reason)
}


func resetClientState(client *ClientInfo) {
	client.Status = StatusIdle
	client.CallID = ""
	client.IsCaller = false
}


func main() {
	go checkClientTimeouts()

	http.Handle("/", http.FileServer(http.Dir("./client")))
	http.HandleFunc("/ws", handleConnections)

	log.Println("Server started on :8000")
	log.Fatal(http.ListenAndServe(":8000", nil))
}