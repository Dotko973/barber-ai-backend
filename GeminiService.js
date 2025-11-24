import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO MATH (G.711 & Resampling)
// =================================================================

const muLawToPcmTable = new Int16Array(256);
for (let i=0; i<256; i++) {
    let u=~i&0xff, s=(u&0x80)?-1:1, e=(u>>4)&0x07, m=u&0x0f;
    let v=((m<<1)+1)<<(e+2); v-=132; muLawToPcmTable[i]=s*v;
}

const pcmToMuLawMap = new Int8Array(65536);
for (let i=-32768; i<=32767; i++) {
    let s=i, si=(s>>8)&0x80; if(s<0)s=-s; s+=132; if(s>32767)s=32767;
    let e=7, m=0x4000; while((s&m)===0&&e>0){e--;m>>=1;}
    let man=(s>>(e+3))&0x0F; pcmToMuLawMap[i+32768]=~(si|(e<<4)|man);
}

// Upsample 8k -> 16k
function processTwilioAudio(buffer) {
    const pcm16k = new Int16Array(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) {
        const s = muLawToPcmTable[buffer[i]];
        pcm16k[i * 2] = s; pcm16k[i * 2 + 1] = s;
    }
    return Buffer.from(pcm16k.buffer);
}

// Downsample 24k -> 8k
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    const srcSamples = new Int16Array(srcBuffer.buffer, srcBuffer.byteOffset, srcBuffer.length / 2);
    const outLen = Math.floor(srcSamples.length / 3);
    const outBuffer = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) {
        // Read every 3rd sample to convert 24k to 8k
        const val = srcSamples[i * 3];
        outBuffer[i] = pcmToMuLawMap[val + 32768];
    }
    return outBuffer;
}

// =================================================================
// GEMINI SERVICE (Raw WebSocket)
// =================================================================

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ws = null;         // Twilio Socket
        this.geminiWs = null;   // Google Socket
        this.streamSid = null;
        this.onTranscript = onTranscript;
        this.onLog = onLog;
        this.onAppointmentsUpdate = onAppointmentsUpdate;
        this.oAuth2Client = oAuth2Client;
        this.calendarIds = calendarIds;
        this.googleCalendar = google.calendar({ version: 'v3', auth: this.oAuth2Client });
    }

    setStreamSid(sid) { this.streamSid = sid; }

    log(msg, data = "") {
        let str = "";
        if (data instanceof Error) str = data.message + (data.stack ? "\n" + data.stack : "");
        else if (typeof data === 'object') try { str = JSON.stringify(data); } catch { str = "Obj"; }
        else str = String(data);
        console.log(`[GEMINI] ${msg} ${str}`); // Azure Log
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: str });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Connecting DIRECTLY to Gemini API...');

        try {
            // 1. Connect to Google via Raw WebSocket
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('Gemini Socket OPEN.');
                
                // 2. Send Setup Message (JSON)
                const setupMessage = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        systemInstruction: { parts: [{ text: "You are Emma. Speak Bulgarian. Be concise." }] }
                    }
                };
                this.geminiWs.send(JSON.stringify(setupMessage));
                
                // 3. Send Initial "Hello" Trigger
                const triggerMessage = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "Hello" }]
                        }],
                        turnComplete: true
                    }
                };
                this.geminiWs.send(JSON.stringify(triggerMessage));
            });

            this.geminiWs.on('message', (data) => {
                this.handleGeminiMessage(data);
            });

            this.geminiWs.on('error', (err) => {
                this.log('Gemini Socket Error:', err);
            });

            this.geminiWs.on('close', () => {
                this.log('Gemini Socket Closed.');
            });

        } catch (error) {
            this.log('Failed to init socket:', error);
        }
    }

    handleGeminiMessage(data) {
        try {
            // Raw buffer -> String -> JSON
            const msgStr = data.toString();
            const msg = JSON.parse(msgStr);

            // Check for Audio
            const parts = msg.serverContent?.modelTurn?.parts;
            if (parts) {
                for (const part of parts) {
                    // Text
                    if (part.text) {
                        this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                    }
                    // Audio
                    if (part.inlineData && part.inlineData.data) {
                        // Downsample 24k -> 8k
                        const mulawAudio = processGeminiAudio(part.inlineData.data);
                        
                        if (this.ws && this.ws.readyState === this.ws.OPEN && this.streamSid) {
                            this.ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: this.streamSid,
                                media: { payload: mulawAudio.toString('base64') }
                            }));
                        }
                    }
                }
            }
        } catch (e) {
            // this.log('Parse Error', e);
        }
    }

    handleAudio(audioBuffer) {
        // Incoming Twilio Audio (8k)
        if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;

        try {
            // Upsample 8k -> 16k
            const pcm16k = processTwilioAudio(audioBuffer);
            const base64Audio = pcm16k.toString('base64');

            // Send Realtime Input (JSON)
            const msg = {
                realtimeInput: {
                    mediaChunks: [{
                        mimeType: "audio/pcm;rate=16000",
                        data: base64Audio
                    }]
                }
            };
            this.geminiWs.send(JSON.stringify(msg));
        } catch (e) { }
    }

    endSession() {
        if (this.geminiWs) {
            this.geminiWs.close();
            this.geminiWs = null;
        }
        this.log('Session Ended');
    }
    
    async getAvailableSlots() { return {status: "open"}; }
    async bookAppointment() { this.onAppointmentsUpdate(); return {status: "booked"}; }
}
