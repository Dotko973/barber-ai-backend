import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO MATH (G.711 Table)
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

// Twilio (8k) -> Gemini (16k)
function processTwilioAudio(buffer) {
    const len = buffer.length;
    const pcm16k = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) {
        const s = muLawToPcmTable[buffer[i]];
        pcm16k[i * 2] = s; pcm16k[i * 2 + 1] = s;
    }
    return Buffer.from(pcm16k.buffer);
}

// Gemini (24k) -> Twilio (8k) - SAFER VERSION
function processGeminiAudio(chunkBase64) {
    // 1. Decode Base64 to Buffer
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    
    // 2. Convert to Int16 Array (Little Endian)
    // Ensure we don't read past end of buffer
    const numSamples = Math.floor(srcBuffer.length / 2);
    const srcSamples = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
        srcSamples[i] = srcBuffer.readInt16LE(i * 2);
    }

    // 3. Downsample 24k -> 8k (Decimate by 3)
    const outLen = Math.floor(numSamples / 3);
    const outBuffer = Buffer.alloc(outLen);

    for (let i = 0; i < outLen; i++) {
        const val = srcSamples[i * 3];
        // 4. Encode to Mu-Law (Handle Index Offset)
        outBuffer[i] = pcmToMuLawMap[val + 32768]; 
    }
    
    return outBuffer;
}

// =================================================================
// SERVICE
// =================================================================

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ws = null;
        this.geminiWs = null;
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
        console.log(`[GEMINI] ${msg} ${typeof data === 'object' ? JSON.stringify(data) : data}`);
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: String(data) });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Starting Socket...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('Gemini Socket OPEN.');
                
                // 1. SETUP (AUDIO ONLY for Stability)
                // We removed "TEXT" again because that caused the 1007 error before.
                // Let's get audio working first.
                const setupMessage = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"], 
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        }
                    }
                };
                this.geminiWs.send(JSON.stringify(setupMessage));
                
                // 2. GREETING
                const triggerMessage = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "Здравей, Ема." }]
                        }],
                        turnComplete: true
                    }
                };
                this.geminiWs.send(JSON.stringify(triggerMessage));
            });

            this.geminiWs.on('message', (data) => {
                this.handleGeminiMessage(data);
            });

            this.geminiWs.on('close', (code, reason) => {
                this.log(`SOCKET CLOSED. Code: ${code}, Reason: ${reason}`);
            });

            this.geminiWs.on('error', (err) => {
                this.log('SOCKET ERROR', err.message);
            });

        } catch (error) {
            this.log('Init Error', error);
        }
    }

    handleGeminiMessage(data) {
        try {
            const msgStr = data.toString();
            const msg = JSON.parse(msgStr);

            if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.inlineData?.data) {
                        // Process Audio using Safer Function
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
        } catch (e) { }
    }

    handleAudio(audioBuffer) {
        if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
        try {
            const pcm16k = processTwilioAudio(audioBuffer);
            const msg = {
                realtimeInput: {
                    mediaChunks: [{
                        mimeType: "audio/pcm;rate=16000",
                        data: pcm16k.toString('base64')
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
