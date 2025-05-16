package main

import (
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // For development only – restrict in production
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
		log.Printf("error upgrading connection: %v", err)
		return
	}

	// Add new client
	clientsMu.Lock()
	clients[ws] = &Client{conn: ws}
	idleClients[ws] = true
	clientsMu.Unlock()

	defer func() {
		// Clean up on disconnect
		clientsMu.Lock()
		client := clients[ws]
		if client != nil && client.callID != "" {
			handleHangup(ws, client.callID)
		}
		delete(clients, ws)
		delete(idleClients, ws)
		clientsMu.Unlock()
		ws.Close()
	}()

	for {
		var msg Message
		err := ws.ReadJSON(&msg)
		if err != nil {
			log.Printf("error reading message: %v", err)
			break
		}

		switch msg.Type {
		case "offer":
			handleOffer(ws, msg)
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

func handleOffer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	// ✅ Create room if it doesn't exist yet
	if _, exists := rooms[msg.CallID]; !exists {
		rooms[msg.CallID] = &Room{
			clients: make(map[*websocket.Conn]bool),
		}
		log.Printf("Created new room for call %s (via offer)", msg.CallID)
	}

	room := rooms[msg.CallID]
	room.offer = &msg
	room.clients[sender] = true

	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	clientsMu.Unlock()

	log.Printf("Stored offer for call %s", msg.CallID)

	// ✅ Send offer to all other clients (usually just the callee)
	for conn := range room.clients {
		if conn != sender {
			err := conn.WriteJSON(msg)
			if err != nil {
				log.Printf("error forwarding offer: %v", err)
			} else {
				log.Printf("Forwarded offer to callee in call %s", msg.CallID)
			}
		}
	}
}


func handleAnswer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[msg.CallID]
	if !exists {
		log.Printf("no room found for call %s", msg.CallID)
		return
	}

	// Add sender to room and set their callID
	room.clients[sender] = true
	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	clientsMu.Unlock()

	// Send answer to all other clients in the room
	for client := range room.clients {
		if client != sender {
			err := client.WriteJSON(msg)
			if err != nil {
				log.Printf("error sending answer: %v", err)
				clientsMu.Lock()
				delete(clients, client)
				delete(idleClients, client)
				clientsMu.Unlock()
				client.Close()
			}
		}
	}
}

func handleICECandidate(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[msg.CallID]
	if !exists {
		log.Printf("no room found for call %s", msg.CallID)
		return
	}

	// Send ICE candidate to all other clients in the room
	for client := range room.clients {
		if client != sender {
			err := client.WriteJSON(msg)
			if err != nil {
				log.Printf("error sending ICE candidate: %v", err)
				clientsMu.Lock()
				delete(clients, client)
				delete(idleClients, client)
				clientsMu.Unlock()
				client.Close()
			}
		}
	}
}

func handleJoinCall(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	// ✅ Create room if it doesn't exist
	if _, exists := rooms[msg.CallID]; !exists {
		rooms[msg.CallID] = &Room{
			clients: make(map[*websocket.Conn]bool),
		}
		log.Printf("Created new room for call %s (via join_call)", msg.CallID)
	}

	room := rooms[msg.CallID]
	room.clients[sender] = true

	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	clientsMu.Unlock()

	log.Printf("Client joined call %s", msg.CallID)

	// ✅ Send stored offer if it exists
	if room.offer != nil {
		err := sender.WriteJSON(*room.offer)
		if err != nil {
			log.Printf("error sending stored offer to callee: %v", err)
		} else {
			log.Printf("Sent stored offer to callee in call %s", msg.CallID)
		}
	} else {
		// Optional: send "waiting for offer" message
		sender.WriteJSON(Message{
			Type:   "call_joined",
			CallID: msg.CallID,
		})
	}
}



func handleHangup(sender *websocket.Conn, callID string) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[callID]
	if !exists {
		return
	}

	// Notify other clients in the room
	for client := range room.clients {
		if client != sender {
			err := client.WriteJSON(Message{
				Type:   "peer_disconnected",
				CallID: callID,
			})
			if err != nil {
				log.Printf("error sending hangup notification: %v", err)
			}
		}
	}

	// Clean up client state
	clientsMu.Lock()
	for client := range room.clients {
		if c, ok := clients[client]; ok {
			c.callID = ""               // Reset call ID
			idleClients[client] = true // Make them available for another call
		}
	}
	clientsMu.Unlock()

	// Delete the room
	delete(rooms, callID)
}

func main() {
	fs := http.FileServer(http.Dir("./client"))
	http.Handle("/", fs)
	http.HandleFunc("/ws", handleConnections)

	log.Println("http server started on port 8000")
	err := http.ListenAndServe(":8000", nil)
	if err != nil {
		log.Fatalf("server failed to start: %v", err)
	}
}
