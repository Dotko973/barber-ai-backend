// GeminiService.js - Final Audio Speed Fix

import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';

// --- AUDIO CONVERSION UTILITIES ---

// Mu-Law (8-bit) table for decoding
const muLawToPcmMap = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let byte = ~i;
    let sign = byte & 0x80 ? -1 : 1;
    let exponent = (byte >> 4) & 0x07;
    let mantissa = byte & 0x0f;
    let sample = sign * ((((mantissa << 3) + 0x84) << exponent) - 0x84);
    muLawToPcmMap[i] = sample;
}

// PCM (16-bit) -> Mu-Law (8-bit) Encoder
function encodeMuLaw(sample) {
    const BIAS = 0x84;
    const CLIP = 32635;
    sample = sample < -CLIP ? -CLIP : sample > CLIP ? CLIP : sample;
    const sign = sample < 0 ? 0x80 : 0;
    sample = sample < 0 ? -sample : sample;
    sample += BIAS;
    let exponent = 0;
    if (sample > 0x7F00) exponent = 7;
    else {
        let temp = sample >> 8;
        if (temp > 0) { exponent = 4; temp >>= 4; }
        if (temp > 0) { exponent += 2; temp >>= 2; }
        if (temp > 0) { exponent += 1; }
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa);
}

// 1. INCOMING: Twilio (8k Mu-Law) -> Gemini (16k PCM)
function processTwilioAudio(buffer) {
    if (!buffer || buffer.length === 0) return Buffer.alloc(0);

    // Decode 8k Mu-Law to 8k PCM
    const pcm8k = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        pcm8k[i] = muLawToPcmMap[buffer[i]];
    }

    // Upsample 8k -> 16k (Duplicate every sample)
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length; i++) {
        const val = pcm8k[i];
        pcm16k[i * 2] = val;
        pcm16k[i * 2 + 1] = val;
    }
    
    return Buffer.from(pcm16k.buffer);
}

// 2. OUTGOING: Gemini (24k PCM) -> Twilio (8k Mu-Law)
function processGeminiAudio(chunk) {
    if (!chunk || chunk.length === 0) return Buffer.alloc(0);

    // Create a DataView to read the Little Endian PCM data safely
    const srcBuffer = Buffer.from(chunk, 'base64');
    const srcLen = srcBuffer.length / 2; // Number of 16-bit samples
    
    // We want to downsample 24k -> 8k. That is a ratio of 3.
    // We take every 3rd sample.
    const outputLen = Math.floor(srcLen / 3);
    const outputBuffer = Buffer.alloc(outputLen); // 1 byte per sample (Mu-Law)

    for (let i = 0; i < outputLen; i++) {
        // Read 16-bit sample at index * 3
        // i*3*2 because each sample is 2 bytes
        const offset = i * 3 * 2; 
        if (offset + 1 < srcBuffer.length) {
            const pcmSample = srcBuffer.readInt16LE(offset);
            outputBuffer[i] = encodeMuLaw(pcmSample);
        }
    }

    return outputBuffer;
}


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
        this.log('Initializing Emma (Bulgarian - Fixed Audio)...');

        const functionDeclarations = [
            {
                name: 'getAvailableSlots',
                description: 'Checks available slots.',
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
                description: 'Books appointment.',
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
                        2. Представи се кратко: "Здравейте, аз съм Ема".
                        3. Попитай как да помогнеш за запазване на час.
                        4. Днес е ${new Date().toLocaleDateString('bg-BG')}.
                    ` }] }
                },
            });
            
            this.session = await this.sessionPromise;
            this.log('Connected to Gemini.');

            (async () => {
                try {
                    for await (const msg of this.session.receive()) {
                        this.handleLiveMessage(msg);
                    }
                } catch (err) {
                    this.log('Receive Loop Error:', err);
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
            // 1. Text
            if (message.serverContent?.modelTurn?.parts) {
                for (const part of message.serverContent.modelTurn.parts) {
                    if (part.text) {
                        this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                    }
                    // 2. Audio (CRITICAL FIX HERE)
                    if (part.inlineData && part.inlineData.data) {
                        // Process the base64 PCM data directly using our new function
                        const mulawBuffer = processGeminiAudio(part.inlineData.data);
                        
                        if(this.ws && this.ws.readyState === this.ws.OPEN) {
                            this.ws.send(JSON.stringify({
                                event: 'media',
                                media: { payload: mulawBuffer.toString('base64') }
                            }));
                        }
                    }
                }
            }
            // 3. Tools
            if (message.toolCall) this.handleFunctionCall(message.toolCall);
        } catch (error) {
            this.log("Message Processing Error", error);
        }
    }

    handleAudio(audioBuffer) {
        if (this.session) {
            try {
                const pcm16kBuffer = processTwilioAudio(audioBuffer);
                const base64Audio = pcm16kBuffer.toString('base64');
                
                this.session.sendRealtimeInput([{
                    mimeType: "audio/pcm;rate=16000",
                    data: base64Audio
                }]);
            } catch (e) {
                // Ignore empty frames
            }
        }
    }

    endSession() {
        this.session = null;
        this.sessionPromise = null;
        this.log('Session ended.');
    }
    
    // --- CALENDAR ---
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