package main

import (
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
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
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
	clientsMu.RLock()
	defer clientsMu.RUnlock()
	if _, ok := clients[conn]; !ok {
		return
	}
	if err := conn.WriteJSON(msg); err != nil {
		log.Printf("Error sending message: %v", err)
	}
}

func broadcastPeerList() {
	clientsMu.RLock()
	defer clientsMu.RUnlock()

	peers := make([]Peer, 0)
	for _, c := range clientsByID {
		peers = append(peers, Peer{
			ID:     c.ID,
			Status: c.Status,
		})
	}

	for conn := range clients {
		sendMessage(conn, Message{
			Type:  "peer_list",
			Peers: peers,
		})
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
	defer func() {
		clientsMu.Lock()
		if c, ok := clients[client.Conn]; ok {
			if c.Status == StatusInCall || c.Status == StatusCalling || c.Status == StatusRinging {
				handleHangup(client.Conn, c.CallID, "disconnected")
			}
			delete(clientsByID, c.ID)
			delete(clients, client.Conn)
		}
		clientsMu.Unlock()
		client.Conn.Close()
		broadcastPeerList()
	}()

	for {
		var msg Message
		if err := client.Conn.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Client %s disconnected unexpectedly: %v", client.ID, err)
			}
			return
		}

		client.LastSeen = time.Now()
		log.Printf("Received from %s: %+v", client.ID, msg)

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
			handleHangup(client.Conn, msg.CallID, "hangup")
		case "ping":
			sendMessage(client.Conn, Message{Type: "pong"})
		case "register":
			handleRegister(client, msg)
		default:
			sendMessage(client.Conn, Message{Type: "error", Data: "Unknown message type"})
		}
	}
}

func handleRegister(client *ClientInfo, msg Message) {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	
	if client, ok := clientsByID[client.ID]; ok {
		client.Status = msg.Data // "idle" or other status
	}
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

func handleAcceptCall(callee *ClientInfo, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	clientsMu.Lock()
	defer clientsMu.Unlock()

	var caller *ClientInfo
	for _, c := range clientsByID {
		if c.CallID == msg.CallID && c.IsCaller {
			caller = c
			break
		}
	}

	if caller == nil {
		sendMessage(callee.Conn, Message{Type: "error", Data: "Caller not found"})
		return
	}

	room := &Room{
		ID:           msg.CallID,
		Participants: map[*websocket.Conn]bool{caller.Conn: true, callee.Conn: true},
		CallerConn:   caller.Conn,
		CalleeConn:   callee.Conn,
	}
	rooms[msg.CallID] = room

	caller.Status = StatusInCall
	callee.Status = StatusInCall

	sendMessage(caller.Conn, Message{
		Type:   "answer",
		CallID: msg.CallID,
		Data:   msg.Data,
	})

	broadcastPeerList()
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
	roomsMu.Lock()
	defer roomsMu.Unlock()
	clientsMu.Lock()
	defer clientsMu.Unlock()

	room, exists := rooms[callID]
	if exists {
		var otherConn *websocket.Conn
		if room.CallerConn == conn {
			otherConn = room.CalleeConn
		} else {
			otherConn = room.CallerConn
		}

		if otherConn != nil {
			sendMessage(otherConn, Message{
				Type:   "peer_disconnected",
				CallID: callID,
				Reason: reason,
			})
			if client, ok := clients[otherConn]; ok {
				resetClientState(client)
			}
		}

		delete(rooms, callID)
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
	http.Handle("/", http.FileServer(http.Dir("./client")))
	http.HandleFunc("/ws", handleConnections)

	log.Println("Server started on :8000")
	log.Fatal(http.ListenAndServe(":8000", nil))
}