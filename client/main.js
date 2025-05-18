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

//HTML elements
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

  remoteStream = new MediaStream(); // Ensure it's always initialized
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

  return pc;
}


webcamButton.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    remoteStream = new MediaStream();

    if (!pc || pc.signalingState === 'closed') {
      pc = createPeerConnection();
    }

   const senders = pc.getSenders().map(s => s.track);
localStream.getTracks().forEach((track) => {
  if (!senders.includes(track)) {
    pc.addTrack(track, localStream);
  }
});

    webcamVideo.srcObject = localStream;
    //remoteVideo.srcObject = remoteStream;

    callButton.disabled = false;
    answerButton.disabled = false;
    webcamButton.disabled = true;
  } catch (e) {
    console.error("Error accessing media devices.", e);
    alert("Error accessing media devices: " + e.message);
  }
  //connectSocket(); 

};



function connectSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  socket.onopen = async () => {
    console.log("Connected to signaling server");

    if (!pc || pc.signalingState === 'closed') {
       pc = createPeerConnection();
    }

    if (isCaller && currentCallId) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.send(JSON.stringify({
          type: "offer",
          callId: currentCallId,
          data: JSON.stringify(pc.localDescription),
        }));
      } catch (e) {
        console.error("Error creating or sending offer:", e);
      }
    } else if (!isCaller && currentCallId) {
      socket.send(JSON.stringify({
        type: "join_call",
        callId: currentCallId,
      }));
    }
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
    } catch (e) {
      console.error("Invalid JSON from signaling server:", event.data);
      return;
    }
  
    // Handle incoming_call and call_taken early
    if (msg.type === "incoming_call") {
      if (!localStream) {
        await webcamButton.onclick(); // Automatically prepare webcam
      }
      showIncomingModal(msg.callId, msg.from);
      return;
    }
  
    if (msg.type === "call_taken") {
      hideIncomingModal(); // Someone else accepted
      alert("Another user answered the call.");
      return;
    }
  
    // Match or reject unknown callId
    if (msg.callId && !currentCallId) {
      currentCallId = msg.callId;
      callInput.value = currentCallId;
      console.log(`Initialized currentCallId from incoming message: ${currentCallId}`);
    } else if (msg.callId && msg.callId !== currentCallId) {
      console.warn(`Received message for different callId: ${msg.callId}. Current: ${currentCallId}. Ignoring.`);
      return;
    }
  
    try {
      if (msg.type === "offer" && !isCaller) {
        if (!pc || pc.signalingState === 'closed') {
          pc = createPeerConnection();
        }
  
        if (!currentCallId && msg.callId) {
          currentCallId = msg.callId;
          callInput.value = currentCallId;
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
  
      } else if (msg.type === "error") {
        console.error("Signaling error:", msg.message);
        alert("Signaling error: " + msg.message);
      } else if (msg.type === "call_joined" && !isCaller) {
        console.log("Successfully joined call. Waiting for offer.");
      } else if (msg.type === "peer_disconnected") {
        alert("The other user has disconnected.");
        resetCallState();
      }
  
    } catch (err) {
      console.error("Error processing message or WebRTC operation:", err, "Original message:", msg);
    }
  }
};

callButton.onclick = async () => {
  if (!localStream) await webcamButton.onclick();

  isCaller = true;
  currentCallId = "call_" + Math.random().toString(36).substring(2, 11);
  callInput.value = currentCallId;
  callInput.readOnly = true;

 if (!socket || socket.readyState !== WebSocket.OPEN) {
  connectSocket();
}


  // Delay this until socket is open
  const sendIncoming = () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "incoming_call",
        callId: currentCallId,
        from: "Caller"
      }));
    } else {
      setTimeout(sendIncoming, 100);
    }
  };
  sendIncoming();
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

    pc.close();
    pc = null;
  }

  if (socket) {
    socket.close();
    socket = null;
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
  currentCallId = callId;
  incomingModal.style.display = 'flex';
  ringtone.play();
}

function hideIncomingModal() {
  incomingModal.style.display = 'none';
  ringtone.pause();
  ringtone.currentTime = 0;
}


//Initial state
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
  connectSocket(); // Connect WebSocket immediately on page load
});
