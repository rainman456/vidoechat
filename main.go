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



func handleAcceptCall(conn *websocket.Conn, msg Message) {
    callID := msg.CallID
    roomsMu.Lock()
    room, exists := rooms[callID]
    if !exists {
    room = &Room{clients: make(map[*websocket.Conn]bool)}
    rooms[callID] = room
    log.Printf("Created new room for call %s (via accept)", callID)
}

    room.clients[conn] = true
    offer := room.offer // copy inside lock
    roomsMu.Unlock()

    clientsMu.Lock()
    if client, ok := clients[conn]; ok {
        client.callID = callID
    }
    delete(idleClients, conn)
    clientsMu.Unlock()

    if offer != nil {
        clientsMu.Lock()
        err := conn.WriteJSON(*offer)
        clientsMu.Unlock()
        if err != nil {
            log.Printf("Failed to send offer to callee: %v", err)
            return
        }
    } else {
        log.Printf("No offer found for call %s", callID)
    }

    // Notify other idle clients to cancel modal
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
    log.Printf("User accepted call %s, offer sent, others notified", callID)
}



func handleOffer(sender *websocket.Conn, msg Message) {
    roomsMu.Lock()
    if _, exists := rooms[msg.CallID]; !exists {
        rooms[msg.CallID] = &Room{
            clients: make(map[*websocket.Conn]bool),
        }
        log.Printf("Created new room for call %s (via offer)", msg.CallID)
    }
    room := rooms[msg.CallID]
    room.offer = &msg
    room.clients[sender] = true
    roomsMu.Unlock()

    clientsMu.Lock()
    if client, ok := clients[sender]; ok {
        client.callID = msg.CallID
    }
    clientsMu.Unlock()

    for conn := range room.clients {
        if conn != sender {
            clientsMu.Lock()
            err := conn.WriteJSON(msg)
            clientsMu.Unlock()
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
    room, exists := rooms[msg.CallID]
    roomsMu.Unlock()
    if !exists {
        log.Printf("no room found for call %s", msg.CallID)
        return
    }

    roomsMu.Lock()
    room.clients[sender] = true
    roomsMu.Unlock()

    clientsMu.Lock()
    if client, ok := clients[sender]; ok {
        client.callID = msg.CallID
    }
    clientsMu.Unlock()

    for client := range room.clients {
        if client != sender {
            clientsMu.Lock()
			_ = clients[sender] // for safety, not strictly needed
			clientsMu.Unlock()

            err := client.WriteJSON(msg)
            if err != nil {
                log.Printf("error sending answer: %v", err)
                 roomsMu.Lock()
				delete(room.clients, client)
				roomsMu.Unlock()

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
    room, exists := rooms[msg.CallID]
    roomsMu.Unlock()
    if !exists {
        log.Printf("no room found for call %s", msg.CallID)
        return
    }

    for client := range room.clients {
        if client != sender {
            clientsMu.Lock()
			clientObj := client
			clientsMu.Unlock()
			err := clientObj.WriteJSON(msg)
            if err != nil {
                log.Printf("error sending ICE candidate: %v", err)
                 roomsMu.Lock()
				delete(room.clients, client)
				roomsMu.Unlock()

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
    room, exists := rooms[callID]
    if !exists {
        roomsMu.Unlock()
        return
    }

    delete(room.clients, sender)

    // Notify others
    for client := range room.clients {
        clientsMu.Lock()
        _ = client.WriteJSON(Message{
            Type:   "peer_disconnected",
            CallID: callID,
        })
        clientsMu.Unlock()
    }

    // Clean up disconnecting client
    clientsMu.Lock()
    if c, ok := clients[sender]; ok {
        c.callID = ""
        idleClients[sender] = true
    }
    clientsMu.Unlock()

    // Delete room if empty
    if len(room.clients) == 0 {
        delete(rooms, callID)
        log.Printf("Deleted empty room %s", callID)
    }
    roomsMu.Unlock()
}

func handleIncomingCall(sender *websocket.Conn, msg Message) {
	callID := msg.CallID

	roomsMu.Lock()
	if _, exists := rooms[callID]; !exists {
		rooms[callID] = &Room{
			clients: make(map[*websocket.Conn]bool),
		}
		log.Printf("Created room %s for incoming call", callID)
	}
	room := rooms[callID]
	room.clients[sender] = true
	roomsMu.Unlock()

	clientsMu.Lock()
	client, ok := clients[sender]
	if ok {
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
				log.Printf("error broadcasting incoming call: %v", err)
				delete(idleClients, conn)
				delete(clients, conn)
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

	log.Println("http server started on port 8000")
	err := http.ListenAndServe(":8000", nil)
	if err != nil {
		log.Fatalf("server failed to start: %v", err)
	}
}
