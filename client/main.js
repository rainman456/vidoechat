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
   //connectSocket(); 

 };

 function connectSocket() {
   if (socket && socket.readyState === WebSocket.OPEN) {
     if (!isCaller && currentCallId) {
       socket.send(JSON.stringify({
         type: "join_call",
         callId: currentCallId,
       }));
     }
     return;
   }

   if (socket && socket.readyState === WebSocket.CONNECTING) {
     return;
   }

   socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}:${location.host}/ws`);

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

   socket.onmessage = async (event) => {
     let msg;
     try {
       msg = JSON.parse(event.data);
     } catch (e) {
       console.error("Received non-JSON message:", event.data);
       return;
     }

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
   };

   socket.onclose = () => {
     console.log("Disconnected from signaling server");
   };

   socket.onerror = (error) => {
     console.error("WebSocket Error:", error);
     alert("Could not connect to the signaling server. Please ensure it's running and accessible.");
   };
 }

 callButton.onclick = async () => {
  if (!localStream) await webcamButton.onclick();

  isCaller = true;
  currentCallId = "call_" + Math.random().toString(36).substr(2, 9);
  callInput.value = currentCallId;
  callInput.readOnly = true;

  connectSocket();
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

  connectSocket();
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

  //Initial state
 callButton.disabled = true;
 answerButton.disabled = true;
 hangupButton.disabled = true;

