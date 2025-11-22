import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';

// =================================================================
// AUDIO UTILITIES (The "Deep Voice" Fix)
// =================================================================

// 1. Mu-Law to Linear PCM Decoder (For Incoming Twilio Audio)
function muLawToLinear(mu) {
    const BIAS = 0x84;
    let sign = (mu & 0x80) >> 7;
    let exponent = (mu & 0x70) >> 4;
    let mantissa = mu & 0x0F;
    let sample = (mantissa << 3) + BIAS;
    sample <<= exponent;
    return sign ? ~(sample - BIAS) : (sample - BIAS);
}

// 2. Linear PCM to Mu-Law Encoder (For Outgoing Gemini Audio)
function linearToMuLaw(sample) {
    const BIAS = 0x84;
    const MAX = 32635;
    let sign = (sample >> 8) & 0x80;
    if (sample < 0) sample = -sample;
    if (sample > MAX) sample = MAX;
    sample += BIAS;
    let exponent = 7;
    let mask = 0x4000;
    for (; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) { }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa);
}

// 3. Process Incoming Audio (Twilio 8k -> Gemini 16k)
function processTwilioAudio(buffer) {
    const len = buffer.length;
    const pcm16k = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) {
        const sample = muLawToLinear(~buffer[i]); // Invert bit for standard G.711
        pcm16k[i * 2] = sample;
        pcm16k[i * 2 + 1] = sample;
    }
    return Buffer.from(pcm16k.buffer);
}

// 4. Process Outgoing Audio (Gemini 24k -> Twilio 8k)
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    const srcSamples = new Int16Array(srcBuffer.buffer, srcBuffer.byteOffset, srcBuffer.length / 2);
    
    // Downsample 24000Hz -> 8000Hz (Factor of 3)
    const outLen = Math.floor(srcSamples.length / 3);
    const outBuffer = Buffer.alloc(outLen);

    for (let i = 0; i < outLen; i++) {
        const sample = srcSamples[i * 3]; // Skip 2 samples
        outBuffer[i] = ~linearToMuLaw(sample); // Invert bit for standard G.711
    }
    return outBuffer;
}

// =================================================================
// GEMINI SERVICE CLASS
// =================================================================

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ai = new GoogleGenAI({ apiKey: API_KEY });
        this.sessionPromise = null;
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

    setStreamSid(sid) {
        this.streamSid = sid;
    }

    log(message, data) {
        const dataStr = data instanceof Error ? data.message : (typeof data === 'object' ? JSON.stringify(data) : data);
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message, data: dataStr });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Initializing Emma (Bulgarian)...');

        const functionDeclarations = [
            {
                name: 'getAvailableSlots',
                description: 'Checks available appointment slots.',
                parameters: {
                    type: "OBJECT",
                    properties: {
                        date: { type: "STRING", description: "YYYY-MM-DD" },
                        barber: { type: "STRING", description: "Name of barber" },
                    },
                    required: ['date', 'barber'],
                },
            },
            {
                name: 'bookAppointment',
                description: 'Books an appointment.',
                parameters: {
                    type: "OBJECT",
                    properties: {
                        dateTime: { type: "STRING", description: "ISO 8601 DateTime" },
                        barber: { type: "STRING" },
                        service: { type: "STRING" },
                        clientName: { type: "STRING" },
                    },
                    required: ['dateTime', 'barber', 'service', 'clientName'],
                },
            },
        ];

        try {
            this.sessionPromise = this.ai.live.connect({
                model: MODEL_NAME,
                config: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { 
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } 
                    },
                    tools: [{ functionDeclarations }],
                    systemInstruction: { parts: [{ text: `
                        Ти си Ема, AI рецепционист в бръснарница "Gentleman's Choice".
                        1. Говори САМО на Български език.
                        2. Представи се кратко.
                        3. Днес е ${new Date().toLocaleDateString('bg-BG')}.
                    ` }] }
                },
            });
            
            this.session = await this.sessionPromise;
            this.log('Gemini Session Connected.');

            // Receive Loop
            (async () => {
                try {
                    for await (const msg of this.session.receive()) {
                        this.handleLiveMessage(msg);
                    }
                } catch (err) {
                    this.log('Gemini Stream Error:', err);
                }
            })();

        } catch (error) {
            this.log('Connection Failed:', error);
            if(this.ws) this.ws.close();
        }
    }

    async handleFunctionCall(toolCall) {
         for (const fc of toolCall.functionCalls) {
            this.log(`Calling Tool: ${fc.name}`, fc.args);
            let result;
            try {
                if (fc.name === 'getAvailableSlots') {
                    result = await this.getAvailableSlots(fc.args);
                } else if (fc.name === 'bookAppointment') {
                    result = await this.bookAppointment(fc.args);
                }
                await this.session.sendToolResponse({
                    functionResponses: [{
                        id: fc.id, name: fc.name, response: { result: { object_value: result } } 
                    }]
                });
            } catch (error) { this.log(`Tool Error:`, error); }
        }
    }

    handleLiveMessage(message) {
        try {
            // 1. Text
            if (message.serverContent?.modelTurn?.parts) {
                for (const part of message.serverContent.modelTurn.parts) {
                    if (part.text) {
                        this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                    }
                    // 2. Audio
                    if (part.inlineData && part.inlineData.data) {
                        // Convert and Downsample
                        const mulawBuffer = processGeminiAudio(part.inlineData.data);
                        
                        if(this.ws && this.ws.readyState === this.ws.OPEN && this.streamSid) {
                            this.ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: this.streamSid,
                                media: { payload: mulawBuffer.toString('base64') }
                            }));
                        }
                    }
                }
            }
            // 3. Tools
            if (message.toolCall) this.handleFunctionCall(message.toolCall);
        } catch (error) {
            // Ignore
        }
    }

    handleAudio(audioBuffer) {
        if (this.session) {
            try {
                const pcm16k = processTwilioAudio(audioBuffer);
                this.session.sendRealtimeInput([{
                    mimeType: "audio/pcm;rate=16000",
                    data: pcm16k.toString('base64')
                }]);
            } catch (e) {
                // Ignore
            }
        }
    }

    endSession() {
        this.session = null;
        this.sessionPromise = null;
        this.streamSid = null;
        this.log('Session ended.');
    }
    
    // --- COMPLETE CALENDAR LOGIC ---
    async getAvailableSlots({ date, barber }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        const startOfDay = new Date(`${date}T09:00:00`);
        const endOfDay = new Date(`${date}T19:00:00`);
        try {
            const response = await this.googleCalendar.events.list({
                calendarId, timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString(), singleEvents: true, orderBy: 'startTime',
            });
            const busyTimes = response.data.items.map(e => {
                 const t = new Date(e.start.dateTime);
                 return `${t.getHours()}:${t.getMinutes().toString().padStart(2, '0')}`;
            });
            return { status: "success", busy_slots: busyTimes, message: "Open 09:00-19:00." };
        } catch (error) { return { error: 'Calendar Error' }; }
    }

    async bookAppointment({ dateTime, barber, service, clientName }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        const startTime = new Date(dateTime);
        const endTime = new Date(startTime.getTime() + 30 * 60000);
        const event = {
            summary: `${service} - ${clientName}`,
            start: { dateTime: startTime.toISOString(), timeZone: 'Europe/Sofia' },
            end: { dateTime: endTime.toISOString(), timeZone: 'Europe/Sofia' },
            description: `AI Booking. Client: ${clientName}`,
        };
        try {
            await this.googleCalendar.events.insert({ calendarId, resource: event });
            this.onAppointmentsUpdate();
            return { success: true, message: `Booked!` };
        } catch (error) { return { success: false, error: 'Fail' }; }
    }
}