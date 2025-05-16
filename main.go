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
	if conn == nil {
		return
	}
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(msg); err != nil {
		log.Printf("Error sending message: %v", err)

		// Optional: remove dead clients
		clientsMu.Lock()
		if client, exists := clients[conn]; exists {
			conn.Close()
			delete(clientsByID, client.ID)
			delete(clients, conn)
			log.Printf("Removed client %s due to write failure", client.ID)
		}
		clientsMu.Unlock()

		broadcastPeerList()
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
		clientsMu.Lock()
		now := time.Now()
		for conn, client := range clients {
			if now.Sub(client.LastSeen) > 2*time.Minute {
				log.Printf("Client %s timed out", client.ID)
				conn.Close()
				delete(clientsByID, client.ID)
				delete(clients, conn)
			}
		}
		clientsMu.Unlock()
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

	clientsMu.RLock()
	c := clients[client.Conn]
	clientsMu.RUnlock()

	if c.Status == StatusInCall || c.Status == StatusCalling || c.Status == StatusRinging {
		handleHangup(client.Conn, c.CallID, "disconnected")
	}

	clientsMu.Lock()
	delete(clientsByID, c.ID)
	delete(clients, client.Conn)
	clientsMu.Unlock()

	client.Conn.Close()
	log.Printf("Broadcasting updated peer list after client %s disconnect", client.ID)
	broadcastPeerList()
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
    clientsMu.Lock()
    defer clientsMu.Unlock()

    if caller.Status != StatusIdle {
        sendMessage(caller.Conn, Message{Type: "error", Data: "Already in a call"})
        return
    }

    log.Printf("Client %s is initiating a call with offer: %s", caller.ID, msg.Data)

    var callee *ClientInfo
    for _, c := range clientsByID {
        if c.ID != caller.ID && c.Status == StatusIdle {
            callee = c
            break
        }
    }

    if callee == nil {
        sendMessage(caller.Conn, Message{Type: "error", Data: "No available peers"})
        return
    }

    if callee.Status != StatusIdle {
        sendMessage(caller.Conn, Message{Type: "error", Data: "Peer is no longer available"})
        return
    }

    callID := msg.CallID
    if callID == "" {
        callID = uuid.New().String()
    }

    // Create room immediately with just the caller
    roomsMu.Lock()
    rooms[callID] = &Room{
        ID:           callID,
        Participants: map[*websocket.Conn]bool{caller.Conn: true},
        CallerConn:   caller.Conn,
    }
    roomsMu.Unlock()

    // Update states
    caller.Status = StatusCalling
    caller.CallID = callID
    caller.IsCaller = true

    callee.Status = StatusRinging
    callee.CallID = callID
    callee.IsCaller = false

    // Forward the offer directly to callee
    sendMessage(callee.Conn, Message{
        Type:     "offer",  // Changed from "incoming_call" to "offer"
        CallID:   callID,
        Data:     msg.Data,
        CallerID: caller.ID,
    })

    broadcastPeerList()
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
    clientsMu.RLock()
    caller := clientsByID[msg.CallerID]  // Assuming callerID is sent in accept_call
    clientsMu.RUnlock()

    if caller == nil {
        sendMessage(callee.Conn, Message{Type: "error", Data: "Caller not found"})
        resetClientState(callee)
        return
    }

    // Complete the room setup
    roomsMu.Lock()
    if room, exists := rooms[msg.CallID]; exists {
        room.Participants[callee.Conn] = true
        room.CalleeConn = callee.Conn
    } else {
        rooms[msg.CallID] = &Room{
            ID:           msg.CallID,
            Participants: map[*websocket.Conn]bool{caller.Conn: true, callee.Conn: true},
            CallerConn:   caller.Conn,
            CalleeConn:   callee.Conn,
        }
    }
    roomsMu.Unlock()

    clientsMu.Lock()
    caller.Status = StatusInCall
    callee.Status = StatusInCall
    clientsMu.Unlock()

    // Forward the answer to caller
    sendMessage(caller.Conn, Message{
        Type:   "answer",
        CallID: msg.CallID,
        Data:   msg.Data,
    })

    broadcastPeerList()
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
	clientsMu.Lock()
	defer clientsMu.Unlock()

	var caller *ClientInfo
	for _, c := range clientsByID {
		if c.CallID == msg.CallID && c.IsCaller {
			caller = c
			break
		}
	}

	if caller != nil {
		sendMessage(caller.Conn, Message{
			Type:   "call_rejected",
			CallID: msg.CallID,
			Reason: msg.Reason,
		})
		resetClientState(caller)
	}

	resetClientState(callee)
	broadcastPeerList()
}

func handleICECandidate(sender *ClientInfo, msg Message) {
	clientsMu.RLock()
	defer clientsMu.RUnlock()

	if sender.CallID != msg.CallID {
		log.Printf("ICE candidate from client %s with mismatched callID: %s (expected %s)", sender.ID, msg.CallID, sender.CallID)
		return
	}

	roomsMu.RLock()
	room, exists := rooms[msg.CallID]
	roomsMu.RUnlock()

	if !exists {
		log.Printf("ICE candidate for non-existing call: %s", msg.CallID)
		return
	}

	var recipient *websocket.Conn
	if room.CallerConn == sender.Conn {
		recipient = room.CalleeConn
	} else if room.CalleeConn == sender.Conn {
		recipient = room.CallerConn
	} else {
		log.Printf("ICE candidate sender %s not part of call room %s", sender.ID, msg.CallID)
		return
	}

	if recipient == nil {
		log.Printf("ICE candidate recipient connection is nil for call %s", msg.CallID)
		return
	}

	sendMessage(recipient, Message{
		Type:   "ice-candidate",
		CallID: msg.CallID,
		Data:   msg.Data,
	})
}


func handleHangup(conn *websocket.Conn, callID, reason string) {
	var otherConn *websocket.Conn

	roomsMu.Lock()
	room, exists := rooms[callID]
	if exists {
		if room.CallerConn == conn {
			otherConn = room.CalleeConn
		} else {
			otherConn = room.CallerConn
		}
		delete(rooms, callID)
	}
	roomsMu.Unlock()

	clientsMu.Lock()
	defer clientsMu.Unlock()

	if otherConn != nil {
		log.Printf("Sending peer_disconnected to %s because %s hung up", clients[otherConn].ID, reason)
		sendMessage(otherConn, Message{
			Type:   "peer_disconnected",
			CallID: callID,
			Reason: reason,
		})
		resetClientState(clients[otherConn])
	}

	if client, ok := clients[conn]; ok {
		resetClientState(client)
	}

	broadcastPeerList()
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