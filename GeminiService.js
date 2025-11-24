import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';

// =================================================================
// AUDIO HELPERS (Twilio 8k Mu-Law <-> Gemini 16k/24k PCM)
// =================================================================

// Mu-Law to Linear PCM
function muLawToLinear(mu) {
    const BIAS = 0x84;
    let sign = (mu & 0x80) >> 7;
    let exponent = (mu & 0x70) >> 4;
    let mantissa = mu & 0x0F;
    let sample = (mantissa << 3) + BIAS;
    sample <<= exponent;
    return sign ? ~(sample - BIAS) : (sample - BIAS);
}

// Linear PCM to Mu-Law
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

function processTwilioAudio(buffer) {
    const len = buffer.length;
    const pcm16k = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) {
        // Twilio uses standard G.711 Mu-Law (inverted bits)
        const sample = muLawToLinear(~buffer[i]);
        pcm16k[i * 2] = sample;
        pcm16k[i * 2 + 1] = sample;
    }
    return Buffer.from(pcm16k.buffer);
}

function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    const srcSamples = new Int16Array(srcBuffer.buffer, srcBuffer.byteOffset, srcBuffer.length / 2);
    // Downsample 24k -> 8k
    const outLen = Math.floor(srcSamples.length / 3);
    const outBuffer = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) {
        const sample = srcSamples[i * 3];
        // Encode back to Mu-Law (invert bits)
        outBuffer[i] = ~linearToMuLaw(sample);
    }
    return outBuffer;
}

// =================================================================
// GEMINI SERVICE
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
        this.log('Initializing Emma...');

        const functionDeclarations = [
            {
                name: 'getAvailableSlots',
                description: 'Check available slots',
                parameters: {
                    type: "OBJECT",
                    properties: { date: { type: "STRING" }, barber: { type: "STRING" } },
                    required: ['date', 'barber'],
                },
            },
            {
                name: 'bookAppointment',
                description: 'Book appointment',
                parameters: {
                    type: "OBJECT",
                    properties: { dateTime: { type: "STRING" }, barber: { type: "STRING" }, service: { type: "STRING" }, clientName: { type: "STRING" } },
                    required: ['dateTime', 'barber', 'service', 'clientName'],
                },
            },
        ];

        try {
            this.sessionPromise = this.ai.live.connect({
                model: MODEL_NAME,
                config: {
                    responseModalities: ["AUDIO", "TEXT"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
                    tools: [{ functionDeclarations }],
                    systemInstruction: { parts: [{ text: `Ти си Ема, рецепционист. Говори САМО Български.` }] }
                },
            });
            
            this.session = await this.sessionPromise;
            this.log('Connected to Gemini.');

            // Enable User Transcription
            await this.session.send({
                setup: {
                    model: MODEL_NAME,
                    inputAudioTranscription: { model: "default" } 
                }
            });

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
                if (fc.name === 'getAvailableSlots') result = await this.getAvailableSlots(fc.args);
                else if (fc.name === 'bookAppointment') result = await this.bookAppointment(fc.args);
                await this.session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result: { object_value: result } } }] });
            } catch (error) { this.log(`Tool Error:`, error); }
        }
    }

    handleLiveMessage(message) {
        try {
            const serverContent = message.serverContent;
            
            if (serverContent?.modelTurn?.parts) {
                for (const part of serverContent.modelTurn.parts) {
                    if (part.text) {
                        this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                    }
                    if (part.inlineData && part.inlineData.data) {
                        const mulawPayload = processGeminiAudio(part.inlineData.data);
                        if(this.ws && this.ws.readyState === this.ws.OPEN && this.streamSid) {
                            this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: mulawPayload.toString('base64') } }));
                        }
                    }
                }
            }
            if (message.toolCall) this.handleFunctionCall(message.toolCall);

        } catch (error) {
            // console.error(error);
        }
    }

    handleAudio(audioBuffer) {
        if (this.session) {
            try {
                const pcm16k = processTwilioAudio(audioBuffer);
                this.session.sendRealtimeInput([{ mimeType: "audio/pcm;rate=16000", data: pcm16k.toString('base64') }]);
            } catch (e) { }
        }
    }

    endSession() {
        this.session = null;
        this.sessionPromise = null;
        this.streamSid = null;
        this.log('Session ended.');
    }
    
    // Calendar
    async getAvailableSlots({ date, barber }) { return { status: "success", message: "Open 09:00-19:00" }; }
    async bookAppointment({ dateTime, barber, clientName }) {
        this.onAppointmentsUpdate();
        return { success: true, message: "Booked" };
    }
}