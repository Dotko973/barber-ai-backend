import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO ENGINE
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

// 1. SMOOTH UPSAMPLING (Twilio 8k -> Gemini 16k)
function processTwilioAudio(buffer) {
    const len = buffer.length;
    const pcm16k = new Int16Array(len * 2);
    for (let i = 0; i < len - 1; i++) {
        const s1 = muLawToPcmTable[buffer[i]];
        const s2 = muLawToPcmTable[buffer[i+1]];
        pcm16k[i * 2] = s1;
        pcm16k[i * 2 + 1] = (s1 + s2) >> 1; // Average (Smooths the jagged edges)
    }
    // Handle last sample
    const last = muLawToPcmTable[buffer[len-1]];
    pcm16k[len*2 - 2] = last;
    pcm16k[len*2 - 1] = last;
    return Buffer.from(pcm16k.buffer);
}

// 2. DOWNSAMPLING (Gemini 24k -> Twilio 8k)
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    const srcSamples = new Int16Array(srcBuffer.buffer, srcBuffer.byteOffset, srcBuffer.length / 2);
    const outLen = Math.floor(srcSamples.length / 3);
    const outBuffer = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) {
        const val = srcSamples[i * 3];
        outBuffer[i] = pcmToMuLawMap[val + 32768];
    }
    return outBuffer;
}

// =================================================================
// GEMINI SERVICE
// =================================================================

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ws = null; this.geminiWs = null; this.streamSid = null;
        this.onTranscript = onTranscript; this.onLog = onLog; this.onAppointmentsUpdate = onAppointmentsUpdate;
        this.oAuth2Client = oAuth2Client; this.calendarIds = calendarIds;
        this.googleCalendar = google.calendar({ version: 'v3', auth: this.oAuth2Client });
    }

    setStreamSid(sid) { this.streamSid = sid; }

    log(msg, data = "") {
        console.log(`[GEMINI] ${msg}`);
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: String(data) });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Connecting...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('✅ Connected.');
                
                // 1. SETUP (With Text + Audio Transcription)
                const setupMessage = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO", "TEXT"], // Enable Text for Dashboard
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        // INSTRUCTIONS
                        systemInstruction: { parts: [{ text: `
                            Ти си Ема, телефонен рецепционист. 
                            Говори само на Български.
                            Цел: Запази час (bookAppointment).
                            Когато говориш, бъди кратка.
                        ` }] },
                        // TOOLS
                        tools: [{ functionDeclarations: [
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
                        ]}]
                    }
                };
                this.geminiWs.send(JSON.stringify(setupMessage));

                // 2. GREETING TRIGGER
                this.geminiWs.send(JSON.stringify({
                    clientContent: {
                        turns: [{ role: "user", parts: [{ text: "Start conversation now." }] }],
                        turnComplete: true
                    }
                }));
            });

            this.geminiWs.on('message', (data) => this.handleGeminiMessage(data));
            this.geminiWs.on('close', (c, r) => this.log(`Socket Closed: ${c}`));
            this.geminiWs.on('error', (e) => this.log(`Socket Error: ${e.message}`));

        } catch (e) { this.log('Init Error', e); }
    }

    handleGeminiMessage(data) {
        try {
            const msg = JSON.parse(data.toString());

            // 1. HANDLE TEXT (AI Response)
            if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.text) {
                        this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                    }
                    if (part.inlineData?.data) {
                        const mulawAudio = processGeminiAudio(part.inlineData.data);
                        if (this.ws && this.ws.readyState === 1 && this.streamSid) {
                            this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: mulawAudio.toString('base64') } }));
                        }
                    }
                }
            }

            // 2. HANDLE TOOL CALLS
            if (msg.toolCall) this.handleFunctionCall(msg.toolCall);

        } catch (e) {}
    }

    async handleFunctionCall(toolCall) {
        for (const fc of toolCall.functionCalls) {
            this.log(`Tool: ${fc.name}`, fc.args);
            let result = { result: "Success" };
            if (fc.name === 'getAvailableSlots') result = await this.getAvailableSlots(fc.args);
            else if (fc.name === 'bookAppointment') result = await this.bookAppointment(fc.args);

            this.geminiWs.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: { object_value: result } } }] } }));
        }
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
    
    async getAvailableSlots({ date, barber }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        try {
            const res = await this.googleCalendar.events.list({ calendarId, timeMin: new Date(`${date}T09:00:00`).toISOString(), timeMax: new Date(`${date}T19:00:00`).toISOString(), singleEvents: true });
            return { status: "success", busy: res.data.items.map(e => e.start.dateTime) };
        } catch (e) { return { error: "Calendar error" }; }
    }

    async bookAppointment({ dateTime, barber, service, clientName }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        try {
            await this.googleCalendar.events.insert({ calendarId, resource: { summary: `${service} - ${clientName}`, start: { dateTime: new Date(dateTime).toISOString() }, end: { dateTime: new Date(new Date(dateTime).getTime()+30*60000).toISOString() } } });
            this.onAppointmentsUpdate();
            return { success: true };
        } catch (e) { return { error: "Booking failed" }; }
    }
}