import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// --- AUDIO MATH ---
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

function processTwilioAudio(buffer) {
    const pcm16k = new Int16Array(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) {
        const s = muLawToPcmTable[buffer[i]];
        pcm16k[i * 2] = s; pcm16k[i * 2 + 1] = s;
    }
    return Buffer.from(pcm16k.buffer);
}

function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    const outLen = Math.floor((srcBuffer.length / 2) / 3);
    const outBuffer = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) {
        const offset = i * 6; 
        if (offset + 1 < srcBuffer.length) {
            const sample = srcBuffer.readInt16LE(offset);
            outBuffer[i] = pcmToMuLawMap[sample + 32768];
        }
    }
    return outBuffer;
}

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
        this.firstPacketReceived = false;
        this.firstPacketSent = false;
    }

    setStreamSid(sid) { 
        console.log(`[GEMINI] Stream SID set: ${sid}`);
        this.streamSid = sid; 
    }

    log(msg, data = "") {
        // Log to Azure Console
        console.log(`[LOG] ${msg} ${typeof data === 'object' ? JSON.stringify(data) : data}`);
        // Log to Dashboard
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: String(data) });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Connecting to Google...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('✅ Connected to Google Gemini.');
                const setup = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"], 
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        systemInstruction: { parts: [{ text: "You are Emma. Speak Bulgarian. Wait for user." }] }
                    }
                };
                this.geminiWs.send(JSON.stringify(setup));
                this.log('Setup Sent.');
            });

            this.geminiWs.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    
                    // Log if Gemini generates Audio
                    if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                        if (!this.firstPacketSent) {
                            this.log('🔊 Gemini sent first Audio packet!');
                            this.firstPacketSent = true;
                        }
                        const mulawAudio = processGeminiAudio(msg.serverContent.modelTurn.parts[0].inlineData.data);
                        if (this.ws && this.ws.readyState === 1 && this.streamSid) {
                            this.ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: this.streamSid,
                                media: { payload: mulawAudio.toString('base64') }
                            }));
                        }
                    }
                } catch (e) {}
            });

            this.geminiWs.on('close', (code, reason) => {
                console.error(`[GEMINI] SOCKET CLOSED. Code: ${code}, Reason: ${reason.toString()}`);
                this.log(`SOCKET CLOSED. Code: ${code}`);
            });

            this.geminiWs.on('error', (err) => {
                console.error(`[GEMINI] SOCKET ERROR: ${err.message}`);
                this.log('Socket Error', err.message);
            });

        } catch (e) { this.log('Init Error', e); }
    }

    handleAudio(buffer) {
        if (!this.geminiWs || this.geminiWs.readyState !== 1) return;
        
        if (!this.firstPacketReceived) {
            this.log(`🎤 Received first audio from Twilio (${buffer.length} bytes)`);
            this.firstPacketReceived = true;
        }

        const pcm16 = processTwilioAudio(buffer);
        this.geminiWs.send(JSON.stringify({
            realtimeInput: {
                mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16.toString('base64') }]
            }
        }));
    }

    endSession() {
        if (this.geminiWs) this.geminiWs.close();
        this.log('Session Cleanup');
    }
    
    async getAvailableSlots() { return {status: "open"}; }
    async bookAppointment() { return {status: "booked"}; }
} 