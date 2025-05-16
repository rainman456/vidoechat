const servers = {
    iceServers: [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
    ],
    iceCandidatePoolSize: 10
};

// DOM Elements
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const answerButton = document.getElementById('answerButton');
const hangupButton = document.getElementById('hangupButton');
const callInput = document.getElementById('callInput');
const incomingModal = document.getElementById('incomingModal');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');
const ringtone = document.getElementById('ringtone');
const remoteVideo = document.getElementById('remoteVideo');


// State variables
let pc = null;
let localStream = null;
let remoteStream = null;
let socket = null;
let currentCallId = null;
let isCaller = false;
let pendingCandidates = [];
let keepaliveInterval = null;
let peerList = [];
const peerListElement = document.createElement('div'); // Create a container for peer list


// Initialize UI
function initializeUI() {
    // Create and style the peer list container
    peerListElement.id = 'peerList';
    peerListElement.style.margin = '10px 0';
    peerListElement.style.padding = '10px';
    peerListElement.style.border = '1px solid #ccc';
    peerListElement.style.borderRadius = '5px';
    document.body.insertBefore(peerListElement, document.querySelector('h2:nth-of-type(2)')); // Insert before "2. Create a new Call"
    
    updateUIState('init');
}
function updatePeerListUI() {
    peerListElement.innerHTML = '<h3>Available Peers</h3>';
    
    if (peerList.length === 0) {
        peerListElement.innerHTML += '<p>No other peers available</p>';
        return;
    }
    
    const list = document.createElement('ul');
    peerList.forEach(peer => {
        const item = document.createElement('li');
        item.textContent = `${peer.id} (${peer.status})`;
        list.appendChild(item);
    });
    peerListElement.appendChild(list);
}

// Add this function to handle peer status updates
function updatePeerStatus(peerId, status) {
    const peer = peerList.find(p => p.id === peerId);
    if (peer) {
        peer.status = status;
    } else {
        peerList.push({ id: peerId, status });
    }
    updatePeerListUI();
}

// Add this function to handle incoming call answers
function handleAnswer(msg) {
    if (!isCaller || !pc) return;
    
    pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)))
        .then(() => {
            console.log("Remote description set with answer");
            // Process any pending ICE candidates
            while (pendingCandidates.length > 0) {
                const candidate = pendingCandidates.shift();
                pc.addIceCandidate(candidate)
                    .catch(e => console.error("Error adding ICE candidate:", e));
            }
            updateUIState('in_call');
        })
        .catch(e => {
            console.error("Error setting remote description:", e);
            resetCallState();
        });
}

// Add this function to handle ICE candidates
function handleICECandidate(msg) {
    if (!pc || !currentCallId || msg.callId !== currentCallId) return;
    
    const candidate = new RTCIceCandidate(JSON.parse(msg.data));
    if (pc.remoteDescription) {
        pc.addIceCandidate(candidate)
            .catch(e => console.error("Error adding ICE candidate:", e));
    } else {
        pendingCandidates.push(candidate);
    }
}

// Modify your initialization to use initializeUI() instead of updateUIState('init')
// Replace:
// updateUIState('init');
// With:
initializeUI();

// WebSocket connection with presence management
function connectSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        sendPresenceUpdate();
        return;
    }

    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

    socket.onopen = () => {
        console.log("WebSocket connected");
        socket.send(JSON.stringify({
        type: "register",
        // id: optional unique peer ID if needed
    }));
        startKeepalive();
        sendPresenceUpdate();
        
        // If we were trying to call when socket reconnected
        if (isCaller && currentCallId) {
            socket.send(JSON.stringify({
        type: "initiate_call",
        callId: currentCallId,
        data: JSON.stringify(pc.localDescription)
    }));
        }
    };

    socket.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        console.log("Received message:", msg);

        switch(msg.type) {
            case "peer_list":
                peerList = msg.peers;
                updatePeerListUI();
                break;
                
            case "presence_update":
                updatePeerStatus(msg.peerId, msg.status);
                break;
                
            case "incoming_call":
                handleIncomingCall(msg);
                break;
                
            case "answer":
                handleAnswer(msg);
                break;
                
            case "ice-candidate":
                handleICECandidate(msg);
                break;
                
            case "call_rejected":
                alert(`Call rejected: ${msg.reason}`);
                resetCallState();
                break;
                
            case "peer_disconnected":
                alert("Peer disconnected");
                resetCallState();
                break;
        }
    };

    socket.onclose = () => {
        console.log("WebSocket disconnected");
        stopKeepalive();
        setTimeout(connectSocket, 3000); // Reconnect after 3 seconds
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
    };
}

// Presence management
function sendPresenceUpdate() {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: "presence_update",
            status: currentCallId ? "in_call" : "idle"
        }));
    }
}

function startKeepalive() {
    stopKeepalive();
    keepaliveInterval = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping" }));
        }
    }, 25000);
}

function stopKeepalive() {
    if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
    }
}

// Peer Connection Management
async function createPeerConnection() {
    if (pc) pc.close();
    
    pc = new RTCPeerConnection(servers);
    
    pc.onicecandidate = (event) => {
        if (event.candidate && socket?.readyState === WebSocket.OPEN && currentCallId) {
            socket.send(JSON.stringify({
                type: "ice-candidate",
                callId: currentCallId,
                data: JSON.stringify(event.candidate)
            }));
        }
    };
    
    pc.ontrack = (event) => {
        if (!remoteStream) {
            remoteStream = new MediaStream();
            remoteVideo.srcObject = remoteStream;
        }
        event.streams[0].getTracks().forEach(track => {
            remoteStream.addTrack(track);
        });
    };
    
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    
    return pc;
}

// Call Management
async function startCall() {
    if (!localStream) {
        alert("Please start your webcam first");
        return;
    }
    
    isCaller = true;
    currentCallId = "call_" + Math.random().toString(36).substr(2, 9);
    updateUIState('calling');
    
    pc = await createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.send(JSON.stringify({
        type: "initiate_call",
        callId: currentCallId,
        data: JSON.stringify(offer)
    }));
}

async function answerCall() {
    if (!currentCallId || !pc) return;
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.send(JSON.stringify({
        type: "accept_call",
        callId: currentCallId,
        data: JSON.stringify(answer)
    }));
    
    updateUIState('in_call');
}

function hangup() {
    if (currentCallId && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: "hangup",
            callId: currentCallId
        }));
    }
    resetCallState();
}

// Incoming Call Handling
function handleIncomingCall(msg) {
    if (isCaller || currentCallId) {
        socket.send(JSON.stringify({
            type: "reject_call",
            callId: msg.callId,
            reason: "busy"
        }));
        return;
    }
    
    currentCallId = msg.callId;
    showIncomingCallModal(msg.callerId);
    
    pc = await createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
}

function showIncomingCallModal(callerId) {
    incomingModal.style.display = 'flex';
    ringtone.play().catch(e => console.log("Ringtone play failed:", e));
    updateUIState('ringing');
}

function hideIncomingCallModal() {
    incomingModal.style.display = 'none';
    ringtone.pause();
    ringtone.currentTime = 0;
}

// UI Management
function updateUIState(state) {
    webcamButton.disabled = state !== 'init';
    callButton.disabled = state !== 'webcam_ready';
    answerButton.disabled = state !== 'ringing';
    hangupButton.disabled = state !== 'in_call' && state !== 'calling';
    
    switch(state) {
        case 'init':
            document.getElementById('statusText').textContent = "Please start your webcam";
            break;
        case 'webcam_ready':
            document.getElementById('statusText').textContent = "Ready to call";
            break;
        case 'calling':
            document.getElementById('statusText').textContent = "Calling...";
            break;
        case 'ringing':
            document.getElementById('statusText').textContent = "Incoming call";
            break;
        case 'in_call':
            document.getElementById('statusText').textContent = "In call";
            break;
        default:
            document.getElementById('statusText').textContent = "";
    }
}

function resetCallState() {
    if (pc) {
        pc.close();
        pc = null;
    }
    
    if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
        remoteVideo.srcObject = null;
    }
    
    currentCallId = null;
    isCaller = false;
    pendingCandidates = [];
    hideIncomingCallModal();
    
    if (localStream) {
        updateUIState('webcam_ready');
    } else {
        updateUIState('init');
    }
}

// Event Listeners
webcamButton.onclick = async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        webcamVideo.srcObject = localStream;
        webcamVideo.muted = true;
        updateUIState('webcam_ready');
        connectSocket();
    } catch (err) {
        console.error("Error accessing media devices:", err);
        alert("Could not access camera/microphone");
    }
};

callButton.onclick = startCall;
hangupButton.onclick = hangup;
acceptCallBtn.onclick = answerCall;
rejectCallBtn.onclick = () => {
    socket.send(JSON.stringify({
        type: "reject_call",
        callId: currentCallId,
        reason: "rejected"
    }));
    resetCallState();
};

// Initialize
connectSocket();