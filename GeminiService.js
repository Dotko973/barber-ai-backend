// GeminiService.js - Final Bulgarian "Emma" Version

import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp'; // Fast, Low Latency Model

// --- AUDIO DECODER (Twilio Mu-Law -> PCM) ---
// This is required to make the voice sound correct and not like static noise.
const muLawToPcmMap = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let byte = ~i;
    let sign = byte & 0x80 ? -1 : 1;
    let exponent = (byte >> 4) & 0x07;
    let mantissa = byte & 0x0f;
    let sample = sign * ((((mantissa << 3) + 0x84) << exponent) - 0x84);
    muLawToPcmMap[i] = sample;
}

// Convert Twilio Audio (8kHz Mu-Law) -> Gemini Audio (16kHz PCM)
function processAudioChunk(buffer) {
    const pcm8k = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        pcm8k[i] = muLawToPcmMap[buffer[i]];
    }
    // Upsample to 16k (Double the samples)
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length; i++) {
        pcm16k[i * 2] = pcm8k[i];
        pcm16k[i * 2 + 1] = pcm8k[i];
    }
    return pcm16k;
}

// Convert Gemini Audio (24kHz PCM) -> Twilio Audio (8kHz Mu-Law)
function downsampleTo8k(buffer) {
    const inputRate = 24000;
    const outputRate = 8000;
    const ratio = inputRate / outputRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Int16Array(newLength);
    
    for (let i = 0; i < newLength; i++) {
        const index = Math.floor(i * ratio);
        if(index < buffer.length) result[i] = buffer[index];
    }
    
    // Encode to Mu-Law
    const mulawBuffer = Buffer.alloc(newLength);
    for (let i = 0; i < newLength; i++) {
        mulawBuffer[i] = encodeMuLaw(result[i]);
    }
    return mulawBuffer;
}

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
        this.log('Initializing Emma (Bulgarian)...');

        const functionDeclarations = [
            {
                name: 'getAvailableSlots',
                description: 'Checks available slots for a barber. Returns a list of free times.',
                parameters: {
                    type: "OBJECT",
                    properties: {
                        date: { type: "STRING", description: 'Date in YYYY-MM-DD' },
                        barber: { type: "STRING", description: 'Barber name: "Мохамед" or "Джейсън"' },
                    },
                    required: ['date', 'barber'],
                },
            },
            {
                name: 'bookAppointment',
                description: 'Finalizes the booking.',
                parameters: {
                    type: "OBJECT",
                    properties: {
                        dateTime: { type: "STRING", description: 'ISO 8601 Time' },
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
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } // Female Voice
                    },
                    tools: [{ functionDeclarations }],
                    systemInstruction: { parts: [{ text: `
                        Ти си Ема, професионален и любезен AI рецепционист в бръснарница "Gentleman's Choice Barbershop".
                        
                        ТВОИТЕ ИНСТРУКЦИИ:
                        1. Говори САМО на Български език. Никога не говори на английски.
                        2. Бъди кратка и ясна.
                        3. Твоята цел е да запазиш час за клиента при "Мохамед" или "Джейсън".
                        4. Ако клиентът не каже име на фризьор, попитай го.
                        5. Първо провери за свободни часове (getAvailableSlots), преди да запазиш час.
                        6. Днешната дата е ${new Date().toLocaleDateString('bg-BG')}.
                        7. Ако те попитат коя си, кажи "Аз съм Ема, вашият виртуален асистент".
                    ` }] }
                },
            });
            
            this.session = await this.sessionPromise;
            this.log('Emma is ready and connected.');

            // Loop to receive audio/text from Gemini
            (async () => {
                try {
                    for await (const msg of this.session.receive()) {
                        this.handleLiveMessage(msg);
                    }
                } catch (err) {
                    this.log('Connection closed', err);
                }
            })();

        } catch (error) {
            this.log('Connection failed', error);
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
                        id: fc.id,
                        name: fc.name,
                        response: { result: { object_value: result } } 
                    }]
                });

            } catch (error) {
                this.log(`Tool Error: ${fc.name}`, error);
            }
        }
    }

    handleLiveMessage(message) {
        // 1. Handle Text (Transcript)
        if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                    this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                }
                // 2. Handle Audio (Response)
                if (part.inlineData && part.inlineData.data) {
                    // Convert Gemini 24k PCM -> Twilio 8k Mu-Law
                    const pcmInput = new Int16Array(Buffer.from(part.inlineData.data, 'base64').buffer);
                    const mulawAudio = downsampleTo8k(pcmInput);
                    
                    if(this.ws && this.ws.readyState === this.ws.OPEN) {
                        this.ws.send(JSON.stringify({
                            event: 'media',
                            media: { payload: mulawAudio.toString('base64') }
                        }));
                    }
                }
            }
        }
        // 3. Handle Tool Calls
        if (message.toolCall) this.handleFunctionCall(message.toolCall);
    }

    handleAudio(audioBuffer) {
        if (this.session) {
            // Convert Twilio 8k Mu-Law -> Gemini 16k PCM
            const pcm16k = processAudioChunk(audioBuffer);
            const base64Audio = Buffer.from(pcm16k.buffer).toString('base64');
            
            this.session.sendRealtimeInput([{
                mimeType: "audio/pcm;rate=16000",
                data: base64Audio
            }]);
        }
    }

    endSession() {
        this.session = null;
        this.sessionPromise = null;
        this.log('Session ended.');
    }
    
    // --- CALENDAR LOGIC ---
    async getAvailableSlots({ date, barber }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        const startOfDay = new Date(`${date}T09:00:00`);
        const endOfDay = new Date(`${date}T19:00:00`);

        try {
            const response = await this.googleCalendar.events.list({
                calendarId,
                timeMin: startOfDay.toISOString(),
                timeMax: endOfDay.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
            });
            
            // Return generic availability to encourage natural conversation
            const busyTimes = response.data.items.map(e => {
                const s = new Date(e.start.dateTime);
                return `${s.getHours()}:${s.getMinutes().toString().padStart(2,'0')}`;
            });
            return { 
                status: "success", 
                message: `Checked calendar for ${barber} on ${date}.`,
                busy_slots: busyTimes,
                info: "The shop is open 09:00 to 19:00. Slots are 30 mins."
            };
            
        } catch (error) {
            return { error: 'Calendar access failed.' };
        }
    }

    async bookAppointment({ dateTime, barber, service, clientName }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        const startTime = new Date(dateTime);
        const endTime = new Date(startTime.getTime() + 30 * 60000);

        const event = {
            summary: `${service} - ${clientName}`,
            start: { dateTime: startTime.toISOString(), timeZone: 'Europe/Sofia' },
            end: { dateTime: endTime.toISOString(), timeZone: 'Europe/Sofia' },
            description: `Booked by AI Emma. Client: ${clientName}`,
        };
        try {
            await this.googleCalendar.events.insert({ calendarId, resource: event });
            this.onAppointmentsUpdate(); // Tells frontend to refresh
            return { success: true, message: `Appointment confirmed for ${clientName} on ${dateTime}.` };
        } catch (error) {
            return { success: false, error: 'Booking failed.' };
        }
    }
}