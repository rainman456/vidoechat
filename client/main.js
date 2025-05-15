const servers = {
       iceServers: [
         {
           urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
        },
       ],
       iceCandidatePoolSize: 10,
     };

let pc = null; // RTCPeerConnection instance
let localStream = null;
let remoteStream = null;
let socket = null;
let currentCallId = null; // ID of the call this client is involved in or initiating
let isCaller = false; // Is this client the one who initiated the call?
let pendingCandidates = []; // Stores ICE candidates that arrive before setRemoteDescription

// HTML Elements
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');

// Modal Elements
const incomingCallModal = document.getElementById('incomingCallModal');
const callerInfoText = document.getElementById('callerInfoText');
const acceptCallButton = document.getElementById('acceptCallButton');
const rejectCallButton = document.getElementById('rejectCallButton');
const ringtoneAudio = document.getElementById('ringtoneAudio');

/**
 * Creates and configures a new RTCPeerConnection.
 */
function createPeerConnection() {
  if (pc && pc.signalingState !== 'closed') {
    console.warn("PeerConnection already exists and is not closed. Closing previous one.");
    pc.close();
  }
  
  const peer = new RTCPeerConnection(servers);

  // Event handler for when a remote track is added
  peer.ontrack = (event) => {
    console.log("Remote track received:", event.track, event.streams);
    if (!remoteStream) {
        remoteStream = new MediaStream();
        remoteVideo.srcObject = remoteStream;
    }
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
  };

  // Event handler for ICE candidate generation
  peer.onicecandidate = (event) => {
    if (event.candidate && socket && socket.readyState === WebSocket.OPEN && currentCallId) {
      console.log("Sending ICE candidate:", event.candidate);
      socket.send(JSON.stringify({
        type: "ice-candidate",
        callId: currentCallId,
        data: JSON.stringify(event.candidate),
      }));
    }
  };
  
  // Add local tracks if localStream is already available
  if (localStream) {
    localStream.getTracks().forEach(track => {
        console.log("Adding local track to new PC:", track);
        peer.addTrack(track, localStream);
    });
  } else {
    console.warn("Local stream not available when creating peer connection. Tracks will be added later.");
  }

  return peer;
}

/**
 * Initializes the webcam and local media stream.
 */
webcamButton.onclick = async () => {
  try {
    if (localStream) {
        console.log("Webcam already started.");
        return;
    }
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    webcamVideo.srcObject = localStream;
    webcamVideo.muted = true; // Mute local video to prevent echo

    // If pc exists and has tracks, remove them before adding new ones
    // Or, more robustly, create a new pc if tracks need to change.
    // For now, we assume pc will be created/re-created when a call starts.
    if (pc) {
        localStream.getTracks().forEach(track => {
            // Check if a sender for this track kind already exists
            const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
            if (sender) {
                sender.replaceTrack(track).catch(e => console.error("Error replacing track:", e));
            } else {
                pc.addTrack(track, localStream);
            }
        });
    }


    callButton.disabled = false;
    webcamButton.disabled = true;
    console.log("Webcam started successfully.");
  } catch (e) {
    console.error("Error accessing media devices.", e);
    alert("Error accessing media devices: " + e.message);
  }
};

/**
 * Initiates a call.
 */
callButton.onclick = async () => {
  if (!localStream) {
    alert("Please start your webcam first.");
    return;
  }
  isCaller = true;
  currentCallId = "call_" + Math.random().toString(36).substr(2, 9); // Generate unique call ID
  console.log(`Initiating call with ID: ${currentCallId}`);

  connectSocket(); // Ensure WebSocket is connected

  // The actual offer sending will happen in socket.onopen or immediately if already open
  // This requires connectSocket to handle the logic of sending "initiate_call" once open.

  hangupButton.disabled = false;
  callButton.disabled = true;
};


/**
 * Connects to the WebSocket signaling server.
 */
function connectSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.log("WebSocket already connected.");
    // If it's the caller and the call is being initiated now
    if (isCaller && currentCallId && pc && pc.signalingState === "stable") { // Check if pc is ready for offer
      sendInitiateCall();
    }
    return;
  }
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    console.log("WebSocket is currently connecting.");
    return;
  }

  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  socket.onopen = async () => {
    console.log("Connected to signaling server via WebSocket.");
    // If this client is initiating a call, create offer and send it
    if (isCaller && currentCallId) {
      sendInitiateCall();
    }
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
      console.log("Received message:", msg);
    } catch (e) {
      console.error("Received non-JSON message or invalid JSON:", event.data);
      return;
    }

    // pc should be initialized before handling messages that require it.
    if (!pc && (msg.type === "incoming_call" || msg.type === "answer" || msg.type === "ice-candidate")) {
        console.log("PC not initialized, creating one now for message type:", msg.type);
        pc = createPeerConnection(); // Crucial: ensure PC exists
    }


    switch (msg.type) {
      case "incoming_call": // Received by potential callees
        if (isCaller) return; // Caller should not process this for their own call
        console.log(`Incoming call (ID: ${msg.callId}) from ${msg.callerId || 'another user'}`);
        currentCallId = msg.callId; // Set context to this call
        showIncomingCallPopup(msg.data, msg.callerId); // msg.data contains the offer SDP
        break;

      case "answer": // Received by the original caller
        if (!isCaller) return;
        console.log("Received answer for call ID:", msg.callId);
        if (pc.signalingState !== "have-local-offer") {
             console.warn("Received answer but not in 'have-local-offer' state. State:", pc.signalingState);
        }
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
        console.log("Remote description set with answer.");
        // Process any pending ICE candidates
        while (pendingCandidates.length > 0) {
          const candidate = pendingCandidates.shift();
          console.log("Processing pending ICE candidate (after answer):", candidate);
          await pc.addIceCandidate(candidate);
        }
        break;

      case "ice-candidate":
        if (!msg.callId || msg.callId !== currentCallId) {
            console.warn("Received ICE candidate for irrelevant call ID. Ignoring.");
            return;
        }
        try {
          const candidate = new RTCIceCandidate(JSON.parse(msg.data));
          if (pc.remoteDescription) {
            console.log("Adding ICE candidate immediately:", candidate);
            await pc.addIceCandidate(candidate);
          } else {
            console.log("Remote description not set. Pushing ICE candidate to pending queue:", candidate);
            pendingCandidates.push(candidate);
          }
        } catch (e) {
          console.error("Error adding received ICE candidate:", e);
        }
        break;
      
      case "call_taken": // Received by other potential callees if someone else answered
        if (msg.callId === currentCallId && !isCaller) { // Ensure it's for the call this client was considering
          console.log("Call was taken by another user. Hiding modal.");
          hideIncomingCallPopup();
          currentCallId = null; // Reset call context
        }
        break;

      case "peer_disconnected":
        if (msg.callId === currentCallId) {
          alert("The other user has disconnected or hung up.");
          resetCallState();
        }
        break;
      
      case "error":
        console.error("Error message from server:", msg.message);
        alert(`Server error: ${msg.message}`);
        if (msg.callId === currentCallId) resetCallState(); // Reset if error is related to current call
        break;

      default:
        console.warn("Unknown message type received:", msg.type);
    }
  };

  socket.onclose = () => {
    console.log("Disconnected from signaling server.");
    // alert("Disconnected from signaling server. Please refresh to reconnect.");
    // Optionally, try to reconnect or update UI
    // resetCallState(); // Or a more specific UI reset for disconnection
  };

  socket.onerror = (error) => {
    console.error("WebSocket Error:", error);
    alert("Could not connect to the signaling server. Ensure it's running and accessible.");
  };
}

/**
 * Sends the initiate_call message with the offer.
 */
async function sendInitiateCall() {
    if (!isCaller || !currentCallId || !socket || socket.readyState !== WebSocket.OPEN) {
        console.warn("Cannot send initiate_call: Not caller, no call ID, or socket not open.");
        if (socket && socket.readyState !== WebSocket.OPEN) {
            // Queue this action for when socket opens? Or rely on user to retry?
            // For now, let's assume connectSocket handles this by calling it from onopen.
        }
        return;
    }

    if (!pc || pc.signalingState === 'closed') {
      pc = createPeerConnection();
    }
    
    // Ensure local tracks are added to PC before creating offer
    if (localStream && pc.getSenders().length === 0) {
        localStream.getTracks().forEach(track => {
            console.log("Adding local track to PC before offer:", track);
            pc.addTrack(track, localStream);
        });
    }


    try {
        console.log("Creating offer for call ID:", currentCallId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        console.log("Sending initiate_call with offer:", pc.localDescription);
        socket.send(JSON.stringify({
            type: "initiate_call",
            callId: currentCallId,
            data: JSON.stringify(pc.localDescription), // Send the offer SDP
        }));
    } catch (e) {
        console.error("Error creating or sending offer for initiate_call:", e);
        alert("Error starting call. See console for details.");
        resetCallState();
    }
}


/**
 * Shows the incoming call popup.
 * @param {string} offerSDP - The SDP offer from the caller.
 * @param {string} callerId - Optional ID of the caller.
 */
function showIncomingCallPopup(offerSDP, callerId = "Someone") {
  if (!localStream) {
    alert("Cannot receive call: Webcam not started. Please start your webcam.");
    // Optionally, send a "reject_call" or "busy" signal here if desired.
    // For now, we just prevent the modal.
    socket.send(JSON.stringify({ type: "reject_call", callId: currentCallId, reason: "webcam_off" }));
    return;
  }

  callerInfoText.textContent = `${callerId} is calling...`;
  incomingCallModal.style.display = 'flex';
  
  // Attempt to play ringtone (might be blocked by browser autoplay policies)
  ringtoneAudio.play().catch(e => console.warn("Ringtone play failed, user interaction might be needed:", e));

  acceptCallButton.onclick = async () => {
    hideIncomingCallPopup();
    isCaller = false; // This client is now a callee who accepted.

    if (!pc || pc.signalingState === 'closed') {
      pc = createPeerConnection();
    }
    
    // Ensure local tracks are added to PC
    if (localStream && pc.getSenders().length === 0) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    try {
      console.log("Accepting call. Setting remote description with offer:", offerSDP);
      await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerSDP)));
      
      console.log("Creating answer...");
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      console.log("Sending accept_call with answer:", pc.localDescription);
      socket.send(JSON.stringify({
        type: "accept_call",
        callId: currentCallId,
        data: JSON.stringify(pc.localDescription), // Send the answer SDP
      }));

      // Process any pending ICE candidates that might have arrived for the offer
      while (pendingCandidates.length > 0) {
        const candidate = pendingCandidates.shift();
        console.log("Processing pending ICE candidate (after accepting call):", candidate);
        await pc.addIceCandidate(candidate);
      }
      hangupButton.disabled = false;

    } catch (e) {
      console.error("Error during call acceptance:", e);
      alert("Error accepting call: " + e.message);
      resetCallState();
    }
  };

  rejectCallButton.onclick = () => {
    hideIncomingCallPopup();
    console.log("Call rejected by user.");
    if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
      socket.send(JSON.stringify({
        type: "reject_call",
        callId: currentCallId,
      }));
    }
    currentCallId = null; // Reset call context
    // No need to reset full call state unless they were already in a call.
  };
}

/**
 * Hides the incoming call popup and stops the ringtone.
 */
function hideIncomingCallPopup() {
  incomingCallModal.style.display = 'none';
  ringtoneAudio.pause();
  ringtoneAudio.currentTime = 0;
}

/**
 * Handles hanging up the call.
 */
hangupButton.onclick = async () => {
  if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
    console.log("Sending hangup for call ID:", currentCallId);
    socket.send(JSON.stringify({
      type: "hangup",
      callId: currentCallId,
    }));
  }
  resetCallState();
};

/**
 * Resets the call state and UI elements.
 */
function resetCallState() {
  console.log("Resetting call state.");
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.close();
    pc = null; // Important to nullify to allow re-creation
  }

  // Stop local media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  // Clear video elements
  webcamVideo.srcObject = null;
  remoteVideo.srcObject = null;
  
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
  }


  isCaller = false;
  currentCallId = null;
  pendingCandidates = [];

  // Reset UI
  callButton.disabled = true; // Disabled until webcam is started again
  hangupButton.disabled = true;
  webcamButton.disabled = false; // Allow webcam to be started again

  hideIncomingCallPopup(); // Ensure modal is hidden

  // Don't close the socket here, allow it to persist for future calls
  // If socket needs to be closed, do it explicitly or on page unload.
  // if (socket) {
  //   socket.close();
  //   socket = null;
  // }
  console.log("Call state reset.");
}

// Initial UI state
callButton.disabled = true;
hangupButton.disabled = true;
webcamButton.disabled = false;

// Graceful disconnect on page unload
window.addEventListener('beforeunload', () => {
    if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
        // Send hangup if in an active call
        socket.send(JSON.stringify({ type: "hangup", callId: currentCallId }));
    }
    if (socket) {
        socket.close();
    }
    if (pc) {
        pc.close();
    }
});

