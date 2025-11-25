import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// AUDIO MATH
const muLawToPcmTable = new Int16Array(256);
for (let i=0; i<256; i++) { let u=~i&0xff, s=(u&0x80)?-1:1, e=(u>>4)&0x07, m=u&0x0f; let v=((m<<1)+1)<<(e+2); v-=132; muLawToPcmTable[i]=s*v; }
const pcmToMuLawMap = new Int8Array(65536);
for (let i=-32768; i<=32767; i++) { let s=i, si=(s>>8)&0x80; if(s<0)s=-s; s+=132; if(s>32767)s=32767; let e=7, m=0x4000; while((s&m)===0&&e>0){e--;m>>=1;} let man=(s>>(e+3))&0x0F; pcmToMuLawMap[i+32768]=~(si|(e<<4)|man); }

function processTwilioAudio(buffer) {
    const pcm16k = new Int16Array(buffer.length * 2);
    for (let i=0; i<buffer.length; i++) { const s=muLawToPcmTable[buffer[i]]; pcm16k[i*2]=s; pcm16k[i*2+1]=s; }
    return Buffer.from(pcm16k.buffer);
}
function processGeminiAudio(chunkBase64) {
    const src=Buffer.from(chunkBase64, 'base64');
    const s16=new Int16Array(src.buffer, src.byteOffset, src.length/2);
    const out=Buffer.alloc(Math.floor(s16.length/3));
    for (let i=0; i<out.length; i++) out[i]=pcmToMuLawMap[s16[i*3]+32768];
    return out;
}

export class GeminiService {
    constructor(onTranscript, onLog, onUpd, oAuth, cals) {
        this.ws = null; this.geminiWs = null; this.streamSid = null;
        this.onLog = onLog; this.firstLog = false;
    }

    setStreamSid(sid) { this.streamSid = sid; }

    log(msg) {
        console.log(`[GEMINI] ${msg}`); // Azure Console Log
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Attempting to connect to Google...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('✅ Connected to Google Gemini.');
                
                // 1. SETUP
                const setup = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        systemInstruction: { parts: [{ text: "You are Emma. Speak Bulgarian. Say Hello immediately." }] }
                    }
                };
                this.geminiWs.send(JSON.stringify(setup));
                
                // 2. TRIGGER
                const trigger = {
                    clientContent: {
                        turns: [{ role: "user", parts: [{ text: "Start now." }] }],
                        turnComplete: true
                    }
                };
                this.geminiWs.send(JSON.stringify(trigger));
                this.log('Trigger Sent.');
            });

            this.geminiWs.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                        if(!this.firstLog) { this.log('🔊 Audio received from Gemini!'); this.firstLog = true; }
                        const audio = processGeminiAudio(msg.serverContent.modelTurn.parts[0].inlineData.data);
                        if (this.ws && this.ws.readyState === 1 && this.streamSid) {
                            this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: audio.toString('base64') } }));
                        }
                    }
                } catch (e) { console.error("Parse error", e); }
            });

            this.geminiWs.on('close', (c, r) => this.log(`Socket Closed: ${c} ${r}`));
            this.geminiWs.on('error', (e) => this.log(`Socket Error: ${e.message}`));

        } catch (e) { this.log(`Init Error: ${e.message}`); }
    }

    handleAudio(buffer) {
        if (!this.geminiWs || this.geminiWs.readyState !== 1) return;
        try {
            const pcm16 = processTwilioAudio(buffer);
            this.geminiWs.send(JSON.stringify({
                realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16.toString('base64') }] }
            }));
        } catch (e) {}
    }

    endSession() { if (this.geminiWs) this.geminiWs.close(); }
} 