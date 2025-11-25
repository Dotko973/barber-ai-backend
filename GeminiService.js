import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
// We use the stable 2.0 Flash Exp model for WebSockets
const MODEL_NAME = 'models/gemini-2.0-flash-exp'; 
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO ENGINE (G.711 Lookup Tables - PROVEN STABLE)
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

// Twilio (8k) -> Gemini (16k)
function processTwilioAudio(buffer) {
    const pcm16k = new Int16Array(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) {
        const s = muLawToPcmTable[buffer[i]];
        pcm16k[i * 2] = s; pcm16k[i * 2 + 1] = s;
    }
    return Buffer.from(pcm16k.buffer);
}

// Gemini (24k) -> Twilio (8k)
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
        this.log('Connecting to Brain...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('✅ Connected to Google Gemini.');
                
                // 1. SETUP (Manager's Logic inserted here)
                const setupMessage = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"], // Audio only prevents errors
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        // --- MANAGER'S SYSTEM INSTRUCTION ---
                        systemInstruction: {
                            parts: [{ text: `
                                Ти си "Ема", професионален и приятелски настроен AI асистент за "Gentleman's Choice Barbershop". 
                                Твоята единствена цел е да помагаш на клиенти да запазват часове. 
                                Говори **само и единствено на български език**. Не преминавай към английски или руски. 
                                Бъди кратка и ясна. 
                                Днешната дата е ${new Date().toLocaleDateString('bg-BG')}. 
                                Работното време е от 09:00 до 19:00. 
                                Първо попитай за кой фризьор се интересуват: "Мохамед" или "Джейсън", 
                                след което провери за свободни часове като използваш предоставените инструменти.
                            ` }] 
                        },
                        tools: [
                            // --- MANAGER'S TOOLS ---
                            {
                                functionDeclarations: [
                                    {
                                        name: "getAvailableSlots",
                                        description: "Checks for available appointment slots for a specific barber on a given date.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: { 
                                                date: { type: "STRING", description: "YYYY-MM-DD" }, 
                                                barber: { type: "STRING", description: "Name: Мохамед or Джейсън" } 
                                            },
                                            required: ["date", "barber"]
                                        }
                                    },
                                    {
                                        name: "bookAppointment",
                                        description: "Books a new appointment.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: { 
                                                dateTime: { type: "STRING", description: "ISO 8601" }, 
                                                barber: { type: "STRING" }, 
                                                service: { type: "STRING" }, 
                                                clientName: { type: "STRING" } 
                                            },
                                            required: ["dateTime", "barber", "service", "clientName"]
                                        }
                                    }
                                ]
                            }
                        ]
                    }
                };
                this.geminiWs.send(JSON.stringify(setupMessage));
                
                // 2. KICKSTART (Force Hello)
                // We add this so you know it's working immediately
                const triggerMessage = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "Здравей. Представи се." }]
                        }],
                        turnComplete: true
                    }
                };
                this.geminiWs.send(JSON.stringify(triggerMessage));
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
            
            // Audio Response
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
            
            // Tool Calls (Logic)
            if (msg.toolCall) {
                this.handleFunctionCall(msg.toolCall);
            }

        } catch (e) { }
    }

    async handleFunctionCall(toolCall) {
        for (const fc of toolCall.functionCalls) {
            this.log(`🛠️ Executing Tool: ${fc.name}`);
            let result = { error: "Unknown tool" };
            
            if (fc.name === 'getAvailableSlots') {
                result = await this.getAvailableSlots(fc.args);
            } else if (fc.name === 'bookAppointment') {
                result = await this.bookAppointment(fc.args);
            }

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
    
    // --- MANAGER'S CALENDAR LOGIC (Restored) ---
    
    async getAvailableSlots({ date, barber }) {
        this.log(`Checking Calendar: ${barber} on ${date}`);
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
            
            // Logic: Find gaps or just return existing events so AI figures it out
            // Simplifying for reliability: Return list of BUSY times. AI can calculate free times.
            const busyTimes = response.data.items.map(event => {
                const start = new Date(event.start.dateTime);
                const end = new Date(event.end.dateTime);
                return `${start.getHours()}:${start.getMinutes()} - ${end.getHours()}:${end.getMinutes()}`;
            });

            return { 
                status: "success", 
                date: date,
                barber: barber,
                busy_slots: busyTimes,
                message: "The barber is busy at these times. All other 30-min slots between 09:00 and 19:00 are free."
            };
        } catch (error) {
            this.log('Calendar Error', error);
            return { error: "Failed to check calendar." };
        }
    }

    async bookAppointment({ dateTime, barber, service, clientName }) {
        this.log(`Booking: ${clientName} for ${dateTime}`);
        const calendarId = this.calendarIds[barber] || 'primary';
        
        const start = new Date(dateTime);
        const end = new Date(start.getTime() + 30 * 60000); // 30 mins

        const event = {
            summary: `${service} - ${clientName}`,
            description: `Booked by AI for ${barber}`,
            start: { dateTime: start.toISOString(), timeZone: 'Europe/Sofia' },
            end: { dateTime: end.toISOString(), timeZone: 'Europe/Sofia' },
        };

        try {
            await this.googleCalendar.events.insert({ calendarId, resource: event });
            this.onAppointmentsUpdate(); // Refresh Dashboard
            return { success: true, message: "Appointment confirmed." };
        } catch (error) {
            this.log('Booking Error', error);
            return { error: "Failed to book appointment." };
        }
    }
} 