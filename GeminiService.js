import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO MATH (G.711 & Resampling)
// =================================================================

// 1. Decode Table (Mu-Law -> PCM)
const muLawToPcmTable = new Int16Array(256);
for (let i=0; i<256; i++) {
    let u=~i&0xff, s=(u&0x80)?-1:1, e=(u>>4)&0x07, m=u&0x0f;
    let v=((m<<1)+1)<<(e+2); v-=132; muLawToPcmTable[i]=s*v;
}

// 2. Encode Table (PCM -> Mu-Law)
const pcmToMuLawMap = new Int8Array(65536);
for (let i=-32768; i<=32767; i++) {
    let s=i, si=(s>>8)&0x80; if(s<0)s=-s; s+=132; if(s>32767)s=32767;
    let e=7, m=0x4000; while((s&m)===0&&e>0){e--;m>>=1;}
    let man=(s>>(e+3))&0x0F; pcmToMuLawMap[i+32768]=~(si|(e<<4)|man);
}

// 3. Upsample 8k -> 16k (Twilio -> Gemini)
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

// 4. Downsample 24k -> 8k (Gemini -> Twilio)
// This fixes the "Deep Male Voice"
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    // Read as Little Endian 16-bit integers
    const numSamples = Math.floor(srcBuffer.length / 2);
    // We need to divide by 3 (24000 / 8000 = 3)
    const outLen = Math.floor(numSamples / 3);
    const outBuffer = Buffer.alloc(outLen);

    for (let i = 0; i < outLen; i++) {
        // i * 3 * 2 bytes per sample
        const offset = i * 6; 
        if (offset + 1 < srcBuffer.length) {
            const val = srcBuffer.readInt16LE(offset);
            outBuffer[i] = pcmToMuLawMap[val + 32768];
        }
    }
    return outBuffer;
}

// =================================================================
// GEMINI SERVICE (Raw WebSocket)
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
        // Logs to Azure Console for debugging
        console.log(`[GEMINI] ${msg} ${typeof data === 'object' ? JSON.stringify(data) : data}`);
        // Logs to Frontend Dashboard
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: String(data) });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Connecting Raw Socket...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('Gemini Socket OPEN.');
                
                // 1. SETUP CONFIGURATION
                const setupMessage = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"], // Keep AUDIO only for stability
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        systemInstruction: {
                            parts: [{ text: `Ти си Ема, професионален AI рецепционист в бръснарница "Gentleman's Choice". Говори САМО на Български език. Днешната дата е ${new Date().toLocaleDateString('bg-BG')}.` }]
                        },
                        tools: [
                            // Calendar Tool Definitions
                            {
                                functionDeclarations: [
                                    {
                                        name: "getAvailableSlots",
                                        description: "Checks available slots",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: { date: { type: "STRING" }, barber: { type: "STRING" } },
                                            required: ["date", "barber"]
                                        }
                                    },
                                    {
                                        name: "bookAppointment",
                                        description: "Books appointment",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: { dateTime: { type: "STRING" }, barber: { type: "STRING" }, service: { type: "STRING" }, clientName: { type: "STRING" } },
                                            required: ["dateTime", "barber", "service", "clientName"]
                                        }
                                    }
                                ]
                            }
                        ]
                    }
                };
                this.geminiWs.send(JSON.stringify(setupMessage));
                this.log('Setup Sent. Waiting for user to speak...');
            });

            this.geminiWs.on('message', (data) => {
                this.handleGeminiMessage(data);
            });

            this.geminiWs.on('error', (err) => {
                this.log('SOCKET ERROR', err.message);
            });

            this.geminiWs.on('close', (code, reason) => {
                this.log(`SOCKET CLOSED. Code: ${code}, Reason: ${reason}`);
            });

        } catch (error) {
            this.log('Init Error', error);
        }
    }

    handleGeminiMessage(data) {
        try {
            const msgStr = data.toString();
            const msg = JSON.parse(msgStr);

            // 1. Handle Audio
            if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.inlineData?.data) {
                        // Safely downsample 24k -> 8k
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
            
            // 2. Handle Tool Calls (Calendar)
            if (msg.toolCall) {
                this.handleFunctionCall(msg.toolCall);
            }

        } catch (e) { }
    }

    async handleFunctionCall(toolCall) {
        for (const fc of toolCall.functionCalls) {
            this.log(`Tool Call: ${fc.name}`);
            let result = { result: "Success" };
            
            if (fc.name === 'getAvailableSlots') result = await this.getAvailableSlots(fc.args);
            else if (fc.name === 'bookAppointment') result = await this.bookAppointment(fc.args);

            const response = {
                toolResponse: {
                    functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: { result: { object_value: result } }
                    }]
                }
            };
            this.geminiWs.send(JSON.stringify(response));
        }
    }

    handleAudio(audioBuffer) {
        if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
        try {
            // Upsample 8k -> 16k and send
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
    
    // --- Calendar Logic ---
    async getAvailableSlots({ date, barber }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        try {
            const response = await this.googleCalendar.events.list({
                calendarId,
                timeMin: new Date(`${date}T09:00:00`).toISOString(),
                timeMax: new Date(`${date}T19:00:00`).toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
            });
            const busyTimes = response.data.items.map(e => {
                 const t = new Date(e.start.dateTime);
                 return `${t.getHours()}:${t.getMinutes().toString().padStart(2, '0')}`;
            });
            return { status: "success", busy_slots: busyTimes, message: "Shop is open 09:00-19:00" };
        } catch (e) { return { error: "Calendar Error" }; }
    }

    async bookAppointment({ dateTime, barber, service, clientName }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        const start = new Date(dateTime);
        const end = new Date(start.getTime() + 30 * 60000);
        const event = {
            summary: `${service} - ${clientName}`,
            description: `Barber: ${barber}`,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() }
        };
        try {
            await this.googleCalendar.events.insert({ calendarId, resource: event });
            this.onAppointmentsUpdate();
            return { success: true, message: "Appointment Booked" };
        } catch (e) { return { error: "Booking Failed" }; }
    }
}