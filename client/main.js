const servers = {
    iceServers: [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
    ],
    iceCandidatePoolSize: 10
};

let pc = null;
let localStream = null;
let remoteStream = null;
let socket = null;
let currentCallId = null;
let isCaller = false;
let pendingCandidates = [];
let keepaliveInterval = null;
let peerList = [];

const peerListElement = document.createElement('div');
peerListElement.id = 'peerList';
peerListElement.style.margin = '10px 0';
peerListElement.style.padding = '10px';
peerListElement.style.border = '1px solid #ccc';
peerListElement.style.borderRadius = '5px';

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

function initializeUI() {
    peerListElement.id = 'peerList';
    peerListElement.style.margin = '10px 0';
    peerListElement.style.padding = '10px';
    peerListElement.style.border = '1px solid #ccc';
    peerListElement.style.borderRadius = '5px';

    // Attach it to the DOM before calling update
    document.body.insertBefore(peerListElement, document.querySelector('h2:nth-of-type(2)'));

    // Now safe to update UI
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

function updatePeerStatus(peerId, status) {
    const peer = peerList.find(p => p.id === peerId);
    if (peer) {
        peer.status = status;
    } else {
        peerList.push({ id: peerId, status });
    }
    updatePeerListUI();
}

function connectSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

    socket.onopen = () => {
        console.log("WebSocket connected");
        socket.send(JSON.stringify({ type: "register" }));
        startKeepalive();
        sendPresenceUpdate();

        if (isCaller && currentCallId && pc?.localDescription) {
            socket.send(JSON.stringify({
                type: "initiate_call",
                callId: currentCallId,
                data: JSON.stringify(pc.localDescription)
            }));
        }
    };

    socket.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
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
        setTimeout(connectSocket, 3000);
    };

    socket.onerror = (error) => console.error("WebSocket error:", error);
}

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

async function createPeerConnection() {
    if (pc) pc.close();
    pc = new RTCPeerConnection(servers);

    pc.onicecandidate = (event) => {
    if (event.candidate && currentCallId && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: "ice-candidate",
            callId: currentCallId,  // Make sure this is set
            data: JSON.stringify(event.candidate)
        }));
    }
};
    pc.ontrack = (event) => {
        if (!remoteStream) {
            remoteStream = new MediaStream();
            remoteVideo.srcObject = remoteStream;
        }
        event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
    };

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    return pc;
}

async function startCall() {
    if (!localStream) return alert("Start webcam first");
    if (currentCallId) return alert("Already in a call");
    
    isCaller = true;
    currentCallId = "call_" + Math.random().toString(36).substr(2, 9);
    updateUIState('calling');
    sendPresenceUpdate();

    try {
        pc = await createPeerConnection();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering to complete
        const offerWithCandidates = await new Promise(resolve => {
            if (pc.iceGatheringState === 'complete') {
                resolve(pc.localDescription);
            } else {
                const checkState = () => {
                    if (pc.iceGatheringState === 'complete') {
                        pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve(pc.localDescription);
                    }
                };
                pc.addEventListener('icegatheringstatechange', checkState);
            }
        });

        socket.send(JSON.stringify({
            type: "initiate_call",
            callId: currentCallId,
            data: JSON.stringify(offerWithCandidates)
        }));
    } catch (err) {
        console.error("Call setup failed:", err);
        resetCallState();
    }
}

async function answerCall() {
    if (!currentCallId || !pc) return;
    if (!localStream) return alert("Start webcam first");

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.send(JSON.stringify({
        type: "accept_call",
        callId: currentCallId,
        data: JSON.stringify(answer)
    }));

    hideIncomingCallModal();
    updateUIState('in_call');
    sendPresenceUpdate();
}

function hangup() {
    if (currentCallId && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "hangup", callId: currentCallId }));
    }
    resetCallState();
}

async function handleIncomingCall(msg) {
    if (currentCallId) {
        socket.send(JSON.stringify({ 
            type: "reject_call", 
            callId: msg.callId, 
            reason: "busy" 
        }));
        return;
    }

    currentCallId = msg.callId;
    isCaller = false;
    
    try {
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            webcamVideo.srcObject = localStream;
            webcamVideo.muted = true;
        }

        pc = await createPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
        
        // Show incoming call UI
        showIncomingCallModal(msg.callerId);
        updateUIState('ringing');
    } catch (err) {
        console.error("Error handling incoming call:", err);
        socket.send(JSON.stringify({ 
            type: "reject_call", 
            callId: msg.callId, 
            reason: "error" 
        }));
        resetCallState();
    }
}

function handleAnswer(msg) {
    if (!isCaller || !pc) return;
    pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)))
        .then(() => {
            pendingCandidates.forEach(candidate => {
                pc.addIceCandidate(candidate).catch(console.error);
            });
            pendingCandidates = [];
            updateUIState('in_call');
            sendPresenceUpdate();
        })
        .catch(err => {
            console.error("Error setting remote description:", err);
            resetCallState();
        });
}

function handleICECandidate(msg) {
    if (!pc || msg.callId !== currentCallId) {
        console.log("Ignoring ICE candidate - no PC or callID mismatch");
        return;
    }
    
    try {
        const candidate = new RTCIceCandidate(JSON.parse(msg.data));
        if (pc.remoteDescription) {
            pc.addIceCandidate(candidate).catch(err => {
                console.error("Error adding ICE candidate:", err);
            });
        } else {
            pendingCandidates.push(candidate);
        }
    } catch (err) {
        console.error("Error parsing ICE candidate:", err);
    }
}
function showIncomingCallModal(callerId) {
    incomingModal.style.display = 'flex';
    ringtone.play().catch(console.warn);
    updateUIState('ringing');
}

function hideIncomingCallModal() {
    incomingModal.style.display = 'none';
    ringtone.pause();
    ringtone.currentTime = 0;
}

function updateUIState(state) {
    webcamButton.disabled = state !== 'init';
    callButton.disabled = state !== 'webcam_ready';
    answerButton.disabled = state !== 'ringing';
    hangupButton.disabled = !['in_call', 'calling'].includes(state);
    acceptCallBtn.disabled = state !== 'ringing';
    rejectCallBtn.disabled = state !== 'ringing';

    document.getElementById('statusText').textContent = {
        init: "Please start your webcam",
        webcam_ready: "Ready to call",
        calling: "Calling...",
        ringing: "Incoming call",
        in_call: "In call"
    }[state] || "";
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
        sendPresenceUpdate();
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
        sendPresenceUpdate();
    } catch (err) {
        console.error("Failed to access media:", err);
        alert("Could not access camera/mic");
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
    hideIncomingCallModal();
    resetCallState();
};

window.onload = initializeUI;
