
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

let audioMuted = false;
let videoOff = false;

muteAudioBtn.onclick = () => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
        audioMuted = !track.enabled;
        muteAudioBtn.textContent = audioMuted ? "Unmute Audio" : "Mute Audio";
    });
};

toggleVideoBtn.onclick = () => {
    if (!localStream) return;
    localStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
        videoOff = !track.enabled;
        toggleVideoBtn.textContent = videoOff ? "Turn Camera On" : "Turn Camera Off";
    });
};

function createPeerConnection() {
    if (pc) {
        pc.close();
    }

    pc = new RTCPeerConnection(servers);

    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;

    pc.ontrack = (event) => {
        event.streams[0].getTracks().forEach((track) => {
            remoteStream.addTrack(track);
        });
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && socket && socket.readyState === WebSocket.OPEN && currentCallId) {
            socket.send(JSON.stringify({
                type: "ice-candidate",
                callId: currentCallId,
                data: JSON.stringify(event.candidate),
            }));
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            alert("Connection failed. Please try again.");
            resetCallState();
        }
    };

    return pc;
}

webcamButton.onclick = async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        pc = createPeerConnection();

        localStream.getTracks().forEach((track) => {
            pc.addTrack(track, localStream);
        });

        webcamVideo.srcObject = localStream;
        remoteVideo.srcObject = remoteStream;

        callButton.disabled = false;
        answerButton.disabled = false;
        webcamButton.disabled = true;
    } catch (e) {
        console.error("Error accessing media devices:", e);
        alert("Error accessing media devices: " + e.message);
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
    };

    socket.onclose = () => {
        console.warn("WebSocket connection closed.");
        alert("Disconnected from signaling server.");
        resetCallState();
    };

    socket.onerror = (err) => {
        console.error("WebSocket error:", err);
    };

    socket.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
            if (!msg.type || (msg.callId && typeof msg.callId !== 'string')) {
                throw new Error("Invalid message structure");
            }
        } catch (e) {
            console.error("Invalid JSON or message structure:", event.data, e);
            return;
        }

        if (msg.type === "incoming_call" && !isCaller) {
            if (!localStream) await webcamButton.onclick();
            showIncomingModal(msg.callId, msg.from || "Unknown");
            return;
        }

        if (msg.type === "call_taken" && !isCaller) { // Only non-callers process call_taken
            hideIncomingModal();
            alert("Another user accepted the call.");
            resetCallState();
            return;
        }

        if (msg.callId && !currentCallId) {
            currentCallId = msg.callId;
            callInput.value = currentCallId;
            console.log(`Initialized currentCallId: ${currentCallId}`);
        } else if (msg.callId && msg.callId !== currentCallId) {
            console.warn(`Received callId ${msg.callId} differs from current ${currentCallId}. Ignoring.`);
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

                for (const candidate of pendingCandidates) {
                    await pc.addIceCandidate(candidate);
                }
                pendingCandidates = [];

                hangupButton.disabled = false;

            } else if (msg.type === "answer" && isCaller) {
                const answer = JSON.parse(msg.data || '{}');
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
                hangupButton.disabled = false;

            } else if (msg.type === "ice-candidate") {
                const candidate = new RTCIceCandidate(JSON.parse(msg.data || '{}'));
                if (pc.remoteDescription && pc.remoteDescription.type) {
                    await pc.addIceCandidate(candidate);
                } else {
                    pendingCandidates.push(candidate);
                }

            } else if (msg.type === "error") {
                console.error("Signaling error:", msg.message);
                alert("Signaling error: " + msg.message);
            } else if (msg.type === "call_joined" && !isCaller) {
                console.log("Successfully joined call.");
            } else if (msg.type === "peer_disconnected") {
                alert("The other user has disconnected.");
                resetCallState();
            }
        } catch (err) {
            console.error("Error processing message:", err, "Message:", msg);
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

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            socket.send(JSON.stringify({
                type: "offer",
                callId: currentCallId,
                data: JSON.stringify(pc.localDescription),
            }));
        } catch (e) {
            console.error("Error sending offer or incoming_call:", e);
            alert("Failed to initiate call: " + e.message);
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
        return;
    }
    hideIncomingModal();

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
    }
    resetCallState();
};

function resetCallState() {
    if (pc) {
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
    if (remoteVideo) webcamVideo.srcObject = null;

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
}

function showIncomingModal(callId, from) {
    currentCallId = callId;
    incomingModal.style.display = 'flex';
    if (ringtone.paused) ringtone.play().catch(e => console.error("Ringtone play failed:", e));
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
};

rejectCallBtn.onclick = () => {
    hideIncomingModal();
};

window.addEventListener('load', () => {
    connectSocket();
});
