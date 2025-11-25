import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO MATH (G.711 Safe Mode)
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

function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    // Safe Little Endian Read
    const numSamples = Math.floor(srcBuffer.length / 2);
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
// GEMINI SERVICE
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
        this.log('Connecting to Google...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('✅ Connected.');
                
                // 1. SETUP (AUDIO ONLY - THIS FIXES ERROR 1007)
                const setupMessage = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"], // <--- ONLY AUDIO
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        systemInstruction: {
                            parts: [{ text: `
                                Ти си Ема, рецепционист в Gentleman's Choice. 
                                Говори САМО на Български език. 
                                Бъди кратка. Поздрави клиента веднага.
                                Днес е ${new Date().toLocaleDateString('bg-BG')}.
                            ` }]
                        },
                        tools: [
                            {
                                functionDeclarations: [
                                    {
                                        name: "getAvailableSlots",
                                        description: "Check slots",
                                        parameters: { type: "OBJECT", properties: { date: { type: "STRING" }, barber: { type: "STRING" } }, required: ["date", "barber"] }
                                    },
                                    {
                                        name: "bookAppointment",
                                        description: "Book appointment",
                                        parameters: { type: "OBJECT", properties: { dateTime: { type: "STRING" }, barber: { type: "STRING" }, service: { type: "STRING" }, clientName: { type: "STRING" } }, required: ["dateTime", "barber", "service", "clientName"] }
                                    }
                                ]
                            }
                        ]
                    }
                };
                this.geminiWs.send(JSON.stringify(setupMessage));
                
                // 2. KICKSTART (Forces her to speak)
                const triggerMessage = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "Здравей. Започни разговора." }]
                        }],
                        turnComplete: true
                    }
                };
                this.geminiWs.send(JSON.stringify(triggerMessage));
                this.log('Kickstart Sent.');
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
            const msg = JSON.parse(data.toString());
            
            // Handle Audio
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

            // Handle Tools
            if (msg.toolCall) {
                this.handleFunctionCall(msg.toolCall);
            }

        } catch (e) { }
    }

    async handleFunctionCall(toolCall) {
        for (const fc of toolCall.functionCalls) {
            this.log(`Tool: ${fc.name}`, fc.args);
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

    handleAudio(buffer) {
        if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
        try {
            const pcm16 = processTwilioAudio(buffer);
            const msg = {
                realtimeInput: {
                    mediaChunks: [{
                        mimeType: "audio/pcm;rate=16000",
                        data: pcm16.toString('base64')
                    }]
                }
            };
            this.geminiWs.send(JSON.stringify(msg));
        } catch (e) { }
    }

    endSession() {
        if (this.geminiWs) this.geminiWs.close();
    }
    
    // --- CALENDAR ---
    async getAvailableSlots({ date, barber }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        try {
            const res = await this.googleCalendar.events.list({ calendarId, timeMin: new Date(`${date}T09:00:00`).toISOString(), timeMax: new Date(`${date}T19:00:00`).toISOString(), singleEvents: true });
            const busy = res.data.items.map(e => e.start.dateTime);
            return { status: "success", busy_slots: busy };
        } catch (e) { return { error: "Calendar unavailable" }; }
    }

    async bookAppointment({ dateTime, barber, service, clientName }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        try {
            const start = new Date(dateTime);
            const end = new Date(start.getTime() + 30*60000);
            await this.googleCalendar.events.insert({
                calendarId,
                resource: { summary: `${service} - ${clientName}`, description: `Barber: ${barber}`, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
            });
            this.onAppointmentsUpdate();
            return { success: true };
        } catch (e) { return { error: "Booking failed" }; }
    }
}