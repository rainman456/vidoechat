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
const incomingModal = document.getElementById('incomingModal');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');
const ringtone = document.getElementById('ringtone');
const remoteVideo = document.getElementById('remoteVideo');
const callerIdDisplay = document.getElementById('callerIdDisplay');
const statusText = document.getElementById('statusText');
const connectionStatus = document.getElementById('connectionStatus');
const peerListElement = document.getElementById('peerList');

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
let dataChannel = null;

// Initialize UI
function initializeUI() {
    updateUIState('init');
    updateConnectionStatus('disconnected');
}

function updateConnectionStatus(status) {
    connectionStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    connectionStatus.className = `status-${status}`;
    
    if (pc) {
        connectionStatus.textContent += ` (${pc.connectionState})`;
        if (pc.connectionState === 'connected') {
            connectionStatus.classList.add('status-connected');
        } else if (pc.connectionState === 'disconnected') {
            connectionStatus.classList.add('status-disconnected');
        } else {
            connectionStatus.classList.add('status-connecting');
        }
    }
}

function updatePeerListUI() {
    peerListElement.innerHTML = '<h3>Available Peers</h3>';
    
    if (peerList.length === 0) {
        peerListElement.innerHTML += '<p>No other peers available</p>';
        return;
    }
    
    peerList.forEach(peer => {
        const peerItem = document.createElement('div');
        peerItem.className = 'peer-item';
        
        const peerInfo = document.createElement('div');
        const statusIndicator = document.createElement('span');
        statusIndicator.className = `status-indicator status-${peer.status === 'idle' ? 'idle' : 'busy'}`;
        peerInfo.appendChild(statusIndicator);
        peerInfo.appendChild(document.createTextNode(`${peer.id} (${peer.status})`));
        
        const callButton = document.createElement('button');
        callButton.textContent = "Call";
        callButton.disabled = peer.status !== 'idle' || !localStream;
        callButton.onclick = () => initiateCallWithPeer(peer.id);
        
        peerItem.appendChild(peerInfo);
        peerItem.appendChild(callButton);
        peerListElement.appendChild(peerItem);
    });
}

function updatePeerStatus(peerId, status) {
    const peer = peerList.find(p => p.id === peerId);
    if (peer) {
        peer.status = status;
    } else {
        peerList.push({ id: peerId, status });
    }
    updatePeerListUI();
}

// WebSocket connection
function connectSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        sendPresenceUpdate();
        return;
    }

    updateConnectionStatus('connecting');
    socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);

    socket.onopen = () => {
        console.log("WebSocket connected");
        updateConnectionStatus('connected');
        socket.send(JSON.stringify({
            type: "register"
        }));
        startKeepalive();
        sendPresenceUpdate();
        
        if (isCaller && currentCallId) {
            socket.send(JSON.stringify({
                type: "initiate_call",
                callId: currentCallId,
                data: JSON.stringify(pc.localDescription)
            }));
        }
    };

    socket.onmessage = async (event) => {
        try {
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
                    
                case "pong":
                    // Update last seen or connection status if needed
                    break;
                    
                default:
                    console.warn("Unknown message type:", msg.type);
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    };

    socket.onclose = () => {
        console.log("WebSocket disconnected");
        updateConnectionStatus('disconnected');
        stopKeepalive();
        setTimeout(connectSocket, 3000);
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        updateConnectionStatus('disconnected');
    };
}

// Presence management
function sendPresenceUpdate() {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: "presence_update",
            status: currentCallId ? "in-call" : "idle"
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
    try {
        if (pc) {
            pc.close();
            pc = null;
        }
        
        pc = new RTCPeerConnection(servers);
        updateConnectionStatus('connecting');
        
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
        
        pc.onconnectionstatechange = () => {
            updateConnectionStatus(pc.connectionState);
            if (pc.connectionState === 'failed') {
                alert("Connection failed. Please try again.");
                resetCallState();
            }
        };
        
        pc.ondatachannel = (event) => {
            setupDataChannel(event.channel);
        };
        
        if (isCaller) {
            dataChannel = pc.createDataChannel('chat');
            setupDataChannel(dataChannel);
        }
        
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }
        
        return pc;
    } catch (e) {
        console.error("Failed to create peer connection:", e);
        alert("Failed to initialize call. Please refresh and try again.");
        throw e;
    }
}

function setupDataChannel(channel) {
    channel.onopen = () => console.log("Data channel opened");
    channel.onclose = () => console.log("Data channel closed");
    channel.onmessage = (event) => {
        console.log("Received message:", event.data);
    };
}

// Call Management
async function initiateCallWithPeer(peerId) {
    if (!localStream) {
        alert("Please start your webcam first");
        return;
    }
    
    isCaller = true;
    currentCallId = "call_" + Math.random().toString(36).substr(2, 9);
    updateUIState('calling');
    
    try {
        pc = await createPeerConnection();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        socket.send(JSON.stringify({
            type: "initiate_call",
            callId: currentCallId,
            targetPeer: peerId,
            data: JSON.stringify(offer)
        }));
    } catch (e) {
        console.error("Call initiation failed:", e);
        resetCallState();
    }
}

async function startCall() {
    if (!localStream) {
        alert("Please start your webcam first");
        return;
    }
    
    isCaller = true;
    currentCallId = "call_" + Math.random().toString(36).substr(2, 9);
    updateUIState('calling');
    
    try {
        pc = await createPeerConnection();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        socket.send(JSON.stringify({
            type: "initiate_call",
            callId: currentCallId,
            data: JSON.stringify(offer)
        }));
    } catch (e) {
        console.error("Call initiation failed:", e);
        resetCallState();
    }
}

async function answerCall() {
    if (!currentCallId || !pc) return;
    
    try {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        socket.send(JSON.stringify({
            type: "accept_call",
            callId: currentCallId,
            data: JSON.stringify(answer)
        }));
        
        updateUIState('in_call');
    } catch (e) {
        console.error("Failed to answer call:", e);
        resetCallState();
    }
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
async function handleIncomingCall(msg) {
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
    
    try {
        pc = await createPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
    } catch (e) {
        console.error("Failed to handle incoming call:", e);
        resetCallState();
    }
}

function showIncomingCallModal(callerId) {
    callerIdDisplay.textContent = callerId;
    incomingModal.style.display = 'flex';
    
    incomingModal.onclick = (e) => {
        if (e.target === incomingModal) {
            hideIncomingCallModal();
            socket.send(JSON.stringify({
                type: "reject_call",
                callId: currentCallId,
                reason: "dismissed"
            }));
            resetCallState();
        }
    };
    
    document.addEventListener('keydown', function handleEscape(e) {
        if (e.key === 'Escape' && incomingModal.style.display === 'flex') {
            hideIncomingCallModal();
            socket.send(JSON.stringify({
                type: "reject_call",
                callId: currentCallId,
                reason: "dismissed"
            }));
            resetCallState();
            document.removeEventListener('keydown', handleEscape);
        }
    });
    
    ringtone.play().catch(e => console.log("Ringtone play failed:", e));
    updateUIState('ringing');
}

function hideIncomingCallModal() {
    incomingModal.style.display = 'none';
    ringtone.pause();
    ringtone.currentTime = 0;
}

// ICE Candidate Handling
async function handleICECandidate(msg) {
    if (!pc || !currentCallId || msg.callId !== currentCallId) return;
    
    try {
        const candidate = new RTCIceCandidate(JSON.parse(msg.data));
        if (pc.remoteDescription) {
            await pc.addIceCandidate(candidate);
        } else {
            pendingCandidates.push({
                candidate,
                timestamp: Date.now()
            });
            // Clean up old candidates
            const now = Date.now();
            pendingCandidates = pendingCandidates.filter(c => now - c.timestamp < 30000);
        }
    } catch (e) {
        console.error("Invalid ICE candidate:", e);
    }
}

async function handleAnswer(msg) {
    if (!isCaller || !pc) return;
    
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
        console.log("Remote description set with answer");
        
        // Process pending ICE candidates
        while (pendingCandidates.length > 0) {
            const { candidate } = pendingCandidates.shift();
            try {
                await pc.addIceCandidate(candidate);
            } catch (e) {
                console.error("Error adding ICE candidate:", e);
            }
        }
        
        updateUIState('in_call');
    } catch (e) {
        console.error("Error setting remote description:", e);
        resetCallState();
    }
}

// UI Management
function updateUIState(state) {
    webcamButton.disabled = state !== 'init';
    callButton.disabled = state !== 'webcam_ready';
    answerButton.disabled = state !== 'ringing';
    hangupButton.disabled = state !== 'in_call' && state !== 'calling';
    
    switch(state) {
        case 'init':
            statusText.textContent = "Please start your webcam";
            break;
        case 'webcam_ready':
            statusText.textContent = "Ready to call";
            break;
        case 'calling':
            statusText.textContent = "Calling...";
            break;
        case 'ringing':
            statusText.textContent = "Incoming call";
            break;
        case 'in_call':
            statusText.textContent = "In call";
            break;
        default:
            statusText.textContent = "";
    }
    
    sendPresenceUpdate();
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
    
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
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
    
    sendPresenceUpdate();
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
initializeUI();
connectSocket();