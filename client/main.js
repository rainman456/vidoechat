// Global constants for STUN servers
const servers = {
    iceServers: [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
    ],
    iceCandidatePoolSize: 10 // Optional: influences how many ICE candidates are gathered upfront
};

// DOM Elements - ensure these IDs exist in your HTML
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton'); // For generic calls (if supported by backend)
const answerButton = document.getElementById('answerButton');
const hangupButton = document.getElementById('hangupButton');
const incomingModal = document.getElementById('incomingModal');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');
const ringtone = document.getElementById('ringtone'); // HTMLAudioElement
const remoteVideo = document.getElementById('remoteVideo');
const callerIdDisplay = document.getElementById('callerIdDisplay');
const statusText = document.getElementById('statusText');
const connectionStatus = document.getElementById('connectionStatus'); // For WebSocket/P2P status
const peerListElement = document.getElementById('peerList');

// State variables
let pc = null; // RTCPeerConnection instance
let localStream = null; // User's local media stream
let remoteStream = null; // Peer's remote media stream
let socket = null; // WebSocket connection
let currentCallId = null; // ID of the active or incoming/outgoing call
let isCaller = false; // True if this client initiated the current call
let pendingCandidates = []; // Stores ICE candidates that arrive before remote description is set
let keepaliveInterval = null; // Interval ID for WebSocket keepalive (ping/pong)
let peerList = []; // List of available peers from the server
let dataChannel = null; // RTCDataChannel for text chat or other data
let modalEscapeHandler = null; // Stores the event handler for dismissing modal with Escape key

/**
 * Initializes the UI to its default state.
 */
function initializeUI() {
    updateUIState('init');
    updateConnectionStatus('disconnected', 'WebSocket'); // Initial WebSocket status
    updatePeerListUI(); // Render the peer list (likely empty initially)
}

/**
 * Displays a message to the user.
 * Replace with a more sophisticated UI notification system in a real application.
 * @param {string} message - The message to display.
 * @param {'info' | 'warning' | 'error'} type - The type of message.
 */
function showUserMessage(message, type = 'info') {
    console.log(`UserMessage (${type}): ${message}`);
    statusText.textContent = message;
    // Example: Add a class for styling, e.g., statusText.className = `message-${type}`;
}

/**
 * Updates the display of connection status (WebSocket or PeerConnection).
 * @param {string} status - The current status (e.g., 'connected', 'connecting', 'disconnected', 'failed').
 * @param {'WebSocket' | 'PeerConnection'} context - Specifies if it's WebSocket or P2P status.
 */
function updateConnectionStatus(status, context = 'PeerConnection') {
    let statusString = status.charAt(0).toUpperCase() + status.slice(1);
    let baseClass = `status-${status.toLowerCase().replace(/\s+/g, '-')}`; // e.g. status-connected

    // Clear previous status classes from connectionStatus element
    const classesToRemove = [];
    for (let i = 0; i < connectionStatus.classList.length; i++) {
        if (connectionStatus.classList[i].startsWith('status-')) {
            classesToRemove.push(connectionStatus.classList[i]);
        }
    }
    connectionStatus.classList.remove(...classesToRemove);

    connectionStatus.classList.add(baseClass);
    connectionStatus.textContent = `${context}: ${statusString}`;

    if (context === 'PeerConnection' && pc) {
        connectionStatus.textContent += ` (P2P: ${pc.iceConnectionState} | Signaling: ${pc.signalingState})`;
    }
}


/**
 * Updates the list of available peers in the UI.
 */
function updatePeerListUI() {
    peerListElement.innerHTML = '<h3>Available Peers</h3>'; // Clear previous list and add header

    if (peerList.length === 0) {
        const noPeersMessage = document.createElement('p');
        noPeersMessage.textContent = 'No other peers available';
        peerListElement.appendChild(noPeersMessage);
        return;
    }

    peerList.forEach(peer => {
        const peerItem = document.createElement('div');
        peerItem.className = 'peer-item p-2 mb-2 border border-gray-300 rounded-md flex justify-between items-center';

        const peerInfo = document.createElement('div');
        const statusIndicator = document.createElement('span');
        statusIndicator.className = `status-indicator inline-block w-3 h-3 rounded-full mr-2 ${peer.status === 'idle' ? 'bg-green-500' : 'bg-red-500'}`;
        peerInfo.appendChild(statusIndicator);
        peerInfo.appendChild(document.createTextNode(`${peer.id} (${peer.status})`));

        const peerCallButton = document.createElement('button');
        peerCallButton.textContent = "Call";
        peerCallButton.className = "ml-4 px-3 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:bg-gray-400";
        // Disable call button if:
        // 1. Peer is not idle (e.g., busy)
        // 2. Local webcam stream is not available
        // 3. This client is already in a call or attempting one
        peerCallButton.disabled = peer.status !== 'idle' || !localStream || currentCallId !== null;
        peerCallButton.onclick = () => initiateCallWithPeer(peer.id);

        peerItem.appendChild(peerInfo);
        peerItem.appendChild(peerCallButton);
        peerListElement.appendChild(peerItem);
    });
}

/**
 * Updates the status of a specific peer or adds a new peer to the list.
 * @param {string} peerId - The ID of the peer.
 * @param {'idle' | 'in-call' | 'offline'} status - The new status of the peer.
 */
function updatePeerStatus(peerId, status) {
    const peerIndex = peerList.findIndex(p => p.id === peerId);
    if (peerIndex !== -1) {
        if (status === 'offline') { // Peer has disconnected
            peerList.splice(peerIndex, 1);
        } else {
            peerList[peerIndex].status = status;
        }
    } else if (status !== 'offline') { // New peer, not an offline notification for an unknown peer
        peerList.push({ id: peerId, status });
    }
    updatePeerListUI();
}

/**
 * Establishes or re-establishes the WebSocket connection to the signaling server.
 */
function connectSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        console.log("WebSocket already connected. Sending presence update.");
        sendPresenceUpdate();
        return;
    }

    updateConnectionStatus('connecting', 'WebSocket');
    // Construct WebSocket URL (ws:// or wss://)
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProtocol}://${window.location.host}/ws`; // Adjust '/ws' if your endpoint is different
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("WebSocket connected");
        updateConnectionStatus('connected', 'WebSocket');
        socket.send(JSON.stringify({ type: "register" })); // Register this client with the server
        startKeepalive();
        sendPresenceUpdate();

        // Fragile: Attempt to resend offer if WebSocket reconnected mid-call initiation.
        // A more robust solution involves server-side state or a full call reset.
        if (isCaller && currentCallId && pc && pc.localDescription && pc.signalingState === "have-local-offer") {
            console.warn("Reconnected to WebSocket during an active call attempt. Resending offer.");
            socket.send(JSON.stringify({
                type: "initiate_call",
                callId: currentCallId,
                // targetPeer should ideally be known here if the call was specific
                data: pc.localDescription // Send the RTCSessionDescription object directly
            }));
        }
    };

    socket.onmessage = async (event) => {
        try {
            const msg = JSON.parse(event.data);
            console.log("WebSocket message received:", msg);

            switch(msg.type) {
                case "peer_list":
                    peerList = msg.peers || [];
                    updatePeerListUI();
                    break;
                case "presence_update":
                    if (msg.peerId && msg.status) {
                        updatePeerStatus(msg.peerId, msg.status);
                    }
                    break;
                case "incoming_call":
                    handleIncomingCall(msg);
                    break;
                case "answer": // Callee has sent their answer SDP
                    handleAnswer(msg);
                    break;
                case "ice-candidate":
                    handleICECandidate(msg);
                    break;
                case "call_rejected":
                    showUserMessage(`Call rejected: ${msg.reason || 'No reason given'}`, 'warning');
                    resetCallState();
                    break;
                case "hangup": // Peer explicitly hung up
                    showUserMessage("Call ended by peer.", 'info');
                    resetCallState();
                    break;
                case "pong": // Response to our ping
                    // console.log("Pong received from server.");
                    break;
                default:
                    console.warn("Unknown WebSocket message type:", msg.type);
            }
        } catch (e) {
            console.error("Error processing WebSocket message:", e);
        }
    };

    socket.onclose = (event) => {
        console.log("WebSocket disconnected.", event.reason);
        updateConnectionStatus(`disconnected (Code: ${event.code})`, 'WebSocket');
        stopKeepalive();
        // Implement a more sophisticated reconnection strategy (e.g., exponential backoff)
        setTimeout(connectSocket, 5000); // Attempt to reconnect after 5 seconds
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        updateConnectionStatus('error', 'WebSocket');
        // onclose will likely be called after an error, triggering reconnection logic.
    };
}

/**
 * Sends a presence update to the server (e.g., idle, in-call).
 */
function sendPresenceUpdate() {
    if (socket?.readyState === WebSocket.OPEN) {
        let status = "offline";
        if (localStream) status = "idle";
        if (currentCallId) status = "in-call";

        socket.send(JSON.stringify({
            type: "presence_update",
            status: status
        }));
    }
}

/**
 * Starts sending periodic ping messages to keep the WebSocket connection alive.
 */
function startKeepalive() {
    stopKeepalive(); // Clear any existing interval
    keepaliveInterval = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping" }));
        } else {
            // If socket is not open, stop trying to send pings and let onclose handle reconnection.
            stopKeepalive();
        }
    }, 25000); // Send ping every 25 seconds
}

/**
 * Stops the WebSocket keepalive mechanism.
 */
function stopKeepalive() {
    if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
    }
}

/**
 * Creates and configures a new RTCPeerConnection object.
 * @returns {Promise<RTCPeerConnection>} A promise that resolves with the created RTCPeerConnection.
 */
async function createPeerConnection() {
    if (pc) {
        console.log("Closing existing RTCPeerConnection.");
        pc.close();
    }

    pc = new RTCPeerConnection(servers);
    updateConnectionStatus('new', 'PeerConnection'); // Initial P2P status

    // Event handler for when local ICE candidates are gathered
    pc.onicecandidate = (event) => {
        if (event.candidate && socket?.readyState === WebSocket.OPEN && currentCallId) {
            console.log("Sending ICE candidate:", event.candidate);
            socket.send(JSON.stringify({
                type: "ice-candidate",
                callId: currentCallId,
                data: event.candidate // Send RTCIceCandidate object directly
            }));
        }
    };

    // Event handler for when remote media tracks are received
    pc.ontrack = (event) => {
        console.log("Remote track received:", event.track);
        if (!remoteStream) {
            remoteStream = new MediaStream();
            remoteVideo.srcObject = remoteStream;
        }
        remoteStream.addTrack(event.track, remoteStream);
    };

    // Event handler for changes in the ICE connection state
    pc.oniceconnectionstatechange = () => {
        if (!pc) return;
        console.log(`ICE connection state changed: ${pc.iceConnectionState}`);
        updateConnectionStatus(pc.iceConnectionState, 'PeerConnection');
        if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
            if (pc.iceConnectionState === 'failed') {
                showUserMessage("Peer connection failed. Please try again.", 'error');
            }
            // Consider more nuanced handling for 'disconnected' which might be temporary.
            // For now, if a call was active, reset.
            if (currentCallId && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed')) {
                 resetCallState();
            }
        }
    };
    
    // Event handler for changes in the signaling state
    pc.onsignalingstatechange = () => {
        if (!pc) return;
        console.log(`Signaling state changed: ${pc.signalingState}`);
        updateConnectionStatus(pc.signalingState, 'PeerConnection'); // Or a more specific UI element for this
    };


    // Event handler for when a data channel is created by the remote peer
    pc.ondatachannel = (event) => {
        console.log("Data channel received:", event.channel.label);
        dataChannel = event.channel;
        setupDataChannelEventHandlers(dataChannel);
    };

    // If this client is the caller, create a data channel
    if (isCaller) {
        dataChannel = pc.createDataChannel('chat', { negotiated: false }); // Let WebRTC handle negotiation
        console.log("Data channel 'chat' created by caller.");
        setupDataChannelEventHandlers(dataChannel);
    }

    // Add local media tracks to the peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    return pc;
}

/**
 * Sets up event handlers for an RTCDataChannel.
 * @param {RTCDataChannel} channel - The data channel to configure.
 */
function setupDataChannelEventHandlers(channel) {
    if (!channel) return;
    channel.onopen = () => {
        console.log(`Data channel '${channel.label}' opened.`);
        showUserMessage(`Chat channel with peer established.`, 'info');
        // Example: send a welcome message
        // if (channel.readyState === 'open') channel.send("Hello! Chat is connected.");
    };
    channel.onclose = () => {
        console.log(`Data channel '${channel.label}' closed.`);
        showUserMessage(`Chat channel with peer closed.`, 'info');
    };
    channel.onmessage = (event) => {
        console.log(`Data channel message received: ${event.data}`);
        // TODO: Display the received message in a chat UI
        showUserMessage(`Peer: ${event.data}`, 'info'); // Simple display for now
    };
    channel.onerror = (error) => {
        console.error("Data channel error:", error);
        showUserMessage(`Chat channel error: ${error.error.message}`, 'error');
    };
}

/**
 * Initiates a call to a specific peer.
 * @param {string} peerId - The ID of the peer to call.
 */
async function initiateCallWithPeer(peerId) {
    if (!localStream) {
        showUserMessage("Please start your webcam first to make a call.", 'warning');
        return;
    }
    if (currentCallId) {
        showUserMessage("You are already in a call or initiating one.", 'warning');
        return;
    }

    isCaller = true;
    currentCallId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    updateUIState('calling');
    sendPresenceUpdate(); // Update presence to 'in-call' attempt

    try {
        pc = await createPeerConnection(); // Creates PC, adds local tracks, sets up data channel if caller
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        console.log("Sending 'initiate_call' to peer:", peerId);
        socket.send(JSON.stringify({
            type: "initiate_call",
            callId: currentCallId,
            targetPeer: peerId,
            data: offer // Send RTCSessionDescription object directly
        }));
    } catch (e) {
        console.error("Call initiation failed:", e);
        showUserMessage(`Failed to initiate call to ${peerId}: ${e.message}`, 'error');
        resetCallState();
    }
}

/**
 * Initiates a generic call (e.g., to any available peer, server handles matching).
 * NOTE: This function's utility depends heavily on server-side implementation.
 * If the server doesn't support calls without a specific targetPeer, this won't work as intended.
 */
async function startCall() {
    if (!localStream) {
        showUserMessage("Please start your webcam first.", 'warning');
        return;
    }
    if (currentCallId) {
        showUserMessage("You are already in a call or initiating one.", 'warning');
        return;
    }

    isCaller = true;
    currentCallId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    updateUIState('calling');
    sendPresenceUpdate();

    try {
        pc = await createPeerConnection();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        console.log("Sending generic 'initiate_call' (server-dependent matching).");
        socket.send(JSON.stringify({
            type: "initiate_call",
            callId: currentCallId,
            // No targetPeer: server needs to handle this (e.g., matchmaking)
            data: offer // Send RTCSessionDescription object directly
        }));
    } catch (e) {
        console.error("Generic call initiation failed:", e);
        showUserMessage(`Failed to initiate generic call: ${e.message}`, 'error');
        resetCallState();
    }
}

/**
 * Answers an incoming call.
 */
async function answerCall() {
    if (!currentCallId || !pc) {
        console.error("Cannot answer call: No current call ID or RTCPeerConnection.");
        showUserMessage("Error: Cannot answer call, missing call details.", 'error');
        return;
    }
    if (!pc.remoteDescription) {
        console.error("Cannot answer call: Remote description (offer) not set.");
        showUserMessage("Error: Offer from caller not processed. Cannot answer.", 'error');
        resetCallState(); // Offer is critical, if missing, reset.
        return;
    }
    if (!localStream) {
        showUserMessage("Please enable your webcam to answer the call.", "warning");
        // Attempt to start webcam if not already started (user will be prompted for permission)
        try {
            await startWebcam(false); // Start webcam but don't connect socket again if already connected
            if (!localStream) { // Check if webcam was successfully started
                 showUserMessage("Webcam is required to answer the call. Please enable it and try again.", "error");
                 // Optionally, send a reject message if webcam is mandatory and fails to start
                 // socket.send(JSON.stringify({ type: "reject_call", callId: currentCallId, reason: "no_media_on_answer" }));
                 // resetCallState(); // Or just let the user try again
                 return;
            }
             // If PC exists and localStream was just started, add tracks
            if (pc && localStream) {
                localStream.getTracks().forEach(track => {
                    if (!pc.getSenders().find(s => s.track && s.track.kind === track.kind)) {
                        pc.addTrack(track, localStream);
                    }
                });
            }
        } catch (err) {
            showUserMessage("Could not start webcam to answer call. Please check permissions.", "error");
            return;
        }
    }


    hideIncomingCallModal(); // Hide the incoming call notification

    try {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log("Sending 'answer' for call ID:", currentCallId);
        socket.send(JSON.stringify({
            type: "answer",
            callId: currentCallId,
            data: answer // Send RTCSessionDescription object directly
        }));

        updateUIState('in_call');
        sendPresenceUpdate(); // Update presence to 'in-call'
    } catch (e) {
        console.error("Failed to create or send answer:", e);
        showUserMessage(`Failed to answer call: ${e.message}`, 'error');
        resetCallState();
    }
}

/**
 * Ends the current call.
 */
function hangup() {
    if (currentCallId && socket?.readyState === WebSocket.OPEN) {
        console.log("Sending 'hangup' for call ID:", currentCallId);
        socket.send(JSON.stringify({
            type: "hangup",
            callId: currentCallId
        }));
    }
    showUserMessage("Call ended.", 'info');
    resetCallState();
}

/**
 * Handles an incoming call notification from the server.
 * @param {object} msg - The WebSocket message containing call details.
 * Expected msg format: { type: "incoming_call", callId: "...", callerId: "...", data: RTCSessionDescriptionInit (offer) }
 */
async function handleIncomingCall(msg) {
    if (currentCallId) { // If already in a call or processing one
        console.log("Rejecting incoming call (busy):", msg.callId);
        socket.send(JSON.stringify({
            type: "reject_call",
            callId: msg.callId,
            reason: "busy"
        }));
        return;
    }

    if (!msg.data || !msg.callId) {
        console.error("Invalid incoming call message:", msg);
        // Optionally notify sender of error if possible, though usually just ignore malformed messages.
        return;
    }

    currentCallId = msg.callId;
    isCaller = false; // This client is the callee

    try {
        pc = await createPeerConnection(); // Create PC, data channel will be set up by ondatachannel
        await pc.setRemoteDescription(new RTCSessionDescription(msg.data)); // msg.data is the offer
        console.log("Remote description (offer) set for incoming call.");
        
        showIncomingCallModal(msg.callerId || "Unknown Caller"); // Show modal only after offer is processed

    } catch (e) {
        console.error("Failed to handle incoming call:", e);
        showUserMessage(`Error processing incoming call: ${e.message}`, 'error');
        socket.send(JSON.stringify({ type: "reject_call", callId: msg.callId, reason: "setup_error" }));
        resetCallState();
    }
}

/**
 * Displays the incoming call modal and plays a ringtone.
 * @param {string} callerId - The ID of the calling peer.
 */
function showIncomingCallModal(callerId) {
    callerIdDisplay.textContent = callerId;
    incomingModal.style.display = 'flex'; // Or 'block', depending on your CSS for the modal

    // Remove any existing escape key listener before adding a new one
    if (modalEscapeHandler) {
        document.removeEventListener('keydown', modalEscapeHandler);
    }
    // Define the handler for the Escape key to dismiss the modal
    modalEscapeHandler = (e) => {
        if (e.key === 'Escape' && incomingModal.style.display !== 'none') {
            hideIncomingCallModal(); // Also removes this listener
            if (currentCallId && socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: "reject_call",
                    callId: currentCallId,
                    reason: "dismissed_by_escape"
                }));
            }
            resetCallState(); // Clean up call state
        }
    };
    document.addEventListener('keydown', modalEscapeHandler);

    // Optional: Allow dismissing by clicking outside the modal content (if modal is a full overlay)
    incomingModal.onclick = (e) => {
        if (e.target === incomingModal) { // Check if the click is on the modal backdrop itself
            hideIncomingCallModal();
             if (currentCallId && socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: "reject_call",
                    callId: currentCallId,
                    reason: "dismissed_by_click_outside"
                }));
            }
            resetCallState();
        }
    };

    if (ringtone) {
        ringtone.loop = true;
        ringtone.play().catch(e => console.warn("Ringtone play failed (browser autoplay policy?):", e));
    }
    updateUIState('ringing');
}

/**
 * Hides the incoming call modal and stops the ringtone.
 */
function hideIncomingCallModal() {
    incomingModal.style.display = 'none';
    if (ringtone) {
        ringtone.pause();
        ringtone.currentTime = 0; // Reset ringtone to the beginning
    }
    // Remove the Escape key listener when the modal is hidden
    if (modalEscapeHandler) {
        document.removeEventListener('keydown', modalEscapeHandler);
        modalEscapeHandler = null;
    }
}

/**
 * Handles a received ICE candidate from the peer.
 * @param {object} msg - The WebSocket message containing the ICE candidate.
 * Expected msg format: { type: "ice-candidate", callId: "...", data: RTCIceCandidateInit }
 */
async function handleICECandidate(msg) {
    if (!pc || !currentCallId || msg.callId !== currentCallId || !msg.data) {
        console.log("Ignoring ICE candidate (invalid context or data):", msg);
        return;
    }

    try {
        const candidate = new RTCIceCandidate(msg.data); // msg.data is the RTCIceCandidate object
        if (pc.remoteDescription && pc.signalingState !== "closed") {
            await pc.addIceCandidate(candidate);
            console.log("ICE candidate added.");
        } else {
            // Queue candidate if remote description isn't set yet or PC is in an unstable state
            pendingCandidates.push(candidate);
            console.log("ICE candidate queued (remote description not yet set or PC unstable).");
        }
    } catch (e) {
        console.error("Error adding received ICE candidate:", e);
    }
}

/**
 * Processes any queued ICE candidates. This is typically called after setRemoteDescription.
 */
async function processPendingIceCandidates() {
    if (!pc || !pc.remoteDescription || pc.signalingState === "closed") {
        // Don't process if PC is not ready or already closed
        pendingCandidates = []; // Clear queue if PC is not in a state to process them
        return;
    }

    console.log(`Processing ${pendingCandidates.length} pending ICE candidates.`);
    while (pendingCandidates.length > 0) {
        const candidate = pendingCandidates.shift();
        try {
            await pc.addIceCandidate(candidate);
            console.log("Added pending ICE candidate successfully.");
        } catch (e) {
            console.error("Error adding pending ICE candidate:", e);
            // Optionally, re-queue or discard based on error type
        }
    }
}

/**
 * Handles the answer SDP received from the callee. (This function is for the CALLER)
 * @param {object} msg - The WebSocket message containing the answer.
 * Expected msg format: { type: "answer", callId: "...", data: RTCSessionDescriptionInit (answer) }
 */
async function handleAnswer(msg) {
    if (!isCaller || !pc || !currentCallId || msg.callId !== currentCallId || !msg.data) {
        console.log("Ignoring answer (invalid context or data):", msg);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.data)); // msg.data is the answer
        console.log("Remote description (answer) set.");

        await processPendingIceCandidates(); // Process any candidates that arrived before the answer

        updateUIState('in_call');
        sendPresenceUpdate(); // Update presence to 'in-call'
    } catch (e) {
        console.error("Error setting remote description from answer:", e);
        showUserMessage(`Failed to establish call after answer: ${e.message}`, 'error');
        resetCallState();
    }
}

/**
 * Updates the UI elements (buttons, status text) based on the current application state.
 * @param {'init' | 'webcam_ready' | 'calling' | 'ringing' | 'in_call'} state - The new UI state.
 */
function updateUIState(state) {
    // Default all relevant buttons to disabled, then enable based on state
    webcamButton.disabled = true;
    callButton.disabled = true;    // Global call button (for generic calls)
    answerButton.disabled = true;
    hangupButton.disabled = true;

    // Per-peer call buttons in the list are managed by updatePeerListUI()

    switch(state) {
        case 'init':
            statusText.textContent = "Please start your webcam to enable calling features.";
            webcamButton.disabled = false;
            break;
        case 'webcam_ready':
            statusText.textContent = "Webcam ready. Select a peer to call or use generic call button.";
            callButton.disabled = false; // Enable generic call button
            break;
        case 'calling':
            statusText.textContent = `Calling ${currentCallId ? '...' : '(initiating call)'}`;
            hangupButton.disabled = false; // Allow aborting the call attempt
            break;
        case 'ringing':
            statusText.textContent = "Incoming call..."; // Modal shows caller ID
            answerButton.disabled = false; // Enabled on the modal itself
            // Reject is handled by rejectCallBtn on the modal
            // Hangup button can also act as a reject from main UI if desired
            hangupButton.disabled = false;
            break;
        case 'in_call':
            statusText.textContent = `In call (ID: ${currentCallId || 'N/A'})`;
            hangupButton.disabled = false;
            break;
        default:
            statusText.textContent = "Ready"; // Generic ready state
    }

    // Update the peer list UI as button states within it might depend on currentCallId or localStream
    updatePeerListUI();

    // Send presence update unless it's a state managed by modal actions (like ringing)
    if (state !== 'ringing') {
      sendPresenceUpdate();
    }
}

/**
 * Resets all call-related state variables and UI elements.
 */
function resetCallState() {
    console.log("Resetting call state.");
    if (pc) {
        pc.close();
        pc = null;
    }

    if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
        if(remoteVideo) remoteVideo.srcObject = null;
    }

    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }

    currentCallId = null;
    isCaller = false;
    pendingCandidates = []; // Clear any queued ICE candidates

    hideIncomingCallModal(); // Ensure modal is hidden and its listeners are cleaned up

    // Determine next UI state based on whether webcam is still active
    if (localStream) {
        updateUIState('webcam_ready');
    } else {
        updateUIState('init');
    }
    // sendPresenceUpdate() is called by updateUIState
}


/**
 * Starts the webcam and microphone.
 * @param {boolean} connectSocketAfterStart - Whether to attempt WebSocket connection after starting media.
 */
async function startWebcam(connectSocketAfterStart = true) {
    if (localStream) {
        console.log("Webcam already started.");
        return; // Already active
    }
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (webcamVideo) {
            webcamVideo.srcObject = localStream;
            webcamVideo.muted = true; // Mute local feedback to prevent echo
        }
        updateUIState('webcam_ready');

        if (connectSocketAfterStart) {
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                connectSocket(); // Connect WebSocket if not already connected
            } else {
                sendPresenceUpdate(); // If socket is already open, just update presence
            }
        } else {
             sendPresenceUpdate(); // Update presence even if not connecting socket (e.g. when answering call)
        }

    } catch (err) {
        console.error("Error accessing media devices:", err);
        showUserMessage(`Could not access camera/microphone: ${err.message}. Please check permissions.`, 'error');
        // If webcam fails to start, revert to 'init' state if it was trying to get to 'webcam_ready'
        if (!localStream) updateUIState('init');
        throw err; // Re-throw for callers like answerCall to handle
    }
}

// Event Listeners for UI buttons
if (webcamButton) {
    webcamButton.onclick = () => startWebcam(true);
}

if (callButton) {
    // This button is for generic calls if your server supports matchmaking
    // or calling a pre-defined contact without selecting from the peer list.
    callButton.onclick = startCall;
}

if (hangupButton) {
    hangupButton.onclick = hangup;
}

if (acceptCallBtn) { // Button on the incoming call modal
    acceptCallBtn.onclick = answerCall;
}

if (rejectCallBtn) { // Button on the incoming call modal
    rejectCallBtn.onclick = () => {
        hideIncomingCallModal(); // Clean up modal UI and listeners
        if (currentCallId && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: "reject_call",
                callId: currentCallId,
                reason: "rejected_by_user"
            }));
        }
        showUserMessage("Call rejected.", 'info');
        resetCallState(); // Fully reset call state
    };
}

// Initialize the application when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    initializeUI();
    // Optionally, attempt to connect WebSocket on load if desired,
    // or wait for user interaction like starting webcam.
    // For this example, connectSocket() is called by startWebcam() or can be called here:
     connectSocket();
});

