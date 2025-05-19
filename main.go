package main

import (
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // For development only
	},
}

type Client struct {
	conn   *websocket.Conn
	callID string
}

type Message struct {
	Type   string `json:"type"`
	CallID string `json:"callId,omitempty"`
	Data   string `json:"data,omitempty"`
	From   string `json:"from,omitempty"`
}

type Room struct {
	clients map[*websocket.Conn]bool
	offer   *Message
}

var (
	clients     = make(map[*websocket.Conn]*Client)
	idleClients = make(map[*websocket.Conn]bool)
	rooms       = make(map[string]*Room)
	clientsMu   sync.Mutex
	roomsMu     sync.Mutex
)

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Error upgrading connection: %v", err)
		return
	}

	clientsMu.Lock()
	client := &Client{conn: ws}
	clients[ws] = client
	idleClients[ws] = true
	clientsMu.Unlock()

	defer func() {
		cleanupClient(ws)
	}()

	for {
		var msg Message
		err := ws.ReadJSON(&msg)
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure, websocket.CloseNoStatusReceived) {
				log.Printf("Client disconnected: %v", err)
			} else {
				log.Printf("Unexpected WebSocket error: %v", err)
			}
			break
		}

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
			log.Printf("Unknown message type: %s", msg.Type)
		}
	}
}

func cleanupClient(ws *websocket.Conn) {
	clientsMu.Lock()
	client, exists := clients[ws]
	if !exists {
		clientsMu.Unlock()
		return
	}
	if client.callID != "" {
		handleHangup(ws, client.callID)
	}
	delete(clients, ws)
	delete(idleClients, ws)
	clientsMu.Unlock()

	removeFromAllRooms(ws)

	// Close connection only if not already closed
	if err := ws.Close(); err != nil && !websocket.IsCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
		log.Printf("Error closing WebSocket: %v", err)
	}
}

func removeFromAllRooms(conn *websocket.Conn) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	for callID, room := range rooms {
		delete(room.clients, conn)
		if len(room.clients) == 0 {
			delete(rooms, callID)
			log.Printf("Deleted empty room %s", callID)
		} else {
			// Notify remaining clients of disconnection
			for client := range room.clients {
				if err := client.WriteJSON(Message{
					Type:   "peer_disconnected",
					CallID: callID,
				}); err != nil {
					log.Printf("Error sending peer_disconnected to %v: %v", client.RemoteAddr(), err)
				}
			}
		}
	}
}

func handleOffer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	if !exists {
		room = &Room{clients: make(map[*websocket.Conn]bool)}
		rooms[msg.CallID] = room
		log.Printf("Created new room for call %s (via offer)", msg.CallID)
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
	clientsMu.Unlock()
}

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
		if err := conn.WriteJSON(Message{Type: "error", Data: "Call offer not found or expired"}); err != nil {
			log.Printf("Error sending error message: %v", err)
		}
		return
	}

	clientsMu.Lock()
	if client, ok := clients[conn]; ok {
		client.callID = callID
		delete(idleClients, conn)
	}
	clientsMu.Unlock()

	if offer != nil {
		if err := conn.WriteJSON(*offer); err != nil {
			log.Printf("Failed to send offer to callee: %v", err)
			return
		}
		if err := conn.WriteJSON(Message{Type: "call_joined", CallID: callID}); err != nil {
			log.Printf("Failed to send call_joined: %v", err)
			return
		}
	}

	// Notify other idle clients
	clientsMu.Lock()
	for other := range idleClients {
		if other != conn {
			if err := other.WriteJSON(Message{
				Type:   "call_taken",
				CallID: callID,
			}); err != nil {
				log.Printf("Error sending call_taken: %v", err)
				delete(clients, other)
				delete(idleClients, other)
				go cleanupClient(other)
			}
		}
	}
	clientsMu.Unlock()

	log.Printf("User accepted call %s", callID)
}

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
		log.Printf("Answer for non-existent call %s", msg.CallID)
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
				log.Printf("Error sending answer: %v", err)
				go cleanupClient(client)
			}
		}
	}
}

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
		log.Printf("No room found for ICE candidate call %s", msg.CallID)
		return
	}

	for client := range roomClients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending ICE candidate: %v", err)
				go cleanupClient(client)
			}
		}
	}
}

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
			Data: "Call not found or not yet started",
		}); err != nil {
			log.Printf("Error sending error message: %v", err)
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
			log.Printf("Error sending offer: %v", err)
			return
		}
	}
	if err := sender.WriteJSON(Message{Type: "call_joined", CallID: msg.CallID}); err != nil {
		log.Printf("Error sending call_joined: %v", err)
	}
}

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
			log.Printf("Deleted empty room %s", callID)
		}
	}
	roomsMu.Unlock()

	if !exists {
		return
	}

	for client := range roomClients {
		if err := client.WriteJSON(Message{
			Type:   "peer_disconnected",
			CallID: callID,
		}); err != nil {
			log.Printf("Error sending peer_disconnected: %v", err)
			go cleanupClient(client)
		}
	}

	clientsMu.Lock()
	if c, ok := clients[sender]; ok {
		c.callID = ""
		idleClients[sender] = true
	}
	clientsMu.Unlock()
}

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
				log.Printf("Error sending incoming call: %v", err)
				go cleanupClient(conn)
			}
		}
	}
}

func main() {
	fs := http.FileServer(http.Dir("./client"))
	http.Handle("/", fs)
	http.HandleFunc("/ws", handleConnections)

	log.Println("WebSocket signaling server running on :8000")
	err := http.ListenAndServe(":8000", nil)
	if err != nil {
		log.Fatalf("ListenAndServe failed: %v", err)
	}
}