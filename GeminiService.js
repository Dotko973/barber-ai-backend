import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';

// =================================================================
// AUDIO LOOKUP TABLES (Fastest & Most Reliable G.711)
// =================================================================

// Mu-Law Decode Table (8-bit MuLaw -> 16-bit PCM)
const muLawToPcmTable = [
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956, -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412, -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140, -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092, -3900, -3772,
  -3644, -3516, -3388, -3260, -3132, -3004, -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980, -1884, -1820, -1756, -1692,
  -1628, -1564, -1500, -1436, -1372, -1308, -1244, -1180, -1116, -1052, -988, -924, -876, -844, -812, -780, -748, -716, -684,
  -652, -620, -588, -556, -524, -492, -460, -428, -396, -372, -356, -340, -324, -308, -292, -276, -260, -244, -228, -212, -196,
  -180, -164, -148, -132, -120, -112, -104, -96, -88, -80, -72, -64, -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956, 23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764, 15996, 15484,
  14972, 14460, 13948, 13436, 12924, 12412, 11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316, 7932, 7676, 7420, 7164, 6908,
  6652, 6396, 6140, 5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092, 3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004, 2876, 2748,
  2620, 2492, 2364, 2236, 2108, 1980, 1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436, 1372, 1308, 1244, 1180, 1116, 1052, 988,
  924, 876, 844, 812, 780, 748, 716, 684, 652, 620, 588, 556, 524, 492, 460, 428, 396, 372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132, 120, 112, 104, 96, 88, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0
];

// PCM Encode Table (16-bit PCM -> 8-bit MuLaw)
const pcmToMuLawMap = new Int8Array(65536);
for (let i = -32768; i <= 32767; i++) {
    let sample = i;
    const sign = (sample >> 8) & 0x80;
    if (sample < 0) sample = -sample;
    sample += 132;
    if (sample > 32767) sample = 32767;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    pcmToMuLawMap[i + 32768] = ~(sign | (exponent << 4) | mantissa);
}

// 1. INCOMING: Twilio (8k MuLaw) -> Gemini (16k PCM)
function processTwilioAudio(buffer) {
    const len = buffer.length;
    const pcm16k = new Int16Array(len * 2); // Upsample x2
    
    for (let i = 0; i < len; i++) {
        // Decode MuLaw -> 8k PCM
        const pcmSample = muLawToPcmTable[buffer[i]];
        // Simple Upsample (Linear Interpolation is better, but let's keep it robust for now)
        pcm16k[i * 2] = pcmSample;
        pcm16k[i * 2 + 1] = pcmSample;
    }
    return Buffer.from(pcm16k.buffer);
}

// 2. OUTGOING: Gemini (24k PCM) -> Twilio (8k MuLaw)
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    const srcSamples = new Int16Array(srcBuffer.buffer, srcBuffer.byteOffset, srcBuffer.length / 2);
    
    // Downsample 24k -> 8k (Decimate by 3)
    const outLen = Math.floor(srcSamples.length / 3);
    const outBuffer = Buffer.alloc(outLen);
    
    for (let i = 0; i < outLen; i++) {
        const val = srcSamples[i * 3];
        // Encode to MuLaw (handle negative index shift)
        outBuffer[i] = pcmToMuLawMap[val + 32768];
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
        // IMPROVED LOGGING: Extracts error details properly
        let dataStr = "";
        if (data instanceof Error) {
            dataStr = data.message + (data.stack ? "\n" + data.stack : "");
        } else if (typeof data === 'object') {
            try {
                dataStr = JSON.stringify(data);
            } catch {
                dataStr = "Circular/Unstringifiable Object";
            }
        } else {
            dataStr = data;
        }
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message, data: dataStr });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Initializing Emma (Tables)...');

        const functionDeclarations = [
            {
                name: 'getAvailableSlots',
                description: 'Checks available slots.',
                parameters: {
                    type: "OBJECT",
                    properties: { date: { type: "STRING" }, barber: { type: "STRING" } },
                    required: ['date', 'barber'],
                },
            },
            {
                name: 'bookAppointment',
                description: 'Books appointment.',
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
                    responseModalities: ["AUDIO"], // We want Audio back
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
                    tools: [{ functionDeclarations }],
                    systemInstruction: { parts: [{ text: `
                        Ти си Ема, рецепционист в "Gentleman's Choice". 
                        1. Говори САМО на Български. 
                        2. Твоята цел е да запазиш час за клиента.
                        3. Бъди кратка.
                    ` }] }
                },
            });
            
            this.session = await this.sessionPromise;
            this.log('Connected to Gemini.');

            // REMOVED: The "await this.session.send({ setup: ... })" block.
            // This was causing the "Connection Failed" error because it's not standard in this SDK version.

            (async () => {
                try {
                    for await (const msg of this.session.receive()) {
                        this.handleLiveMessage(msg);
                    }
                } catch (err) {
                    this.log('Stream Error (Receive):', err);
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
                        // Use Lookup Table Downsampling (24k -> 8k)
                        const mulawPayload = processGeminiAudio(part.inlineData.data);
                        
                        if(this.ws && this.ws.readyState === this.ws.OPEN && this.streamSid) {
                            this.ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: this.streamSid,
                                media: { payload: mulawPayload.toString('base64') }
                            }));
                        }
                    }
                }
            }
            if (message.toolCall) this.handleFunctionCall(message.toolCall);
        } catch (error) {
            // Ignore
        }
    }

    handleAudio(audioBuffer) {
        if (this.session) {
            try {
                // Use Lookup Table Upsampling (8k -> 16k)
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
    
    async getAvailableSlots({ date, barber }) { return { status: "success", message: "Open 09:00-19:00" }; }
    async bookAppointment({ dateTime, barber, clientName }) {
        this.onAppointmentsUpdate();
        return { success: true, message: "Booked" };
    }
}