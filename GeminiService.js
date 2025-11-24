import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO MATH (G.711 Tables & Processing)
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
        pcm16k[i * 2] = s; 
        pcm16k[i * 2 + 1] = s;
    }
    return Buffer.from(pcm16k.buffer);
}

// Gemini (24k) -> Twilio (8k)
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    // Safety check: Ensure buffer is even length
    if (srcBuffer.length % 2 !== 0) return Buffer.alloc(0);
    
    const numSamples = srcBuffer.length / 2;
    // Downsample by 3 (24k -> 8k)
    const outLen = Math.floor(numSamples / 3);
    const outBuffer = Buffer.alloc(outLen);

    for (let i = 0; i < outLen; i++) {
        // Read 16-bit integer (Little Endian)
        const val = srcBuffer.readInt16LE(i * 3 * 2);
        outBuffer[i] = pcmToMuLawMap[val + 32768];
    }
    return outBuffer;
}

// =================================================================
// GEMINI SERVICE CLASS
// =================================================================

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ws = null;         // Twilio Socket
        this.geminiWs = null;   // Google Raw Socket
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
        if (data instanceof Error) str = data.message;
        else if (typeof data === 'object') try { str = JSON.stringify(data); } catch { str = "Obj"; }
        else str = String(data);
        console.log(`[GEMINI] ${msg} ${str}`);
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: str });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Starting Raw Socket...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('Gemini Socket OPEN.');
                
                // 1. SETUP: Audio Only (To prevent argument errors)
                const setupMessage = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        systemInstruction: { 
                            parts: [{ text: "You are Emma. Speak Bulgarian. Wait for the user to say Hello." }] 
                        }
                    }
                };
                this.geminiWs.send(JSON.stringify(setupMessage));
                
                // 2. NO TRIGGER MESSAGE
                // We are NOT sending a text trigger. We wait for YOU to speak.
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

            // Handle Audio from Gemini
            if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.inlineData?.data) {
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
            // ignore parsing errors for keep-alive packets
        }
    }

    handleAudio(audioBuffer) {
        // Check if Gemini socket is ready
        if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
        
        try {
            // 1. Process Audio
            const pcm16k = processTwilioAudio(audioBuffer);
            const base64Audio = pcm16k.toString('base64');

            // 2. Send to Gemini
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