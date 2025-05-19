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
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("Recovered from panic: %v", rec)
		}
	}()

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("error upgrading connection: %v", err)
		return
	}

	clientsMu.Lock()
	clients[ws] = &Client{conn: ws}
	idleClients[ws] = true
	clientsMu.Unlock()

	defer func() {
		clientsMu.Lock()
		client := clients[ws]
		if client != nil && client.callID != "" {
			handleHangup(ws, client.callID)
		}
		delete(clients, ws)
		delete(idleClients, ws)
		clientsMu.Unlock()

		removeFromAllRooms(ws)
		ws.Close()
	}()

	for {
		var msg Message
		err := ws.ReadJSON(&msg)
		if err != nil {
			if websocket.IsCloseError(err,
			websocket.CloseGoingAway,
			websocket.CloseNormalClosure,
			websocket.CloseNoStatusReceived) {
			log.Printf("client disconnected: %v", err)
		} else {
			log.Printf("unexpected WebSocket error: %v", err)
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
			log.Printf("unknown message type: %s", msg.Type)
		}
	}
}

func removeFromAllRooms(conn *websocket.Conn) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	for _, room := range rooms {
		delete(room.clients, conn)
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
	}
	clientsMu.Unlock()
}

func handleAcceptCall(conn *websocket.Conn, msg Message) {
	callID := msg.CallID
	roomsMu.Lock()
	room, exists := rooms[callID]
	if !exists {
		roomsMu.Unlock()
		_ = conn.WriteJSON(Message{Type: "error", Data: "Call offer not found or expired"})
		return
	}
	room.clients[conn] = true
	offer := room.offer
	roomsMu.Unlock()

	clientsMu.Lock()
	if client, ok := clients[conn]; ok {
		client.callID = callID
	}
	delete(idleClients, conn)
	clientsMu.Unlock()

	if offer != nil {
		err := conn.WriteJSON(*offer)
		if err != nil {
			log.Printf("Failed to send offer to callee: %v", err)
		}
		conn.WriteJSON(Message{Type: "call_joined", CallID: callID})
	}

	// Notify other idle clients
	clientsMu.Lock()
	for other := range idleClients {
		if other != conn {
			_ = other.WriteJSON(Message{
				Type:   "call_taken",
				CallID: callID,
			})
		}
	}
	clientsMu.Unlock()

	log.Printf("User accepted call %s", callID)
}

func handleAnswer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	if !exists {
		roomsMu.Unlock()
		log.Printf("Answer for non-existent call %s", msg.CallID)
		return
	}
	room.clients[sender] = true
	roomsMu.Unlock()

	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = msg.CallID
	}
	clientsMu.Unlock()

	for client := range room.clients {
		if client != sender {
			err := client.WriteJSON(msg)
			if err != nil {
				log.Printf("error sending answer: %v", err)
				client.Close()
			}
		}
	}
}

func handleICECandidate(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	roomsMu.Unlock()
	if !exists {
		log.Printf("No room found for ICE candidate call %s", msg.CallID)
		return
	}

	for client := range room.clients {
		if client != sender {
			err := client.WriteJSON(msg)
			if err != nil {
				log.Printf("error sending ICE candidate: %v", err)
				client.Close()
			}
		}
	}
}

func handleJoinCall(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	if !exists {
		roomsMu.Unlock()
		_ = sender.WriteJSON(Message{
			Type: "error", Data: "Call not found or not yet started",
		})
		return
	}
	room.clients[sender] = true
	offer := room.offer
	roomsMu.Unlock()

	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = msg.CallID
	}
	clientsMu.Unlock()

	if offer != nil {
		_ = sender.WriteJSON(*offer)
	}
	_ = sender.WriteJSON(Message{Type: "call_joined", CallID: msg.CallID})
}

func handleHangup(sender *websocket.Conn, callID string) {
	roomsMu.Lock()
	room, exists := rooms[callID]
	if !exists {
		roomsMu.Unlock()
		return
	}

	delete(room.clients, sender)
	for client := range room.clients {
		_ = client.WriteJSON(Message{
			Type:   "peer_disconnected",
			CallID: callID,
		})
	}
	if len(room.clients) == 0 {
		delete(rooms, callID)
		log.Printf("Deleted empty room %s", callID)
	}
	roomsMu.Unlock()

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
	}
	for conn := range idleClients {
		if conn != sender {
			err := conn.WriteJSON(Message{
				Type:   "incoming_call",
				CallID: callID,
				From:   msg.From,
			})
			if err != nil {
				log.Printf("error sending incoming call: %v", err)
				delete(clients, conn)
				delete(idleClients, conn)
				conn.Close()
			}
		}
	}
	clientsMu.Unlock()
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
