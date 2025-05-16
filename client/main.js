const servers = {
    iceServers: [
        {
            urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
        },
        // Add TURN server configuration here for production/robust demos
        // You will need to obtain TURN server credentials
        // {
        //     urls: 'turn:your.turn.server.com:3478',
        //     username: 'your_username',
        //     credential: 'your_password',
        // }
    ],
    iceCandidatePoolSize: 10, // Gather multiple candidates simultaneously
};

let pc = null; // RTCPeerConnection instance
let localStream = null; // Local media stream (camera/mic)
let remoteStream = null; // Remote media stream from the peer
let socket = null; // WebSocket connection to the signaling server
let currentCallId = null; // ID of the call this client is currently involved in
let isCaller = false; // Is this client the one who initiated the current call attempt?
let pendingCandidates = []; // Stores ICE candidates that arrive before setRemoteDescription
let websocketKeepaliveInterval = null; // Variable to hold the keepalive interval timer

// HTML Elements - Ensure these IDs match your HTML
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');

// Modal Elements - Ensure these IDs match your HTML
const incomingCallModal = document.getElementById('incomingCallModal');
const callerInfoText = document.getElementById('callerInfoText');
const acceptCallButton = document.getElementById('acceptCallButton');
const rejectCallButton = document.getElementById('rejectCallButton');
const ringtoneAudio = document.getElementById('ringtoneAudio');
const statusText = document.getElementById('statusText'); // Added status display

// --- UI State Management ---
function updateUIState(state) {
    console.log("Updating UI state to:", state);
    // Reset all buttons first
    webcamButton.disabled = true;
    callButton.disabled = true;
    hangupButton.disabled = true;
    hideIncomingCallPopup(); // Always hide modal when state changes significantly

    switch (state) {
        case 'initial':
            webcamButton.disabled = false; // Allow starting webcam
            statusText.textContent = "Click 'Start Webcam'";
            break;
        case 'webcam_started':
            callButton.disabled = false; // Allow initiating call
            statusText.textContent = "Webcam started. Click 'Start Auto-Match Call'";
            break;
        case 'calling':
            hangupButton.disabled = false; // Allow hanging up the call attempt
            statusText.textContent = "Searching for a peer...";
            break;
        case 'ringing':
            // Handled by showIncomingCallPopup, which sets hangupButton.disabled = false
            statusText.textContent = "Incoming call...";
            break;
        case 'in_call':
            hangupButton.disabled = false; // Allow hanging up the active call
            statusText.textContent = "In call";
            break;
        case 'disconnected':
            // This state is temporary, usually followed by 'initial' or 'webcam_started'
            statusText.textContent = "Call ended.";
            // The resetCallState function will handle the final UI state update
            break;
        case 'error':
             // Status text set by the error handler
             hangupButton.disabled = false; // Allow hanging up error state if needed
             break;
        default:
            statusText.textContent = "";
            break;
    }
}


/**
 * Creates and configures a new RTCPeerConnection.
 */
function createPeerConnection() {
    // Clean up any existing peer connection before creating a new one
    if (pc && pc.signalingState !== 'closed') {
        console.warn("PeerConnection already exists and is not closed. Closing previous one.");
        pc.close();
    }

    console.log("Creating new RTCPeerConnection with config:", servers);
    const peer = new RTCPeerConnection(servers);

    // Event handler for when a remote track is added
    peer.ontrack = (event) => {
        console.log("Remote track received:", event.track, event.streams);
        if (!remoteStream) {
            // Create a new MediaStream to hold remote tracks
            remoteStream = new MediaStream();
            remoteVideo.srcObject = remoteStream; // Assign the stream to the remote video element
        }
        // Add the received track to the remote stream
        // event.streams[0] is the MediaStream the track belongs to on the remote side
        // It's safer to add tracks individually as streams might be structured differently
        event.streams[0].getTracks().forEach((track) => {
             // Check if the track is already added to prevent duplicates
            if (!remoteStream.getTrackById(track.id)) {
                 remoteStream.addTrack(track);
                 console.log("Added remote track:", track);
            } else {
                 console.log("Remote track already exists:", track);
            }
        });
         // Ensure the remote video is playing if tracks are added
         if (remoteVideo.paused) {
             remoteVideo.play().catch(e => console.error("Remote video play failed:", e));
         }
    };

    // Event handler for ICE candidate generation
    peer.onicecandidate = (event) => {
        // When a new ICE candidate is generated by the browser
        if (event.candidate && socket && socket.readyState === WebSocket.OPEN && currentCallId) {
            console.log("Sending ICE candidate:", event.candidate);
            // Send the candidate to the signaling server
            socket.send(JSON.stringify({
                type: "ice-candidate",
                callId: currentCallId,
                data: JSON.stringify(event.candidate), // Send candidate data as string
            }));
        } else if (!event.candidate) {
            // Candidate gathering is complete
            console.log("ICE candidate gathering complete.");
        } else {
             console.warn("Cannot send ICE candidate: socket not open or no call ID.", {socketReadyState: socket?.readyState, currentCallId: currentCallId});
        }
    };

    // Event handler for signaling state changes (optional but helpful for debugging)
    peer.onsignalingstatechange = () => {
        console.log('Signaling state changed:', peer.signalingState);
    };

    // Event handler for ICE connection state changes
    peer.oniceconnectionstatechange = () => {
        console.log('ICE connection state changed:', peer.iceConnectionState);
        // You can update UI based on this, e.g., 'connected', 'disconnected', 'failed'
        if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'failed') {
             console.warn("ICE connection failed or disconnected.");
             // Consider triggering hangup or showing a warning
             // If peer.iceConnectionState === 'failed', the connection couldn't be established
             // If peer.iceConnectionState === 'disconnected', it was established but lost
             if (currentCallId) { // Only reset if we were actually in a call attempt
                alert("Connection failed or disconnected. Ending call.");
                resetCallState(); // Reset state if connection is lost
             }
        }
         if (peer.iceConnectionState === 'connected') {
             console.log("ICE connection successful!");
             // UI state should already be 'in_call' by now, but good to confirm
             if (statusText.textContent !== "In call") {
                  updateUIState('in_call');
             }
         }
    };


    // Add local tracks if localStream is already available
    if (localStream) {
        localStream.getTracks().forEach(track => {
            console.log("Adding local track to new PC:", track);
            // addTrack returns an RTCRtpSender
            peer.addTrack(track, localStream);
        });
    } else {
        console.warn("Local stream not available when creating peer connection. Tracks must be added later.");
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
            // If webcam is already started, just update UI state
            updateUIState('webcam_started');
            return;
        }
        statusText.textContent = "Starting webcam...";
        // Request access to video and audio devices
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        webcamVideo.srcObject = localStream; // Display local video feed
        webcamVideo.muted = true; // Mute local video to prevent echo/feedback

        console.log("Webcam started successfully.");
        updateUIState('webcam_started'); // Update UI state

        // Ensure WebSocket is connected when webcam starts, in case user refreshes
        // and starts webcam before socket connects automatically.
        connectSocket();

    } catch (e) {
        console.error("Error accessing media devices.", e);
        statusText.textContent = "Error starting webcam.";
        alert("Error accessing media devices: " + e.message + "\nPlease ensure camera and microphone permissions are granted.");
        updateUIState('initial'); // Revert to initial state on error
    }
};

/**
 * Initiates an auto-match call attempt.
 */
callButton.onclick = async () => {
    if (!localStream) {
        alert("Please start your webcam first.");
        return;
    }

    // Reset any previous call state before starting a new one
    // This is important if a previous call attempt failed or was rejected
    resetCallState(); // Ensure a clean state

    isCaller = true; // This client is initiating this attempt
    // The server will generate the official call ID upon finding a match
    // We might use a temporary ID here if needed, but the server's ID is authoritative.
    // Let's rely on the server providing the CallID in the incoming_call/answer messages.
    currentCallId = null; // Clear currentCallId until server provides one

    updateUIState('calling'); // Update UI state to indicate searching

    connectSocket(); // Ensure WebSocket is connected

    // The actual offer creation and sending happens once the socket is open
    // and the client is in the 'calling' state.
    // The socket.onopen handler or connectSocket logic will trigger sendInitiateCall.
};


/**
 * Connects to the WebSocket signaling server.
 */
function connectSocket() {
    // Check if socket is already connecting or open
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket already connecting or connected.");
        // If we are in the 'calling' state and the socket is open, try sending initiate_call again
        // This handles the case where 'callButton.onclick' is clicked before socket is open
        if (socket.readyState === WebSocket.OPEN && isCaller && !currentCallId) {
             sendInitiateCall();
        }
        return;
    }

    statusText.textContent = "Connecting to signaling server...";
    // Determine WebSocket URL based on current page protocol and host
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${location.host}/ws`;
    console.log("Attempting to connect to WebSocket:", wsUrl);

    socket = new WebSocket(wsUrl);

    socket.onopen = async () => {
        console.log("Connected to signaling server via WebSocket.");
        statusText.textContent = "Connected to server.";
        // Start keepalive pings to prevent connection timeouts
        startKeepalive();

        // If this client is initiating a call and was waiting for the socket to open
        if (isCaller && !currentCallId) {
            sendInitiateCall();
        } else if (localStream) {
             // If webcam is started but not calling, update UI state to webcam_started
             // This handles cases where socket connects after webcam starts or after hangup
             updateUIState('webcam_started');
        } else {
             // If socket connects before webcam starts
             updateUIState('initial');
        }
    };

    socket.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
            console.log("Received message:", msg);
        } catch (e) {
            console.error("Received non-JSON message or invalid JSON:", event.data);
            return; // Ignore invalid messages
        }

        // Ensure pc is initialized before handling messages that require it (offer, answer, candidate)
        // It's best to create PC when initiating or receiving a call.
        // The server logic now ensures we only get offer/answer/candidate messages
        // when we are in a relevant state (Calling, Ringing, InCall).

        switch (msg.type) {
            case "incoming_call": // Received by the potential callee
                // Server sends this when it finds a match and the client is Idle
                if (localStream && !currentCallId) { // Ensure webcam is on and not already in a call/attempt
                    console.log(`Incoming call (ID: ${msg.CallID}) from caller ID: ${msg.CallerID}`);
                    currentCallId = msg.CallID; // Set the call ID provided by the server
                    isCaller = false; // Confirm this client is the callee
                    updateUIState('ringing'); // Update UI state
                    showIncomingCallPopup(msg.Data, msg.CallerID); // msg.Data contains the offer SDP
                } else {
                    console.warn("Received incoming_call but webcam not started or already busy. Ignoring.");
                    // Automatically reject the call if webcam is not ready or busy
                    if (socket && socket.readyState === WebSocket.OPEN && msg.CallID) {
                         socket.send(JSON.stringify({ type: "reject_call", callId: msg.CallID, reason: localStream ? "busy" : "webcam_off" }));
                    }
                }
                break;

            case "answer": // Received by the original caller
                // Server sends this after the callee accepts and sends their answer
                if (isCaller && currentCallId === msg.CallID && pc && pc.signalingState === "have-local-offer") {
                    console.log("Received answer for call ID:", msg.CallID);
                    try {
                        // Set the remote description with the received Answer SDP
                        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.Data)));
                        console.log("Remote description set with answer.");
                        updateUIState('in_call'); // Call is now established

                        // Process any pending ICE candidates that arrived before the answer
                        while (pendingCandidates.length > 0) {
                            const candidate = pendingCandidates.shift();
                            console.log("Processing pending ICE candidate (after answer):", candidate);
                            await pc.addIceCandidate(candidate);
                        }
                    } catch (e) {
                        console.error("Error setting remote description with answer:", e);
                        statusText.textContent = "Call failed during setup.";
                        alert("Call failed during setup. See console.");
                        resetCallState(); // Reset state on error
                    }
                } else {
                    console.warn("Received answer for irrelevant call ID or in wrong state. Ignoring.", {
                         isCaller: isCaller,
                         currentCallId: currentCallId,
                         msgCallId: msg.CallID,
                         pcSignalingState: pc?.signalingState
                    });
                }
                break;

            case "ice-candidate":
                // Received ICE candidate from the other peer
                if (currentCallId === msg.CallID && pc) {
                    try {
                        const candidate = new RTCIceCandidate(JSON.parse(msg.Data));
                        // Add the received candidate to the peer connection
                        if (pc.remoteDescription) {
                            console.log("Adding ICE candidate immediately:", candidate);
                            await pc.addIceCandidate(candidate);
                        } else {
                            // If remote description is not yet set (e.g., answer not received yet)
                            console.log("Remote description not set. Pushing ICE candidate to pending queue:", candidate);
                            pendingCandidates.push(candidate); // Queue candidates
                        }
                    } catch (e) {
                        console.error("Error adding received ICE candidate:", e);
                    }
                } else {
                    console.warn("Received ICE candidate for irrelevant call ID or pc not initialized. Ignoring.", {
                         currentCallId: currentCallId,
                         msgCallId: msg.CallID,
                         pcInitialized: !!pc
                    });
                }
                break;

            case "call_taken": // Received by other potential callees if someone else accepted the call
                // This message is less relevant with the current server's auto-match (it only
                // sends incoming_call to one idle peer), but included for completeness.
                if (currentCallId === msg.CallID && !isCaller) { // Ensure it's for the call this client was considering
                    console.log("Call was taken by another user. Hiding modal.");
                    hideIncomingCallPopup(); // Hide the ringing modal
                    // Do NOT reset currentCallId or state here, the callee would only
                    // receive this if they were in the Ringing state for this call.
                    // The server should handle resetting the state of the client who
                    // received but didn't accept the call.
                    // For this auto-match demo, this case is unlikely to be hit
                    // unless the server logic changes to notify multiple potential callees.
                }
                break;

            case "peer_disconnected": // Received when the other peer hangs up or disconnects
                if (currentCallId === msg.CallID) {
                    console.log(`Peer disconnected from call ${msg.CallID}. Reason: ${msg.Reason}`);
                    alert("The other user has disconnected or hung up.");
                    updateUIState('disconnected'); // Update UI state
                    resetCallState(); // Reset call state and UI
                } else {
                     console.warn("Received peer_disconnected for irrelevant call ID. Ignoring.", {
                         currentCallId: currentCallId,
                         msgCallId: msg.CallID
                     });
                }
                break;

            case "call_rejected": // Received by the caller when the callee rejects
                if (isCaller && currentCallId === msg.CallID) {
                    console.log(`Call ${msg.CallID} rejected by peer. Reason: ${msg.Reason}`);
                    alert("Your call was rejected.");
                    updateUIState('disconnected'); // Update UI state
                    resetCallState(); // Reset call state and UI
                } else {
                     console.warn("Received call_rejected for irrelevant call ID or not caller. Ignoring.", {
                         isCaller: isCaller,
                         currentCallId: currentCallId,
                         msgCallId: msg.CallID
                     });
                }
                break;

            case "call_attempt_ended": // Received by the other party if a call attempt ended before InCall state
                 if (currentCallId === msg.CallID) {
                     console.log(`Call attempt ${msg.CallID} ended. Reason: ${msg.Reason}`);
                     // This could happen if the other party disconnected while in Calling/Ringing state
                     alert("The call attempt ended.");
                     updateUIState('disconnected'); // Update UI state
                     resetCallState(); // Reset call state and UI
                 } else {
                     console.warn("Received call_attempt_ended for irrelevant call ID. Ignoring.", {
                         currentCallId: currentCallId,
                         msgCallId: msg.CallID
                     });
                 }
                 break;

            case "error": // Received from server indicating an error
                console.error("Error message from server:", msg.Data);
                statusText.textContent = "Server error.";
                alert(`Server error: ${msg.Data}`);
                // If the error is related to the current call attempt, reset state
                if (msg.CallID && msg.CallID === currentCallId) {
                     resetCallState();
                } else if (!currentCallId && msg.Data === "No idle users available.") {
                     // Specific handling for no users available after initiate_call
                     alert("No other users online right now. Please try again later.");
                     updateUIState('webcam_started'); // Go back to ready state
                } else {
                    // For general errors not tied to a call, just update status
                    updateUIState('error');
                }
                break;

            case "pong": // Received in response to keepalive ping
                 // console.log("Received pong from server.");
                 // No action needed, just confirms connection is alive
                 break;

            default:
                console.warn("Unknown message type received:", msg.Type);
        }
    };

    socket.onclose = (event) => {
        console.log("Disconnected from signaling server.", event.code, event.reason);
        statusText.textContent = "Disconnected from server. Attempting to reconnect...";
        stopKeepalive(); // Stop sending pings
        // Attempt to reconnect after a delay
        setTimeout(connectSocket, 3000); // Reconnect after 3 seconds
        // Do NOT reset call state here automatically, a disconnect doesn't mean the call ended,
        // it means signaling is down. The peer_disconnected message handles call ending.
        // However, if the socket stays closed, the call will eventually fail anyway.
        // A more robust app might try to re-establish signaling for an ongoing call.
        // For this demo, we rely on peer_disconnected or ICE failure to end the call.
    };

    socket.onerror = (error) => {
        console.error("WebSocket Error:", error);
        statusText.textContent = "WebSocket error. Attempting to reconnect...";
        stopKeepalive(); // Stop sending pings
        // Attempt to reconnect after a delay on error
        // The onclose handler will also likely fire after onerror,
        // so the reconnect logic might be duplicated, but it's safer.
        setTimeout(connectSocket, 5000); // Reconnect after 5 seconds on error
        alert("Could not connect to the signaling server. Ensure it's running and accessible.");
    };
}

// --- WebSocket Keepalive ---
function startKeepalive() {
    // Clear any existing interval first
    if (websocketKeepaliveInterval) {
        clearInterval(websocketKeepaliveInterval);
    }
    // Send ping every 25 seconds (less than common 30s server timeouts)
    websocketKeepaliveInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            // console.log("Sending ping...");
            socket.send(JSON.stringify({ type: "ping" }));
        } else {
            // If socket is not open, stop the interval
            stopKeepalive();
        }
    }, 25000);
}

function stopKeepalive() {
    if (websocketKeepaliveInterval) {
        // console.log("Stopping keepalive interval.");
        clearInterval(websocketKeepaliveInterval);
        websocketKeepaliveInterval = null;
    }
}


/**
 * Sends the initiate_call message with the offer.
 * Called when the socket is open and the client is ready to initiate.
 */
async function sendInitiateCall() {
    // Ensure we are in the 'calling' state and socket is open before sending
    if (!isCaller || currentCallId || !socket || socket.readyState !== WebSocket.OPEN || statusText.textContent !== "Searching for a peer...") {
        console.warn("Cannot send initiate_call: Not caller, call ID already exists, socket not open, or not in calling state.");
         // If socket is not open, connectSocket will handle retrying this from onopen
        return;
    }

    // Create a new PeerConnection instance for this call attempt
    pc = createPeerConnection();

    // Ensure local tracks are added to PC before creating offer
    // createPeerConnection already adds tracks if localStream exists,
    // but double check or ensure it happens before offer creation.
    if (localStream && pc.getSenders().length === 0) {
         console.log("Adding local tracks before creating offer.");
         localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    } else if (!localStream) {
         console.error("Cannot create offer: local stream not available.");
         statusText.textContent = "Error: Webcam not started.";
         alert("Cannot start call: Webcam not started.");
         resetCallState(); // Reset state as initiation failed
         return;
    }


    try {
        console.log("Creating offer...");
        // Create an SDP offer
        const offer = await pc.createOffer();
        // Set the local description with the created offer
        await pc.setLocalDescription(offer);

        console.log("Sending initiate_call with offer:", pc.localDescription);
        // Send the initiate_call message to the server
        socket.send(JSON.stringify({
            type: "initiate_call",
            // Server will generate the CallID upon finding a match, so we don't send one here
            // data contains the Offer SDP
            data: JSON.stringify(pc.localDescription),
        }));

        // The UI state is already 'calling' set by callButton.onclick
        // We now wait for an 'incoming_call' (if we are the callee, which won't happen here)
        // or an 'answer' (if the server found a callee and they accepted).

    } catch (e) {
        console.error("Error creating or sending offer for initiate_call:", e);
        statusText.textContent = "Error starting call.";
        alert("Error starting call. See console for details.");
        resetCallState(); // Reset state on error
    }
}


/**
 * Shows the incoming call popup.
 * @param {string} offerSDP - The SDP offer from the caller (passed from server).
 * @param {string} callerId - The ID of the caller (passed from server).
 */
function showIncomingCallPopup(offerSDP, callerId = "Someone") {
    if (!localStream) {
        console.warn("Cannot show incoming call: Webcam not started.");
        // This case should ideally be handled by the server not sending incoming_call
        // if the client reported status as busy or webcam_off (if implemented).
        // But as a fallback, reject the call if webcam isn't ready.
        if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
             socket.send(JSON.stringify({ type: "reject_call", callId: currentCallId, reason: "webcam_off" }));
        }
        resetCallState(); // Reset state as we can't accept
        return;
    }

    // Ensure we are in the 'ringing' state before showing the modal
    if (statusText.textContent !== "Incoming call...") {
         console.warn("Received incoming_call but not in 'ringing' state. Ignoring.");
         // This might happen if the server sends incoming_call but the client's state
         // is already in-call or calling another person.
         // Reject the call if the state is not 'ringing' for this call ID.
         if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
             socket.send(JSON.stringify({ type: "reject_call", callId: currentCallId, reason: "busy" }));
         }
         return;
    }


    // Display caller information (using the provided callerId, which is the UUID in this demo)
    callerInfoText.textContent = `Incoming call from ${callerId.substring(0, 8)}...`; // Show first few chars of ID
    incomingCallModal.style.display = 'flex'; // Show the modal

    // Attempt to play ringtone (might be blocked by browser autoplay policies - requires user interaction first)
    ringtoneAudio.play().catch(e => console.warn("Ringtone play failed, user interaction might be needed:", e));

    // --- Set up button handlers for the modal ---

    // Accept button handler
    acceptCallButton.onclick = async () => {
        hideIncomingCallPopup(); // Hide the modal and stop ringtone

        // Ensure pc is created for the callee role
        if (!pc || pc.signalingState === 'closed') {
            pc = createPeerConnection();
        }

        // Ensure local tracks are added to PC
        if (localStream && pc.getSenders().length === 0) {
            console.log("Adding local tracks before setting remote offer.");
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        } else if (!localStream) {
             console.error("Cannot accept call: local stream not available.");
             statusText.textContent = "Error: Webcam not started.";
             alert("Cannot accept call: Webcam not started.");
             resetCallState(); // Reset state as acceptance failed
             return;
        }


        try {
            console.log("Accepting call. Setting remote description with offer:", offerSDP);
            // Set the remote description with the received Offer SDP
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerSDP)));

            console.log("Creating answer...");
            // Create an SDP answer based on the offer and local capabilities
            const answer = await pc.createAnswer();
            // Set the local description with the created answer
            await pc.setLocalDescription(answer);

            console.log("Sending accept_call with answer:", pc.localDescription);
            // Send the accept_call message to the server
            socket.send(JSON.stringify({
                type: "accept_call",
                callId: currentCallId, // Use the CallID provided by the server
                data: JSON.stringify(pc.localDescription), // Send the Answer SDP
            }));

            // Process any pending ICE candidates that might have arrived for the offer
            while (pendingCandidates.length > 0) {
                const candidate = pendingCandidates.shift();
                console.log("Processing pending ICE candidate (after accepting call):", candidate);
                await pc.addIceCandidate(candidate);
            }

            updateUIState('in_call'); // Call is now established

        } catch (e) {
            console.error("Error during call acceptance:", e);
            statusText.textContent = "Error accepting call.";
            alert("Error accepting call: " + e.message + "\nSee console for details.");
            resetCallState(); // Reset state on error
        }
    };

    // Reject button handler
    rejectCallButton.onclick = () => {
        hideIncomingCallPopup(); // Hide the modal and stop ringtone
        console.log("Call rejected by user for call ID:", currentCallId);

        // Send reject_call message to the server
        if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
            socket.send(JSON.stringify({
                type: "reject_call",
                callId: currentCallId, // Use the CallID provided by the server
                reason: "user_rejected", // Optional reason
            }));
        }
        // The server will handle resetting the state of both parties
        // We will reset the local state upon receiving a confirmation from the server
        // or rely on the server resetting our state.
        // For simplicity in this demo, we can reset locally after sending reject.
        resetCallState(); // Reset local state immediately after rejecting
    };
}

/**
 * Hides the incoming call popup and stops the ringtone.
 */
function hideIncomingCallPopup() {
    incomingCallModal.style.display = 'none';
    ringtoneAudio.pause();
    ringtoneAudio.currentTime = 0; // Rewind ringtone
}

/**
 * Handles hanging up the call.
 */
hangupButton.onclick = async () => {
    console.log("Hangup button clicked for call ID:", currentCallId);
    // Send hangup message to the server
    if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
        socket.send(JSON.stringify({
            type: "hangup",
            callId: currentCallId, // Use the current CallID
        }));
    }
    // Reset local state immediately after sending hangup
    resetCallState();
    updateUIState('disconnected'); // Update UI state temporarily
};

/**
 * Resets the call state and UI elements.
 */
function resetCallState() {
    console.log("Resetting call state.");

    // Close the RTCPeerConnection if it exists
    if (pc) {
        pc.onicecandidate = null; // Remove listeners
        pc.ontrack = null;
        pc.onsignalingstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.close(); // Close the connection
        pc = null; // Nullify to allow re-creation for a new call
    }

    // Stop local media tracks (camera/mic) - keep the stream object but stop tracks
    // This allows the user to click "Start Auto-Match Call" again without restarting webcam
    if (localStream) {
        localStream.getTracks().forEach(track => {
             // Only stop if the track is currently active
             if (track.readyState === 'live') {
                 track.stop();
                 console.log("Stopped local track:", track.kind);
             }
         });
         // Don't nullify localStream if we want to reuse it for the next call
         // localStream = null; // <-- Keep the stream object
    }
    // Clear local video element
    webcamVideo.srcObject = localStream; // Assign the stream back (might show black if tracks stopped)


    // Stop and clear remote media tracks and stream
    if (remoteStream) {
        remoteStream.getTracks().forEach(track => {
             if (track.readyState === 'live') {
                 track.stop();
                 console.log("Stopped remote track:", track.kind);
             }
        });
        remoteStream = null; // Nullify the remote stream
    }
    // Clear remote video element
    remoteVideo.srcObject = null;


    // Reset state variables
    isCaller = false;
    currentCallId = null; // Clear the call ID
    pendingCandidates = []; // Clear pending candidates

    // Reset UI state based on whether webcam is still active
    if (localStream && localStream.getTracks().some(track => track.readyState === 'live')) {
         updateUIState('webcam_started'); // Webcam is still running, ready to call again
    } else {
         // If local stream tracks were stopped (e.g., during full page reset),
         // or if localStream was nullified, go back to initial state.
         // With the current logic, localStream is kept, but tracks are stopped.
         // We should re-acquire tracks or prompt user to restart webcam.
         // For this demo, let's assume stopping tracks is enough and the stream object persists.
         // If you want to fully reset webcam, nullify localStream and go to 'initial'.
         // Let's go back to webcam_started if localStream object exists, even if tracks stopped.
         if (localStream) {
              updateUIState('webcam_started');
         } else {
              updateUIState('initial');
         }
    }


    hideIncomingCallPopup(); // Ensure modal is hidden

    console.log("Call state reset complete.");
}

// --- Initial Setup ---

// Initial UI state setup
updateUIState('initial');

// Graceful disconnect on page unload
window.addEventListener('beforeunload', () => {
    console.log("Page unloading. Cleaning up.");
    // Send hangup if in an active call or attempt
    if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
        console.log("Sending hangup before unload for call ID:", currentCallId);
        socket.send(JSON.stringify({ type: "hangup", callId: currentCallId, reason: "page_unload" }));
    }
     // Close WebSocket connection
    if (socket && socket.readyState === WebSocket.OPEN) {
        console.log("Closing WebSocket before unload.");
        socket.close();
    }
    // Close RTCPeerConnection
    if (pc && pc.signalingState !== 'closed') {
        console.log("Closing RTCPeerConnection before unload.");
        pc.close();
    }
    // Stop local media tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
             if (track.readyState === 'live') track.stop();
        });
    }
     // Stop remote media tracks
    if (remoteStream) {
        remoteStream.getTracks().forEach(track => {
            if (track.readyState === 'live') track.stop();
        });
    }
});

// Connect to WebSocket when page loads
window.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded. Connecting socket.");
    connectSocket();
    // The keepalive interval is started in connectSocket.onopen
});

