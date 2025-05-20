// const servers = {
//     iceServers: [
//         {
//             urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
//         },
//     ],
//     iceCandidatePoolSize: 10,
// };
const servers = {
     iceServers: [
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "e6166b934e60840d935743c7",
        credential: "uNdKAwfH/TDOs6EP",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "e6166b934e60840d935743c7",
        credential: "uNdKAwfH/TDOs6EP",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "e6166b934e60840d935743c7",
        credential: "uNdKAwfH/TDOs6EP",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "e6166b934e60840d935743c7",
        credential: "uNdKAwfH/TDOs6EP",
      },
    ],
    iceCandidatePoolSize: 10,
};

let pc = null;
let localStream = null;
let remoteStream = null;
let socket = null;
let currentCallId = null;
let isCaller = false;
let pendingCandidates = [];

// HTML elements
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');
const incomingModal = document.getElementById('incomingModal');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');
const ringtone = document.getElementById('ringtone');
const muteAudioBtn = document.getElementById('muteAudioBtn');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');
const statusText = document.getElementById('statusText');
const connectionStatus = document.getElementById('connectionStatus');
const userCount = document.getElementById('userCount');

let audioMuted = false;
let videoOff = false;

function updateStatus(message) {
    console.log(`Status: ${message}`);
    if (statusText) statusText.textContent = message;
}

function updateConnectionStatus(state) {
    console.log(`Connection state: ${state}`);
    if (connectionStatus) {
        connectionStatus.textContent = state;
        connectionStatus.className = `status-${state.toLowerCase()}`;
    }
}

function updateUserCount(count) {
    console.log(`User count: ${count}`);
    if (userCount) {
        userCount.textContent = `Users connected: ${count}`;
    }
}

muteAudioBtn.onclick = () => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
        audioMuted = !track.enabled;
        muteAudioBtn.textContent = audioMuted ? "Unmute Audio" : "Mute Audio";
    });
    updateStatus(audioMuted ? "Audio muted" : "Audio unmuted");
};

toggleVideoBtn.onclick = () => {
    if (!localStream) return;
    localStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
        videoOff = !track.enabled;
        toggleVideoBtn.textContent = videoOff ? "Turn Camera On" : "Turn Camera Off";
    });
    updateStatus(videoOff ? "Video off" : "Video on");
};

function createPeerConnection() {
    if (pc && pc.signalingState !== 'closed') {
        console.log("Reusing existing peer connection");
        return pc;
    }

    pc = new RTCPeerConnection(servers);
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;

    pc.ontrack = event => {
        console.log("Received track:", event.track);
        event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
        updateStatus("Received remote stream");
    };

    pc.onicecandidate = event => {
        if (event.candidate && socket?.readyState === WebSocket.OPEN && currentCallId) {
            console.log("Sending ICE candidate:", event.candidate);
            socket.send(JSON.stringify({
                type: "ice-candidate",
                callId: currentCallId,
                data: JSON.stringify(event.candidate),
            }));
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE state: ${pc.iceConnectionState}`);
        updateConnectionStatus(pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
            updateStatus("Connection failed");
            resetCallState();
        }
    };

    return pc;
}

webcamButton.onclick = async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        pc = createPeerConnection();
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        webcamVideo.srcObject = localStream;
        callButton.disabled = false;
        webcamButton.disabled = true;
        updateStatus("Webcam started");
    } catch (e) {
        console.error("Media error:", e);
        updateStatus("Error: Failed to access media");
        alert("Failed to access webcam: " + e.message);
    }
};

function connectSocket(onOpenCallback = () => {}) {
    if (socket?.readyState === WebSocket.OPEN) {
        onOpenCallback();
        return;
    }

    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${wsProtocol}://${location.host}/ws`);

    socket.onopen = () => {
        console.log("WebSocket connected");
        updateStatus("Connected to signaling server");
        updateConnectionStatus("Connected");
        pc = createPeerConnection();
        onOpenCallback();
    };

    socket.onclose = () => {
        console.warn("WebSocket closed");
        updateStatus("Disconnected from server");
        updateConnectionStatus("Disconnected");
        setTimeout(() => connectSocket(), 3000);
    };

    socket.onerror = err => {
        console.error("WebSocket error:", err);
        updateStatus("WebSocket error");
    };

    socket.onmessage = async event => {
        let msg;
        try {
            msg = JSON.parse(event.data);
            console.log("Received message:", msg);
        } catch (e) {
            console.error("Invalid message:", event.data, e);
            updateStatus("Error: Invalid message");
            return;
        }

        if (msg.type === "user_count") {
            updateUserCount(msg.count || 0);
            return;
        }

        if (msg.type === "incoming_call" && !isCaller) {
            currentCallId = msg.callId;
            showIncomingModal(msg.callId, msg.from || "Unknown");
            return;
        }

        if (msg.type === "call_taken" && !isCaller) {
            hideIncomingModal();
            updateStatus("Call taken by another user");
            resetCallState();
            return;
        }

        if (msg.callId && msg.callId !== currentCallId) {
            console.warn(`Ignoring message with callId ${msg.callId}, expected ${currentCallId}`);
            return;
        }

        try {
            if (msg.type === "offer" && !isCaller) {
                pc = createPeerConnection();
                await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.send(JSON.stringify({
                    type: "answer",
                    callId: currentCallId,
                    data: JSON.stringify(pc.localDescription),
                }));
                updateStatus("Sent answer");
                for (const candidate of pendingCandidates) {
                    await pc.addIceCandidate(candidate);
                }
                pendingCandidates = [];
                hangupButton.disabled = false;

            } else if (msg.type === "answer" && isCaller) {
                await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
                for (const candidate of pendingCandidates) {
                    await pc.addIceCandidate(candidate);
                }
                pendingCandidates = [];
                hangupButton.disabled = false;
                updateStatus("Received answer");

            } else if (msg.type === "ice-candidate") {
                const candidate = new RTCIceCandidate(JSON.parse(msg.data));
                if (pc.remoteDescription) {
                    await pc.addIceCandidate(candidate);
                    updateStatus("Added ICE candidate");
                } else {
                    pendingCandidates.push(candidate);
                    updateStatus("Stored ICE candidate");
                }

            } else if (msg.type === "call_joined") {
                updateStatus("Joined call");
                hangupButton.disabled = false;

            } else if (msg.type === "peer_disconnected") {
                updateStatus("Peer disconnected");
                resetCallState();

            } else if (msg.type === "error") {
                updateStatus(`Error: ${msg.data}`);
                resetCallState();
            }
        } catch (e) {
            console.error("Message processing error:", e, msg);
            updateStatus(`Error processing ${msg.type}`);
        }
    };
}

callButton.onclick = async () => {
    if (!localStream) await webcamButton.onclick();
    isCaller = true;
    currentCallId = "call_" + crypto.randomUUID();
    pc = createPeerConnection();

    const sendOffer = async () => {
        try {
            socket.send(JSON.stringify({
                type: "incoming_call",
                callId: currentCallId,
                from: "Caller"
            }));
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.send(JSON.stringify({
                type: "offer",
                callId: currentCallId,
                data: JSON.stringify(pc.localDescription),
            }));
            updateStatus("Sent offer");
        } catch (e) {
            console.error("Offer error:", e);
            updateStatus("Error sending offer");
            resetCallState();
        }
    };

    connectSocket(sendOffer);
};

acceptCallBtn.onclick = async () => {
    hideIncomingModal();
    if (!localStream) await webcamButton.onclick();
    socket.send(JSON.stringify({
        type: "accept_call",
        callId: currentCallId,
    }));
    updateStatus("Accepted call");
};

rejectCallBtn.onclick = () => {
    hideIncomingModal();
    updateStatus("Rejected call");
    resetCallState();
};

hangupButton.onclick = () => {
    if (socket?.readyState === WebSocket.OPEN && currentCallId) {
        socket.send(JSON.stringify({
            type: "hangup",
            callId: currentCallId,
        }));
    }
    resetCallState();
};

function resetCallState() {
    if (pc && pc.signalingState !== 'closed') {
        pc.close();
        pc = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
    }
    webcamVideo.srcObject = null;
    remoteVideo.srcObject = null;
    currentCallId = null;
    isCaller = false;
    pendingCandidates = [];
    callButton.disabled = !localStream;
    hangupButton.disabled = true;
    webcamButton.disabled = false;
    hideIncomingModal();
    updateStatus("Call ended");
    updateConnectionStatus("Disconnected");
}

function showIncomingModal(callId, from) {
    currentCallId = callId;
    incomingModal.style.display = 'flex';
    ringtone.play().catch(e => console.error("Ringtone error:", e));
    updateStatus(`Incoming call from ${from}`);
}

function hideIncomingModal() {
    incomingModal.style.display = 'none';
    ringtone.pause();
    ringtone.currentTime = 0;
}

window.addEventListener('load', () => connectSocket());