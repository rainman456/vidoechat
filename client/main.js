const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

const pc = new RTCPeerConnection(servers);
let localStream = null;
let remoteStream = null;
let socket = null;

// HTML elements
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const answerButton = document.getElementById('answerButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');

webcamButton.onclick = async () => {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  remoteStream = new MediaStream();

  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
  };

  webcamVideo.srcObject = localStream;
  remoteVideo.srcObject = remoteStream;

  callButton.disabled = false;
  answerButton.disabled = false;
  webcamButton.disabled = true;
};

function connectSocket() {
  socket = new WebSocket("ws://localhost:8000/ws");

  socket.onopen = () => {
    console.log("Connected to signaling server");
  };

  socket.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "offer") {
      const offer = JSON.parse(msg.data);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.send(JSON.stringify({
        type: "answer",
        data: JSON.stringify(pc.localDescription),
      }));
    }

    if (msg.type === "answer") {
      const answer = JSON.parse(msg.data);
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }

    if (msg.type === "ice-candidate") {
      const candidate = JSON.parse(msg.data);
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error("Error adding ICE candidate", err);
      }
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.send(JSON.stringify({
        type: "ice-candidate",
        data: JSON.stringify(event.candidate),
      }));
    }
  };
}

callButton.onclick = async () => {
  connectSocket();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.send(JSON.stringify({
    type: "offer",
    data: JSON.stringify(offer),
  }));

  hangupButton.disabled = false;
};

answerButton.onclick = async () => {
  connectSocket();
  hangupButton.disabled = false;
};
