import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';

// =================================================================
// AUDIO TABLES & UTILS
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

function processTwilioAudio(buffer) {
    const pcm16k = new Int16Array(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) {
        const s = muLawToPcmTable[buffer[i]];
        pcm16k[i * 2] = s; pcm16k[i * 2 + 1] = s;
    }
    return Buffer.from(pcm16k.buffer);
}

// Safer Audio Processing (Explicit Little Endian Read)
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    // Gemini sends 24kHz PCM16
    // We need 8kHz. Ratio is 3.
    const outLen = Math.floor((srcBuffer.length / 2) / 3);
    const outBuffer = Buffer.alloc(outLen);

    for (let i = 0; i < outLen; i++) {
        // Calculate index in source buffer (i * 3 samples * 2 bytes/sample)
        const offset = i * 6; 
        if (offset + 1 < srcBuffer.length) {
            const sample = srcBuffer.readInt16LE(offset); // Safe read
            outBuffer[i] = pcmToMuLawMap[sample + 32768];
        }
    }
    return outBuffer;
}

// =================================================================
// GEMINI SERVICE (With Console Logging)
// =================================================================

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ai = new GoogleGenAI({ apiKey: API_KEY });
        this.session = null;
        this.ws = null;
        this.streamSid = null;
        this.onTranscript = onTranscript;
        this.onLog = onLog;
        this.onAppointmentsUpdate = onAppointmentsUpdate;
        this.oAuth2Client = oAuth2Client;
        this.calendarIds = calendarIds;
        this.googleCalendar = google.calendar({ version: 'v3', auth: this.oAuth2Client });
    }

    setStreamSid(sid) { this.streamSid = sid; }

    // UPDATED LOGGING: Writes to Azure Console AND Frontend
    log(msg, data = "") {
        let str = "";
        if (data instanceof Error) str = data.message + (data.stack ? "\n" + data.stack : "");
        else if (typeof data === 'object') try { str = JSON.stringify(data); } catch { str = "Obj"; }
        else str = String(data);
        
        const fullLog = `[GEMINI] ${msg} ${str}`;
        console.log(fullLog); // <--- THIS will show up in Azure Log Stream
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: str });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Starting Session Init...');

        try {
            if (!API_KEY) throw new Error("API_KEY is missing in Environment Variables!");

            this.session = await this.ai.live.connect({
                model: MODEL_NAME,
                config: {
                    responseModalities: ["AUDIO"], 
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
                    systemInstruction: { parts: [{ text: "You are Emma. Speak Bulgarian." }] }
                },
            });
            
            this.log('Session Object Created. Connected!');

            // Send a silent config frame to ensure connection is alive
            await this.session.send({
                parts: [{ text: " " }],
                turnComplete: true
            });

            // Receive Loop
            (async () => {
                this.log('Starting Receive Loop...');
                try {
                    for await (const msg of this.session.receive()) {
                        this.handleLiveMessage(msg);
                    }
                } catch (err) {
                    this.log('CRITICAL STREAM ERROR', err);
                }
            })();

        } catch (error) {
            this.log('FATAL CONNECTION ERROR', error);
            if(this.ws) this.ws.close();
        }
    }

    handleLiveMessage(msg) {
        try {
            const content = msg.serverContent;
            if (content?.modelTurn?.parts) {
                for (const part of content.modelTurn.parts) {
                    if (part.text) this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                    
                    if (part.inlineData?.data) {
                        // Process audio
                        const audio = processGeminiAudio(part.inlineData.data);
                        
                        // Debug log for first chunk only to reduce noise
                        // this.log('Sending Audio Chunk', audio.length);

                        if(this.ws && this.ws.readyState === this.ws.OPEN && this.streamSid) {
                            this.ws.send(JSON.stringify({ 
                                event: 'media', 
                                streamSid: this.streamSid, 
                                media: { payload: audio.toString('base64') } 
                            }));
                        }
                    }
                }
            }
        } catch (e) { this.log("Msg Processing Error", e); }
    }

    handleAudio(audioBuffer) {
        if (!this.session) return;
        try {
            const pcm16 = processTwilioAudio(audioBuffer);
            this.session.sendRealtimeInput([{ mimeType: "audio/pcm;rate=16000", data: pcm16.toString('base64') }]);
        } catch (e) { }
    }

    endSession() {
        this.session = null;
        this.log('Session Ended');
    }
    
    async getAvailableSlots() { return {status: "open"}; }
    async bookAppointment() { this.onAppointmentsUpdate(); return {status: "booked"}; }
}
