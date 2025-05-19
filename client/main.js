const servers = {
    iceServers: [
        {
            urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
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
const callInput = document.getElementById('callInput');
const answerButton = document.getElementById('answerButton');
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

let audioMuted = false;
let videoOff = false;

function updateStatus(message) {
    if (statusText) statusText.textContent = message;
}

function updateConnectionStatus(state) {
    if (connectionStatus) {
        connectionStatus.textContent = state;
        connectionStatus.className = `status-${state.toLowerCase()}`;
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
        return pc; // Reuse existing connection if not closed
    }

    pc = new RTCPeerConnection(servers);

    if (!remoteStream) {
        remoteStream = new MediaStream();
        if (remoteVideo) {
            remoteVideo.srcObject = remoteStream;
        }
    }

    pc.ontrack = (event) => {
        console.log("ontrack fired:", event.streams, event.track);
        if (event.streams && event.streams[0]) {
            event.streams[0].getTracks().forEach((track) => {
                console.log("Adding track to remoteStream:", track);
                remoteStream.addTrack(track);
            });
            updateStatus(`Received ${event.streams[0].getTracks().length} track(s) from remote peer`);
        } else {
            console.warn("No streams in ontrack event:", event);
            updateStatus("Warning: No streams received in ontrack event");
        }
        console.log("Current remoteStream tracks:", remoteStream.getTracks());
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && socket && socket.readyState === WebSocket.OPEN && currentCallId) {
            console.log("Sending ICE candidate:", event.candidate);
            socket.send(JSON.stringify({
                type: "ice-candidate",
                callId: currentCallId,
                data: JSON.stringify(event.candidate),
            }));
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state: ${pc.iceConnectionState}`);
        updateConnectionStatus(pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
            alert("Connection failed. Please try again.");
            updateStatus("Connection failed");
            resetCallState();
        }
    };

    return pc;
}

webcamButton.onclick = async () => {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("WebRTC not supported in this browser");
        }
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        pc = createPeerConnection();

        localStream.getTracks().forEach((track) => {
            console.log("Adding local track:", track);
            pc.addTrack(track, localStream);
        });

        webcamVideo.srcObject = localStream;
        callButton.disabled = false;
        answerButton.disabled = false;
        webcamButton.disabled = true;
        updateStatus("Webcam started");
    } catch (e) {
        console.error("Error accessing media devices:", e);
        alert("Error accessing media devices: " + e.message);
        updateStatus("Error: Failed to access media devices");
    }
};

function connectSocket(onOpenCallback = () => {}) {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        if (socket.readyState === WebSocket.OPEN) onOpenCallback();
        return;
    }

    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${wsProtocol}://${location.host}/ws`);

    socket.onopen = () => {
        console.log("Connected to signaling server");
        if (!pc || pc.signalingState === 'closed') {
            pc = createPeerConnection();
        }
        onOpenCallback();
        updateStatus("Connected to signaling server");
    };

    socket.onclose = () => {
        console.warn("WebSocket connection closed.");
        alert("Disconnected from signaling server.");
        updateStatus("Disconnected from signaling server");
        resetCallState();
    };

    socket.onerror = (err) => {
        console.error("WebSocket error:", err);
        updateStatus("WebSocket error");
    };

    socket.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
            if (!msg.type || (msg.callId && typeof msg.callId !== 'string')) {
                throw new Error("Invalid message structure");
            }
            console.log("Received message:", msg);
            updateStatus(`Received message: ${msg.type}`);
        } catch (e) {
            console.error("Invalid JSON or message structure:", event.data, e);
            updateStatus("Error: Invalid message received");
            return;
        }

        if (msg.type === "incoming_call" && !isCaller) {
            if (!localStream) await webcamButton.onclick();
            showIncomingModal(msg.callId, msg.from || "Unknown");
            updateStatus("Incoming call received");
            return;
        }

        if (msg.type === "call_taken" && !isCaller) {
            hideIncomingModal();
            alert("Another user accepted the call.");
            updateStatus("Call taken by another user");
            resetCallState();
            return;
        }

        if (msg.callId && !currentCallId) {
            currentCallId = msg.callId;
            callInput.value = currentCallId;
            console.log(`Initialized currentCallId: ${currentCallId}`);
            updateStatus(`Call ID set: ${currentCallId}`);
        } else if (msg.callId && msg.callId !== currentCallId) {
            console.warn(`Received callId ${msg.callId} differs from current ${currentCallId}. Ignoring.`);
            updateStatus(`Ignored message with mismatched callId: ${msg.callId}`);
            return;
        }

        try {
            if (msg.type === "offer" && !isCaller) {
                pc = createPeerConnection();
                const remoteOffer = JSON.parse(msg.data || '{}');
                await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                socket.send(JSON.stringify({
                    type: "answer",
                    callId: currentCallId,
                    data: JSON.stringify(pc.localDescription),
                }));
                updateStatus("Sent answer to caller");

                for (const candidate of pendingCandidates) {
                    console.log("Applying pending ICE candidate:", candidate);
                    await pc.addIceCandidate(candidate);
                }
                pendingCandidates = [];

                hangupButton.disabled = false;

            } else if (msg.type === "answer" && isCaller) {
                const answer = JSON.parse(msg.data || '{}');
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
                for (const candidate of pendingCandidates) {
                    console.log("Applying pending ICE candidate after answer:", candidate);
                    await pc.addIceCandidate(candidate);
                }
                pendingCandidates = [];
                hangupButton.disabled = false;
                updateStatus("Received answer from callee");

            } else if (msg.type === "ice-candidate") {
                const candidate = new RTCIceCandidate(JSON.parse(msg.data || '{}'));
                if (pc.remoteDescription && pc.remoteDescription.type) {
                    console.log("Adding ICE candidate:", candidate);
                    await pc.addIceCandidate(candidate);
                    updateStatus("Added ICE candidate");
                } else {
                    console.log("Storing pending ICE candidate:", candidate);
                    pendingCandidates.push(candidate);
                    updateStatus("Stored pending ICE candidate");
                }

            } else if (msg.type === "error") {
                console.error("Signaling error:", msg.message);
                alert("Signaling error: " + msg.message);
                updateStatus(`Signaling error: ${msg.message}`);
            } else if (msg.type === "call_joined" && !isCaller) {
                console.log("Successfully joined call.");
                updateStatus("Joined call");
            } else if (msg.type === "peer_disconnected") {
                alert("The other user has disconnected.");
                updateStatus("Peer disconnected");
                resetCallState();
            }
        } catch (err) {
            console.error("Error processing message:", err, "Message:", msg);
            updateStatus(`Error processing message: ${err.message}`);
        }
    };
}

callButton.onclick = async () => {
    if (!localStream) await webcamButton.onclick();

    isCaller = true;
    currentCallId = "call_" + crypto.randomUUID();
    callInput.value = currentCallId;
    callInput.readOnly = true;

    const sendOfferAndIncomingCall = async () => {
        try {
            socket.send(JSON.stringify({
                type: "incoming_call",
                callId: currentCallId,
                from: "Caller"
            }));
            updateStatus("Sent incoming call notification");

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            socket.send(JSON.stringify({
                type: "offer",
                callId: currentCallId,
                data: JSON.stringify(pc.localDescription),
            }));
            updateStatus("Sent offer");
        } catch (e) {
            console.error("Error sending offer or incoming_call:", e);
            alert("Failed to initiate call: " + e.message);
            updateStatus("Error: Failed to initiate call");
            resetCallState();
        }
    };

    connectSocket(sendOfferAndIncomingCall);
};

answerButton.onclick = async () => {
    if (!localStream) await webcamButton.onclick();

    isCaller = false;
    currentCallId = callInput.value.trim();
    callInput.readOnly = true;

    if (!currentCallId) {
        alert("Please enter a Call ID to answer.");
        callInput.readOnly = false;
        updateStatus("Error: No Call ID provided");
        return;
    }
    hideIncomingModal();
    updateStatus("Joining call");

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        connectSocket();
    }
};

hangupButton.onclick = async () => {
    if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
        socket.send(JSON.stringify({
            type: "hangup",
            callId: currentCallId,
        }));
        updateStatus("Sent hangup");
    }
    resetCallState();
};

function resetCallState() {
    if (pc && pc.signalingState !== 'closed') {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.close();
        pc = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => {
            if (track.readyState === 'live') track.stop();
        });
        localStream = null;
    }

    if (remoteStream) {
        remoteStream.getTracks().forEach(track => {
            if (track.readyState === 'live') track.stop();
        });
        remoteStream = null;
    }

    if (webcamVideo) webcamVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "User hung up");
        socket = null;
    }

    currentCallId = null;
    isCaller = false;
    pendingCandidates = [];

    if (callInput) {
        callInput.value = "";
        callInput.readOnly = false;
    }

    callButton.disabled = true;
    answerButton.disabled = true;
    hangupButton.disabled = true;
    webcamButton.disabled = false;

    hideIncomingModal();
    updateStatus("Call ended");
    updateConnectionStatus("Disconnected");
}

function showIncomingModal(callId, from) {
    currentCallId = callId;
    incomingModal.style.display = 'flex';
    if (ringtone.paused) ringtone.play().catch(e => {
        console.error("Ringtone play failed:", e);
        updateStatus("Error: Failed to play ringtone");
    });
    updateStatus(`Incoming call from ${from}`);
}

function hideIncomingModal() {
    incomingModal.style.display = 'none';
    if (!ringtone.paused) {
        ringtone.pause();
        ringtone.currentTime = 0;
    }
}

// Initial state
callButton.disabled = true;
answerButton.disabled = true;
hangupButton.disabled = true;

acceptCallBtn.onclick = async () => {
    hideIncomingModal();
    isCaller = false;
    callInput.value = currentCallId;
    callInput.readOnly = true;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        connectSocket();
    }
    socket.send(JSON.stringify({
        type: "accept_call",
        callId: currentCallId,
    }));
    updateStatus("Accepted call");
};

rejectCallBtn.onclick = () => {
    hideIncomingModal();
    updateStatus("Rejected call");
};

window.addEventListener('load', () => {
    connectSocket();
});