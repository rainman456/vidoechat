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

	// Avoid blocking indefinitely on slow/stuck connections
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(msg); err != nil {
		log.Printf("Error sending message: %v", err)
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
		go func(c *websocket.Conn) {
			if err := c.WriteJSON(msg); err != nil {
				log.Printf("Failed to write peer_list to conn: %v", err)
			}
		}(conn)
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

	var callee *ClientInfo
	log.Printf("Client %s is initiating a call", caller.ID)

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

	callID := uuid.New().String()
	caller.Status = StatusCalling
	caller.CallID = callID
	caller.IsCaller = true

	callee.Status = StatusRinging
	callee.CallID = callID
	callee.IsCaller = false

	sendMessage(callee.Conn, Message{
		Type:     "incoming_call",
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
	var caller *ClientInfo
	for _, c := range clientsByID {
		if c.CallID == msg.CallID && c.IsCaller && c.Status == StatusCalling {
			caller = c
			break
		}
	}
	clientsMu.RUnlock()

	if caller == nil {
		sendMessage(callee.Conn, Message{Type: "error", Data: "Caller not found or unavailable"})
		resetClientState(callee)
		broadcastPeerList()
		return
	}

	room := &Room{
		ID:           msg.CallID,
		Participants: map[*websocket.Conn]bool{caller.Conn: true, callee.Conn: true},
		CallerConn:   caller.Conn,
		CalleeConn:   callee.Conn,
	}

	roomsMu.Lock()
	rooms[msg.CallID] = room
	roomsMu.Unlock()

	clientsMu.Lock()
	caller.Status = StatusInCall
	callee.Status = StatusInCall
	clientsMu.Unlock()

	sendMessage(caller.Conn, Message{
		Type:   "answer",
		CallID: msg.CallID,
		Data:   msg.Data,
	})

	broadcastPeerList()
}


func handleOffer(sender *ClientInfo, msg Message) {
	if sender == nil {
		log.Printf("handleOffer: sender is nil")
		return
	}
	roomsMu.RLock()
	room, exists := rooms[msg.CallID]
	roomsMu.RUnlock()
	if !exists {
		log.Printf("handleOffer: room %s not found", msg.CallID)
		return
	}

	var recipient *websocket.Conn
	if room.CallerConn == sender.Conn {
		recipient = room.CalleeConn
	} else {
		recipient = room.CallerConn
	}

	if recipient == nil {
		log.Printf("handleOffer: recipient connection is nil")
		return
	}

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
	roomsMu.RLock()
	room, exists := rooms[msg.CallID]
	roomsMu.RUnlock()

	if !exists {
		return
	}

	var recipient *websocket.Conn
	if room.CallerConn == sender.Conn {
		recipient = room.CalleeConn
	} else {
		recipient = room.CallerConn
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

	if otherConn != nil {
		sendMessage(otherConn, Message{
			Type:   "peer_disconnected",
			CallID: callID,
			Reason: reason,
		})
		resetClientState(clients[otherConn])
	}

	resetClientState(clients[conn])
	broadcastPeerList()
}


func resetClientState(client *ClientInfo) {
	clientsMu.Lock()
	defer clientsMu.Unlock()

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