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

// Initialize WebSocket connection on page load
window.addEventListener('load', () => {
  connectSocket();
});

function connectSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  socket.onopen = () => {
    console.log("Connected to signaling server");
    // No need to create peer connection here - we'll do it when needed
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error("Invalid JSON from signaling server:", event.data);
      return;
    }

    // Handle incoming calls first
    if (msg.type === "incoming_call") {
      if (!currentCallId || currentCallId === msg.callId) {
        currentCallId = msg.callId;
        showIncomingModal(msg.callId, msg.from || "Anonymous");
      }
      return;
    }

    if (msg.type === "call_taken") {
      hideIncomingModal();
      if (isCaller) {
        alert("Another user accepted the call.");
        resetCallState();
      }
      return;
    }

    // Match callId with current call or initialize if new
    if (msg.callId) {
      if (!currentCallId) {
        currentCallId = msg.callId;
        callInput.value = currentCallId;
      } else if (msg.callId !== currentCallId) {
        console.warn(`Received message for different callId: ${msg.callId}. Current: ${currentCallId}.`);
        return;
      }
    }

    try {
      if (msg.type === "offer" && !isCaller) {
        if (!pc || pc.signalingState === 'closed') {
          pc = createPeerConnection();
        }

        const remoteOffer = JSON.parse(msg.data);
        await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.send(JSON.stringify({
          type: "answer",
          callId: currentCallId,
          data: JSON.stringify(pc.localDescription),
        }));

        for (const c of pendingCandidates) {
          await pc.addIceCandidate(c);
        }
        pendingCandidates = [];
        hangupButton.disabled = false;

      } else if (msg.type === "answer" && isCaller) {
        const answer = JSON.parse(msg.data);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        hangupButton.disabled = false;

      } else if (msg.type === "ice-candidate") {
        const candidate = new RTCIceCandidate(JSON.parse(msg.data));
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(candidate);
        } else {
          pendingCandidates.push(candidate);
        }

      } else if (msg.type === "call_joined") {
        console.log("Successfully joined call");

      } else if (msg.type === "peer_disconnected") {
        alert("The other user has disconnected.");
        resetCallState();

      } else if (msg.type === "error") {
        console.error("Signaling error:", msg.message);
        alert("Signaling error: " + msg.message);
      }
    } catch (err) {
      console.error("Error processing message:", err, "Original message:", msg);
    }
  };

  socket.onclose = () => {
    console.log("WebSocket connection closed");
    // Attempt to reconnect after a delay
    setTimeout(connectSocket, 3000);
  };

  socket.onerror = (error) => {
    console.error("WebSocket Error:", error);
  };
}

function createPeerConnection() {
  if (pc) {
    pc.close();
  }

  pc = new RTCPeerConnection(servers);

  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  pc.ontrack = (event) => {
    if (!event.streams || event.streams.length === 0) return;
    event.streams[0].getTracks().forEach((track) => {
      if (!remoteStream.getTracks().some(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
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

  return pc;
}

webcamButton.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    webcamVideo.srcObject = localStream;

    callButton.disabled = false;
    answerButton.disabled = false;
    webcamButton.disabled = true;
  } catch (e) {
    console.error("Error accessing media devices:", e);
    alert("Error accessing media devices: " + e.message);
  }
};

callButton.onclick = async () => {
  if (!localStream) {
    await webcamButton.onclick();
  }

  isCaller = true;
  currentCallId = "call_" + Math.random().toString(36).substring(2, 11);
  callInput.value = currentCallId;
  callInput.readOnly = true;

  pc = createPeerConnection();
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  const sendOffer = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.send(JSON.stringify({
        type: "offer",
        callId: currentCallId,
        data: JSON.stringify(pc.localDescription),
      }));

      // Notify other users about the incoming call
      socket.send(JSON.stringify({
        type: "incoming_call",
        callId: currentCallId,
        from: "User" // You can customize this
      }));
    } catch (e) {
      console.error("Error creating offer:", e);
    }
  };

  if (socket.readyState === WebSocket.OPEN) {
    await sendOffer();
  } else {
    socket.addEventListener('open', sendOffer, { once: true });
  }
};

answerButton.onclick = async () => {
  if (!localStream) {
    await webcamButton.onclick();
  }

  isCaller = false;
  currentCallId = callInput.value.trim();
  if (!currentCallId) {
    alert("Please enter a call ID");
    return;
  }

  callInput.readOnly = true;
  pc = createPeerConnection();
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  socket.send(JSON.stringify({
    type: "join_call",
    callId: currentCallId,
  }));
};

acceptCallBtn.onclick = async () => {
  if (!localStream) {
    await webcamButton.onclick();
  }

  hideIncomingModal();
  isCaller = false;
  callInput.value = currentCallId;
  callInput.readOnly = true;

  pc = createPeerConnection();
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  socket.send(JSON.stringify({
    type: "accept_call",
    callId: currentCallId,
  }));
};

rejectCallBtn.onclick = () => {
  hideIncomingModal();
  currentCallId = null;
};

hangupButton.onclick = () => {
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
    pc.close();
    pc = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    webcamVideo.srcObject = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
    remoteVideo.srcObject = null;
  }

  currentCallId = null;
  isCaller = false;
  pendingCandidates = [];
  callInput.value = "";
  callInput.readOnly = false;

  callButton.disabled = true;
  answerButton.disabled = true;
  hangupButton.disabled = true;
  webcamButton.disabled = false;
}

function showIncomingModal(callId, from) {
  incomingModal.style.display = 'flex';
  document.getElementById('callerName').textContent = from || 'Anonymous';
  ringtone.play();
}

function hideIncomingModal() {
  incomingModal.style.display = 'none';
  ringtone.pause();
  ringtone.currentTime = 0;
}

// Initialize UI state
callButton.disabled = true;
answerButton.disabled = true;
hangupButton.disabled = true;