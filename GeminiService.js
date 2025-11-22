// GeminiService.js - Standard G.711 Implementation

import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';

// =================================================================
// STANDARD G.711 MU-LAW LOOKUP TABLES (Battle-Tested)
// =================================================================
const muLawToPcmTable = [
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0
];

const pcmToMuLawMap = new Int8Array(65536);
// Generate encode map once
for (let i = -32768; i <= 32767; i++) {
    let sample = i;
    const sign = (sample >> 8) & 0x80;
    if (sample < 0) sample = -sample;
    sample += 132;
    if (sample > 32767) sample = 32767;
    
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
        exponent--;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    const mulaw = ~(sign | (exponent << 4) | mantissa);
    pcmToMuLawMap[i + 32768] = mulaw;
}

// =================================================================
// AUDIO PROCESSING FUNCTIONS
// =================================================================

// INCOMING: Twilio (8k MuLaw) -> Gemini (16k PCM)
function processTwilioAudio(buffer) {
    const len = buffer.length;
    const pcm16k = new Int16Array(len * 2); // Upsample x2
    
    for (let i = 0; i < len; i++) {
        // 1. Decode MuLaw -> 8k PCM
        const pcmSample = muLawToPcmTable[buffer[i]];
        
        // 2. Upsample 8k -> 16k (Duplicate sample)
        pcm16k[i * 2] = pcmSample;
        pcm16k[i * 2 + 1] = pcmSample;
    }
    return Buffer.from(pcm16k.buffer);
}

// OUTGOING: Gemini (24k PCM) -> Twilio (8k MuLaw)
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    // srcBuffer is PCM16 Little Endian at 24kHz
    const srcSamples = new Int16Array(srcBuffer.buffer, srcBuffer.byteOffset, srcBuffer.length / 2);
    
    // Downsample 24k -> 8k (Ratio 3:1)
    const outLen = Math.floor(srcSamples.length / 3);
    const outBuffer = Buffer.alloc(outLen);
    
    for (let i = 0; i < outLen; i++) {
        // Take every 3rd sample
        const val = srcSamples[i * 3];
        
        // Encode to MuLaw
        // Map index is val + 32768 (to handle negative indices)
        outBuffer[i] = pcmToMuLawMap[val + 32768];
    }
    return outBuffer;
}

// =================================================================
// SERVICE CLASS
// =================================================================

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ai = new GoogleGenAI({ apiKey: API_KEY });
        this.sessionPromise = null;
        this.session = null;
        this.ws = null;
        this.onTranscript = onTranscript;
        this.onLog = onLog;
        this.onAppointmentsUpdate = onAppointmentsUpdate;
        this.oAuth2Client = oAuth2Client;
        this.calendarIds = calendarIds;
        this.googleCalendar = google.calendar({ version: 'v3', auth: this.oAuth2Client });
    }

    log(message, data) {
        const dataStr = data instanceof Error ? data.message : (typeof data === 'object' ? JSON.stringify(data) : data);
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message, data: dataStr });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Connecting to Gemini (Bulgarian)...');

        const functionDeclarations = [
            {
                name: 'getAvailableSlots',
                description: 'Get available appointment slots.',
                parameters: {
                    type: "OBJECT",
                    properties: {
                        date: { type: "STRING" },
                        barber: { type: "STRING" },
                    },
                    required: ['date', 'barber'],
                },
            },
            {
                name: 'bookAppointment',
                description: 'Book an appointment.',
                parameters: {
                    type: "OBJECT",
                    properties: {
                        dateTime: { type: "STRING" },
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
                        Ти си Ема, AI рецепционист.
                        1. Говори САМО на Български.
                        2. Поздрави: "Здравейте, тук е Ема. Как мога да помогна?".
                        3. Днес е ${new Date().toLocaleDateString('bg-BG')}.
                    ` }] }
                },
            });
            
            this.session = await this.sessionPromise;
            this.log('Session Connected.');

            // Receive Loop
            (async () => {
                try {
                    for await (const msg of this.session.receive()) {
                        this.handleLiveMessage(msg);
                    }
                } catch (err) {
                    this.log('Stream Error:', err);
                }
            })();

        } catch (error) {
            this.log('Connection Failed:', error);
            if(this.ws) this.ws.close();
        }
    }

    async handleFunctionCall(toolCall) {
         for (const fc of toolCall.functionCalls) {
            this.log(`Tool: ${fc.name}`, fc.args);
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
            // 1. Text Transcript
            if (message.serverContent?.modelTurn?.parts) {
                for (const part of message.serverContent.modelTurn.parts) {
                    if (part.text) {
                        this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                    }
                    // 2. Audio Response
                    if (part.inlineData && part.inlineData.data) {
                        // Downsample and Encode
                        const mulawPayload = processGeminiAudio(part.inlineData.data);
                        
                        if(this.ws && this.ws.readyState === this.ws.OPEN) {
                            this.ws.send(JSON.stringify({
                                event: 'media',
                                media: { payload: mulawPayload.toString('base64') }
                            }));
                        }
                    }
                }
            }
            // 3. Tools
            if (message.toolCall) this.handleFunctionCall(message.toolCall);
        } catch (error) {
            // Suppress audio frame errors to prevent crash
        }
    }

    handleAudio(audioBuffer) {
        if (this.session) {
            try {
                // Decode and Upsample
                const pcm16kBuffer = processTwilioAudio(audioBuffer);
                
                this.session.sendRealtimeInput([{
                    mimeType: "audio/pcm;rate=16000",
                    data: pcm16kBuffer.toString('base64')
                }]);
            } catch (e) {
                // Ignore
            }
        }
    }

    endSession() {
        this.session = null;
        this.sessionPromise = null;
        this.log('Session ended.');
    }
    
    // --- CALENDAR LOGIC (Unchanged) ---
    async getAvailableSlots({ date, barber }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        const startOfDay = new Date(`${date}T09:00:00`);
        const endOfDay = new Date(`${date}T19:00:00`);
        try {
            const response = await this.googleCalendar.events.list({
                calendarId, timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString(), singleEvents: true, orderBy: 'startTime',
            });
            const busyTimes = response.data.items.map(e => e.start.dateTime.slice(11, 16));
            return { status: "success", busy: busyTimes, message: "Open 09:00-19:00." };
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