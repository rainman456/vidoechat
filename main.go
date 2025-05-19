package main

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocket upgrader configuration
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // For development only
	},
}

// Client represents a connected WebSocket client
type Client struct {
	conn   *websocket.Conn
	callID string
}

// Message represents a signaling message
type Message struct {
	Type   string `json:"type"`
	CallID string `json:"callId,omitempty"`
	Data   string `json:"data,omitempty"`
	From   string `json:"from,omitempty"`
}

// Room represents a call session
type Room struct {
	clients map[*websocket.Conn]bool
	offer   *Message
}

// Global state
var (
	clients     = make(map[*websocket.Conn]*Client)
	idleClients = make(map[*websocket.Conn]bool)
	rooms       = make(map[string]*Room)
	clientsMu   sync.Mutex
	roomsMu     sync.Mutex
)

// handleConnections manages WebSocket connections
func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Error upgrading connection: %v", err)
		return
	}

	// Set read deadline to detect stale connections
	ws.SetReadDeadline(time.Now().Add(60 * time.Second))

	clientsMu.Lock()
	client := &Client{conn: ws}
	clients[ws] = client
	idleClients[ws] = true
	log.Printf("New client connected: %v, total clients: %d, idle: %d", ws.RemoteAddr(), len(clients), len(idleClients))
	clientsMu.Unlock()

	defer cleanupClient(ws)

	for {
		var msg Message
		if err := ws.ReadJSON(&msg); err != nil {
			if websocket.IsCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure, websocket.CloseNoStatusReceived) {
				log.Printf("Client %v disconnected: %v", ws.RemoteAddr(), err)
			} else {
				log.Printf("WebSocket read error for %v: %v", ws.RemoteAddr(), err)
			}
			break
		}

		// Reset read deadline
		ws.SetReadDeadline(time.Now().Add(60 * time.Second))

		switch msg.Type {
		case "offer":
			handleOffer(ws, msg)
		case "incoming_call":
			handleIncomingCall(ws, msg)
		case "accept_call":
			handleAcceptCall(ws, msg)
		case "answer":
			handleAnswer(ws, msg)
		case "ice-candidate":
			handleICECandidate(ws, msg)
		case "join_call":
			handleJoinCall(ws, msg)
		case "hangup":
			handleHangup(ws, msg.CallID)
		default:
			log.Printf("Unknown message type from %v: %s", ws.RemoteAddr(), msg.Type)
		}
	}
}

// cleanupClient removes a client from all state
func cleanupClient(ws *websocket.Conn) {
	clientsMu.Lock()
	client, exists := clients[ws]
	if !exists {
		clientsMu.Unlock()
		log.Printf("Cleanup skipped for %v: not in clients", ws.RemoteAddr())
		return
	}
	callID := client.callID
	delete(clients, ws)
	delete(idleClients, ws)
	log.Printf("Removed client %v, remaining clients: %d, idle: %d", ws.RemoteAddr(), len(clients), len(idleClients))
	clientsMu.Unlock()

	if callID != "" {
		handleHangup(ws, callID)
	}
	removeFromAllRooms(ws)

	// Close connection safely
	if err := ws.Close(); err != nil && !websocket.IsCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
		log.Printf("Error closing WebSocket %v: %v", ws.RemoteAddr(), err)
	}
}

// removeFromAllRooms removes a client from all rooms
func removeFromAllRooms(conn *websocket.Conn) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	for callID, room := range rooms {
		delete(room.clients, conn)
		if len(room.clients) == 0 {
			delete(rooms, callID)
			log.Printf("Deleted empty room %s, remaining rooms: %d", callID, len(rooms))
		} else {
			for client := range room.clients {
				if err := client.WriteJSON(Message{
					Type:   "peer_disconnected",
					CallID: callID,
				}); err != nil {
					log.Printf("Error sending peer_disconnected to %v in room %s: %v", client.RemoteAddr(), callID, err)
					go cleanupClient(client)
				}
			}
		}
	}
	log.Printf("Removed %v from all rooms, remaining rooms: %d", conn.RemoteAddr(), len(rooms))
}

// handleOffer processes offer messages
func handleOffer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	if !exists {
		room = &Room{clients: make(map[*websocket.Conn]bool)}
		rooms[msg.CallID] = room
		log.Printf("Created new room for call %s", msg.CallID)
	}
	if room.offer == nil {
		room.offer = &msg
	}
	room.clients[sender] = true
	roomsMu.Unlock()

	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = msg.CallID
		delete(idleClients, sender)
	}
	log.Printf("Client %v set callID %s, idle clients: %d", sender.RemoteAddr(), msg.CallID, len(idleClients))
	clientsMu.Unlock()
}

// handleAcceptCall processes call acceptance
func handleAcceptCall(conn *websocket.Conn, msg Message) {
	callID := msg.CallID
	roomsMu.Lock()
	room, exists := rooms[callID]
	var offer *Message
	if exists {
		offer = room.offer
		room.clients[conn] = true
	}
	roomsMu.Unlock()

	if !exists {
		if err := conn.WriteJSON(Message{Type: "error", Data: "Call offer not found"}); err != nil {
			log.Printf("Error sending error to %v: %v", conn.RemoteAddr(), err)
			go cleanupClient(conn)
		}
		return
	}

	clientsMu.Lock()
	if client, ok := clients[conn]; ok {
		client.callID = callID
		delete(idleClients, conn)
	}
	idleClientsCopy := make(map[*websocket.Conn]bool)
	for k, v := range idleClients {
		idleClientsCopy[k] = v
	}
	clientsMu.Unlock()

	if offer != nil {
		if err := conn.WriteJSON(*offer); err != nil {
			log.Printf("Failed to send offer to %v: %v", conn.RemoteAddr(), err)
			go cleanupClient(conn)
			return
		}
		if err := conn.WriteJSON(Message{Type: "call_joined", CallID: callID}); err != nil {
			log.Printf("Failed to send call_joined to %v: %v", conn.RemoteAddr(), err)
			go cleanupClient(conn)
			return
		}
	}

	for other := range idleClientsCopy {
		if other != conn {
			if err := other.WriteJSON(Message{
				Type:   "call_taken",
				CallID: callID,
			}); err != nil {
				log.Printf("Error sending call_taken to %v: %v", other.RemoteAddr(), err)
				go cleanupClient(other)
			}
		}
	}
	log.Printf("User %v accepted call %s", conn.RemoteAddr(), callID)
}

// handleAnswer processes answer messages
func handleAnswer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	var roomClients map[*websocket.Conn]bool
	if exists {
		room.clients[sender] = true
		roomClients = make(map[*websocket.Conn]bool)
		for k, v := range room.clients {
			roomClients[k] = v
		}
	}
	roomsMu.Unlock()

	if !exists {
		log.Printf("Answer for non-existent call %s from %v", msg.CallID, sender.RemoteAddr())
		return
	}

	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = msg.CallID
	}
	clientsMu.Unlock()

	for client := range roomClients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending answer to %v: %v", client.RemoteAddr(), err)
				go cleanupClient(client)
			}
		}
	}
}

// handleICECandidate processes ICE candidate messages
func handleICECandidate(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	var roomClients map[*websocket.Conn]bool
	if exists {
		roomClients = make(map[*websocket.Conn]bool)
		for k, v := range room.clients {
			roomClients[k] = v
		}
	}
	roomsMu.Unlock()

	if !exists {
		log.Printf("No room for ICE candidate call %s from %v", msg.CallID, sender.RemoteAddr())
		return
	}

	for client := range roomClients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending ICE candidate to %v: %v", client.RemoteAddr(), err)
				go cleanupClient(client)
			}
		}
	}
}

// handleJoinCall processes join call requests
func handleJoinCall(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	var offer *Message
	if exists {
		offer = room.offer
		room.clients[sender] = true
	}
	roomsMu.Unlock()

	if !exists {
		if err := sender.WriteJSON(Message{
			Type: "error",
			Data: "Call not found",
		}); err != nil {
			log.Printf("Error sending error to %v: %v", sender.RemoteAddr(), err)
			go cleanupClient(sender)
		}
		return
	}

	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = msg.CallID
	}
	clientsMu.Unlock()

	if offer != nil {
		if err := sender.WriteJSON(*offer); err != nil {
			log.Printf("Error sending offer to %v: %v", sender.RemoteAddr(), err)
			go cleanupClient(sender)
			return
		}
	}
	if err := sender.WriteJSON(Message{Type: "call_joined", CallID: msg.CallID}); err != nil {
		log.Printf("Error sending call_joined to %v: %v", sender.RemoteAddr(), err)
		go cleanupClient(sender)
	}
}

// handleHangup processes hangup requests
func handleHangup(sender *websocket.Conn, callID string) {
	roomsMu.Lock()
	room, exists := rooms[callID]
	var roomClients map[*websocket.Conn]bool
	if exists {
		delete(room.clients, sender)
		roomClients = make(map[*websocket.Conn]bool)
		for k, v := range room.clients {
			roomClients[k] = v
		}
		if len(room.clients) == 0 {
			delete(rooms, callID)
			log.Printf("Deleted empty room %s, remaining rooms: %d", callID, len(rooms))
		}
	}
	roomsMu.Unlock()

	if !exists {
		log.Printf("Hangup for non-existent call %s from %v", callID, sender.RemoteAddr())
		return
	}

	for client := range roomClients {
		if err := client.WriteJSON(Message{
			Type:   "peer_disconnected",
			CallID: callID,
		}); err != nil {
			log.Printf("Error sending peer_disconnected to %v: %v", client.RemoteAddr(), err)
			go cleanupClient(client)
		}
	}

	clientsMu.Lock()
	if c, ok := clients[sender]; ok {
		c.callID = ""
		idleClients[sender] = true
		log.Printf("Client %v set to idle, idle clients: %d", sender.RemoteAddr(), len(idleClients))
	}
	clientsMu.Unlock()
}

// handleIncomingCall processes incoming call notifications
func handleIncomingCall(sender *websocket.Conn, msg Message) {
	callID := msg.CallID

	roomsMu.Lock()
	if _, exists := rooms[callID]; !exists {
		rooms[callID] = &Room{clients: make(map[*websocket.Conn]bool)}
		log.Printf("Created room %s for incoming call", callID)
	}
	rooms[callID].clients[sender] = true
	roomsMu.Unlock()

	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = callID
		delete(idleClients, sender)
	}
	idleClientsCopy := make(map[*websocket.Conn]bool)
	for k, v := range idleClients {
		idleClientsCopy[k] = v
	}
	clientsMu.Unlock()

	for conn := range idleClientsCopy {
		if conn != sender {
			if err := conn.WriteJSON(Message{
				Type:   "incoming_call",
				CallID: callID,
				From:   msg.From,
			}); err != nil {
				log.Printf("Error sending incoming call to %v: %v", conn.RemoteAddr(), err)
				go cleanupClient(conn)
			}
		}
	}
	log.Printf("Incoming call %s from %v, notified %d idle clients", callID, sender.RemoteAddr(), len(idleClientsCopy))
}

// cleanupStaleResources periodically removes stale clients and rooms
func cleanupStaleResources() {
	for {
		time.Sleep(30 * time.Second)
		roomsMu.Lock()
		for callID, room := range rooms {
			for client := range room.clients {
				if _, exists := clients[client]; !exists {
					delete(room.clients, client)
					log.Printf("Removed stale client %v from room %s", client.RemoteAddr(), callID)
				}
			}
			if len(room.clients) == 0 {
				delete(rooms, callID)
				log.Printf("Deleted stale empty room %s", callID)
			}
		}
		roomsMu.Unlock()

		clientsMu.Lock()
		for ws := range clients {
			if err := ws.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(5*time.Second)); err != nil {
				delete(clients, ws)
				delete(idleClients, ws)
				log.Printf("Removed stale client %v", ws.RemoteAddr())
				go cleanupClient(ws)
			}
		}
		log.Printf("Cleanup complete, clients: %d, idle: %d, rooms: %d", len(clients), len(idleClients), len(rooms))
		clientsMu.Unlock()
	}
}

func main() {
	fs := http.FileServer(http.Dir("./client"))
	http.Handle("/", fs)
	http.HandleFunc("/ws", handleConnections)

	go cleanupStaleResources()

	log.Println("WebSocket signaling server running on :8000")
	if err := http.ListenAndServe(":8000", nil); err != nil {
		log.Fatalf("ListenAndServe failed: %v", err)
	}
}