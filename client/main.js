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
let currentCallId = null; // To store the active call ID
let isCaller = false; // Flag to know if the current client initiated the call

// HTML elements
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput'); // Will display/take Call ID
const answerButton = document.getElementById('answerButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton'); // Assuming a hangup button exists

// 1. Setup media sources
webcamButton.onclick = async () => {
  try {
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
  } catch (e) {
    console.error("Error accessing media devices.", e);
    alert("Error accessing media devices: " + e.message);
  }
};

function connectSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.log("WebSocket already connected.");
    // If reconnecting for a new call as answerer, send join immediately
    if (!isCaller && currentCallId) {
        socket.send(JSON.stringify({
            type: "join_call",
            callId: currentCallId,
        }));
    }
    return; // Don't reconnect if already open unless logic requires it
  }

  if (socket && socket.readyState === WebSocket.CONNECTING) {
    console.log("WebSocket is currently connecting.");
    return;
  }

  socket = new WebSocket("ws://localhost:8000/ws"); // Replace with your WebSocket server URL

  socket.onopen = async () => {
    console.log("Connected to signaling server");

    if (isCaller && currentCallId) {
      // If this client is the caller, create and send offer
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        console.log("Sending offer for callId:", currentCallId);
        socket.send(JSON.stringify({
          type: "offer",
          callId: currentCallId,
          data: JSON.stringify(pc.localDescription), // Send the whole description
        }));
      } catch (e) {
        console.error("Error creating or sending offer:", e);
      }
    } else if (!isCaller && currentCallId) {
      // If this client is the answerer, send a join message
      console.log("Sending join_call for callId:", currentCallId);
      socket.send(JSON.stringify({
        type: "join_call",
        callId: currentCallId,
      }));
    }
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
        msg = JSON.parse(event.data);
    } catch (e) {
        console.error("Received non-JSON message:", event.data);
        return;
    }


    console.log("Received message:", msg);

    // Ensure messages are routed based on callId if server sends it back
    // For now, we assume messages are for the currentCallId context
    if (msg.callId && msg.callId !== currentCallId) {
        console.warn(`Received message for different callId: ${msg.callId}. Current: ${currentCallId}. Ignoring.`);
        return;
    }

    try {
      if (msg.type === "offer" && !isCaller) { // Answerer receives offer
        if (!currentCallId && msg.callId) { // If answerer joined and server sends offer with callId
            currentCallId = msg.callId;
            callInput.value = currentCallId; // Update input if not already set
        }
        const offer = JSON.parse(msg.data);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log("Sending answer for callId:", currentCallId);
        socket.send(JSON.stringify({
          type: "answer",
          callId: currentCallId,
          data: JSON.stringify(pc.localDescription), // Send the whole description
        }));
        hangupButton.disabled = false;

      } else if (msg.type === "answer" && isCaller) { // Caller receives answer
        const answer = JSON.parse(msg.data);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log("Remote description set with answer.");
        hangupButton.disabled = false;

      } else if (msg.type === "ice-candidate") {
        const candidate = JSON.parse(msg.data);
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log("Added ICE candidate.");

      } else if (msg.type === "error") {
        console.error("Signaling error:", msg.message);
        alert("Signaling error: " + msg.message);
        // Potentially reset UI or state here
      } else if (msg.type === "call_joined" && !isCaller) {
        console.log("Successfully joined call. Waiting for offer.");
        // Server acknowledged join, now expect an offer.
      } else if (msg.type === "peer_disconnected") {
        console.log("Peer has disconnected.");
        alert("The other user has disconnected.");
        resetCallState(); // Implement a function to reset UI and WebRTC state
      }

    } catch (err) {
      console.error("Error processing message or WebRTC operation:", err, "Original message:", msg);
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && socket && socket.readyState === WebSocket.OPEN && currentCallId) {
      console.log("Sending ICE candidate for callId:", currentCallId);
      socket.send(JSON.stringify({
        type: "ice-candidate",
        callId: currentCallId,
        data: JSON.stringify(event.candidate),
      }));
    }
  };

  socket.onclose = () => {
    console.log("Disconnected from signaling server");
    // Optionally disable call/answer buttons or try to reconnect
  };

  socket.onerror = (error) => {
    console.error("WebSocket Error:", error);
    alert("Could not connect to the signaling server. Please ensure it's running and accessible.");
  };
}

// 2. Create an offer (Caller)
callButton.onclick = async () => {
  isCaller = true;
  // Generate a unique call ID (simple version)
  currentCallId = "call_" + Math.random().toString(36).substr(2, 9);
  callInput.value = currentCallId; // Display Call ID so it can be shared
  callInput.readOnly = true; // Prevent editing by caller

  console.log("Initiating call with ID:", currentCallId);
  connectSocket(); // Connection will handle sending the offer in onopen

  hangupButton.disabled = false;
  callButton.disabled = true;
  answerButton.disabled = true;
};

// 3. Answer the call (Answerer)
answerButton.onclick = async () => {
  isCaller = false;
  currentCallId = callInput.value.trim();
  callInput.readOnly = true;

  if (!currentCallId) {
    alert("Please enter a Call ID to answer.");
    callInput.readOnly = false;
    return;
  }
  console.log("Attempting to answer call with ID:", currentCallId);
  connectSocket(); // Connection will send a 'join_call' message in onopen

  hangupButton.disabled = false;
  callButton.disabled = true;
  answerButton.disabled = true;
};

// 4. Hangup
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
    console.log("Resetting call state.");
    if (pc) {
        pc.ontrack = null;
        pc.onicecandidate = null;
        // pc.onnegotiationneeded = null; // if you were using it
        // pc.oniceconnectionstatechange = null; // if you were using it

        // Close existing tracks
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        webcamVideo.srcObject = null;
        remoteVideo.srcObject = null;

        // Close the peer connection
        pc.close();
    }

    // Re-create the RTCPeerConnection for a new call
    // pc = new RTCPeerConnection(servers); // This line is problematic if you immediately call setup media sources again.
                                        // Better to re-initialize pc in webcamButton.onclick or before a new call/answer.
                                        // For a simple reset, just closing is fine. A new pc will be made implicitly if the flow restarts.
                                        // However, to be explicit and clean for future calls without page reload:
    // pc = new RTCPeerConnection(servers); // Re-initialize for next call
    // setupMediaSources(); // If you extract that part

    if (socket) {
        socket.close();
        socket = null;
    }

    currentCallId = null;
    isCaller = false;
    callInput.value = "";
    callInput.readOnly = false;

    callButton.disabled = false; // Re-enable after media setup
    answerButton.disabled = false; // Re-enable after media setup
    hangupButton.disabled = true;
    webcamButton.disabled = false; // Allow re-selecting webcam

    
}

// Initial state
callButton.disabled = true;
answerButton.disabled = true;
hangupButton.disabled = true;