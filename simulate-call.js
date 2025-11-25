import WebSocket from 'ws';

// 1. CONNECT to your Azure Backend (Simulating Twilio)
const ws = new WebSocket('wss://barberai-backend.azurewebsites.net/connection');

ws.on('open', () => {
    console.log('✅ Connected to Azure Backend!');

    // 2. SEND "START" EVENT (Twilio Protocol)
    // This tells the backend: "A call has started, here is the Stream ID."
    const startMessage = {
        event: "start",
        start: {
            streamSid: "TEST_STREAM_123",
            callSid: "TEST_CALL_123"
        }
    };
    ws.send(JSON.stringify(startMessage));
    console.log('📤 Sent "start" event.');

    // 3. SEND DUMMY AUDIO (Silence)
    // We need to send *something* so the server knows the stream is active.
    // This is a small chunk of Mu-Law silence.
    const silencePayload = "ff".repeat(160); // ~20ms of silence
    
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                event: "media",
                media: { payload: Buffer.from(silencePayload, 'hex').toString('base64') }
            }));
        }
    }, 200); // Send every 200ms
    console.log('Microphone live (sending silence)...');
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    // 4. LISTEN FOR RESPONSE
    if (msg.event === 'media') {
        console.log(`🔊 RECEIVED AUDIO from Gemini! (Payload size: ${msg.media.payload.length})`);
        console.log("SUCCESS: The AI is generating audio!");
        // We can exit now because we proved it works
        process.exit(0);
    }
});

ws.on('close', (code, reason) => {
    console.log(`❌ Connection Closed. Code: ${code}, Reason: ${reason}`);
});

ws.on('error', (error) => {
    console.error('❌ WebSocket Error:', error.message);
});