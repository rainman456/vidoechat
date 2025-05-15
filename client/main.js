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

const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput');
const answerButton = document.getElementById('answerButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');

function createPeerConnection() {
  const peer = new RTCPeerConnection(servers);

  peer.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
  };

  peer.onicecandidate = (event) => {
    if (event.candidate && socket && socket.readyState === WebSocket.OPEN && currentCallId) {
      socket.send(JSON.stringify({
        type: "ice-candidate",
        callId: currentCallId,
        data: JSON.stringify(event.candidate),
      }));
    }
  };

  return peer;
}

webcamButton.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    remoteStream = new MediaStream();

    if (!pc || pc.signalingState === 'closed') {
      pc = createPeerConnection();
    }

    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    webcamVideo.srcObject = localStream;
    remoteVideo.srcObject = remoteStream;

    callButton.disabled = false;
    answerButton.disabled = false;
    webcamButton.disabled = true;
  } catch (e) {
    console.error("Error accessing media devices.", e);
    alert("Error accessing media devices: " + e.message);
  }
};


callButton.onclick = async () => {
  isCaller = true;
  currentCallId = "call_" + Math.random().toString(36).substr(2, 9);

  connectSocket();

  hangupButton.disabled = false;
  callButton.disabled = true;
  webcamButton.disabled = true;
};

answerButton.style.display = "none"; // hide answer button (not needed anymore)

function connectSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) return;

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
        console.error("Error creating/sending offer:", e);
      }
    }
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error("Invalid JSON:", event.data);
      return;
    }

    if (!msg.callId) return;

    // Auto-sync callId
    if (!currentCallId) {
      currentCallId = msg.callId;
      console.log("Joined callId:", currentCallId);
    }

    try {
      if (msg.type === "offer" && !isCaller) {
        if (!localStream) {
          console.warn("Webcam not initialized yet.");
          return;
        }
        showIncomingCallPopup(msg);

      } else if (msg.type === "answer" && isCaller) {
        const answer = JSON.parse(msg.data);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        hangupButton.disabled = false;

      } else if (msg.type === "ice-candidate") {
        const candidate = new RTCIceCandidate(JSON.parse(msg.data));
        if (pc.remoteDescription) {
          await pc.addIceCandidate(candidate);
        } else {
          pendingCandidates.push(candidate);
        }

      } else if (msg.type === "peer_disconnected") {
        alert("Other user hung up.");
        resetCallState();
      }
    } catch (err) {
      console.error("WebRTC error:", err, msg);
    }
  };
}

// Remove answerButton.onclick entirely

// ...keep hangupButton.onclick and resetCallState() the same

// ✅ Modify showIncomingCallPopup to completely automate the join
function showIncomingCallPopup(msg) {
  const modal = document.getElementById('incomingModal');
  const ringtone = document.getElementById('ringtone');
  const acceptBtn = document.getElementById('acceptCallBtn');
  const rejectBtn = document.getElementById('rejectCallBtn');

  modal.style.display = 'flex';
  ringtone.play();

  acceptBtn.onclick = async () => {
    ringtone.pause();
    ringtone.currentTime = 0;
    modal.style.display = 'none';

    const offer = JSON.parse(msg.data);
    if (!pc || pc.signalingState === 'closed') {
      pc = createPeerConnection();
    }

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.send(JSON.stringify({
      type: "answer",
      callId: msg.callId,
      data: JSON.stringify(pc.localDescription),
    }));

    for (const c of pendingCandidates) {
      await pc.addIceCandidate(c);
    }
    pendingCandidates = [];

    hangupButton.disabled = false;
  };

  rejectBtn.onclick = () => {
    ringtone.pause();
    ringtone.currentTime = 0;
    modal.style.display = 'none';
  };

  // Auto-accept after 10s (optional)
  setTimeout(() => {
    if (modal.style.display !== 'none') {
      acceptBtn.click();
    }
  }, 10000);
}

// Disable manual input fields
callInput.style.display = 'none';
answerButton.style.display = 'none';

// Initial UI state
callButton.disabled = true;
hangupButton.disabled = true;
