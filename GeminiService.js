import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO MATH (Keep this exactly as is - IT WORKS)
// =================================================================
const muLawToPcmTable = new Int16Array(256);
for (let i=0; i<256; i++) { let u=~i&0xff, s=(u&0x80)?-1:1, e=(u>>4)&0x07, m=u&0x0f; let v=((m<<1)+1)<<(e+2); v-=132; muLawToPcmTable[i]=s*v; }
const pcmToMuLawMap = new Int8Array(65536);
for (let i=-32768; i<=32767; i++) { let s=i, si=(s>>8)&0x80; if(s<0)s=-s; s+=132; if(s>32767)s=32767; let e=7, m=0x4000; while((s&m)===0&&e>0){e--;m>>=1;} let man=(s>>(e+3))&0x0F; pcmToMuLawMap[i+32768]=~(si|(e<<4)|man); }

function processTwilioAudio(buffer) {
    const pcm16k = new Int16Array(buffer.length * 2);
    for (let i=0; i<buffer.length; i++) { const s=muLawToPcmTable[buffer[i]]; pcm16k[i*2]=s; pcm16k[i*2+1]=s; }
    return Buffer.from(pcm16k.buffer);
}
function processGeminiAudio(chunkBase64) {
    const src=Buffer.from(chunkBase64, 'base64');
    const s16=new Int16Array(src.buffer, src.byteOffset, src.length/2);
    const out=Buffer.alloc(Math.floor(s16.length/3));
    for (let i=0; i<out.length; i++) out[i]=pcmToMuLawMap[s16[i*3]+32768];
    return out;
}

// =================================================================
// GEMINI SERVICE (With Real Calendar Logic)
// =================================================================

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ws = null; this.geminiWs = null; this.streamSid = null;
        this.onTranscript = onTranscript;
        this.onLog = onLog;
        this.onAppointmentsUpdate = onAppointmentsUpdate;
        this.oAuth2Client = oAuth2Client;
        this.calendarIds = calendarIds;
        this.googleCalendar = google.calendar({ version: 'v3', auth: this.oAuth2Client });
        this.firstPacketSent = false;
    }

    setStreamSid(sid) { this.streamSid = sid; }

    log(msg, data = "") {
        console.log(`[GEMINI] ${msg} ${typeof data === 'object' ? JSON.stringify(data) : data}`);
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: String(data) });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Connecting...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('✅ Connected to Google Gemini.');
                
                const setup = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"], // Audio only for stability
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        // SYSTEM INSTRUCTIONS: Define the flow clearly
                        systemInstruction: { parts: [{ text: `
                            Ти си Ема, рецепционист в бръснарница "Gentleman's Choice". 
                            1. Говори САМО на Български език.
                            2. Бъди кратка и любезна.
                            3. Първо попитай клиента за името му.
                            4. След това попитай за услуга (подстригване/брада) и предпочитан бръснар (Мохамед или Джейсън).
                            5. Използвай инструмента 'getAvailableSlots', за да провериш графика.
                            6. Предложи свободни часове.
                            7. Когато клиентът избере час, използвай 'bookAppointment'.
                            8. Днес е ${new Date().toLocaleDateString('bg-BG')}.
                        ` }] },
                        tools: [
                            {
                                functionDeclarations: [
                                    {
                                        name: "getAvailableSlots",
                                        description: "Checks calendar for free slots on a specific date for a barber.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: { date: { type: "STRING", description: "YYYY-MM-DD" }, barber: { type: "STRING" } },
                                            required: ["date", "barber"]
                                        }
                                    },
                                    {
                                        name: "bookAppointment",
                                        description: "Books the appointment after confirmation.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: { 
                                                dateTime: { type: "STRING", description: "ISO 8601 format" }, 
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
                this.geminiWs.send(JSON.stringify(setup));
                
                // TRIGGER: Force her to say hello
                this.geminiWs.send(JSON.stringify({
                    clientContent: {
                        turns: [{ role: "user", parts: [{ text: "Здравей Ема. Започни разговора." }] }],
                        turnComplete: true
                    }
                }));
            });

            this.geminiWs.on('message', (data) => {
                this.handleGeminiMessage(data);
            });
            this.geminiWs.on('close', (c, r) => this.log('Socket Closed', c));
            this.geminiWs.on('error', (e) => this.log('Socket Error', e.message));

        } catch (e) { this.log('Init Error', e); }
    }

    handleGeminiMessage(data) {
        try {
            const msg = JSON.parse(data.toString());
            
            // Handle Audio
            if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.inlineData?.data) {
                        const mulawAudio = processGeminiAudio(part.inlineData.data);
                        if (this.ws && this.ws.readyState === 1 && this.streamSid) {
                            this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: mulawAudio.toString('base64') } }));
                        }
                    }
                }
            }

            // Handle Tool Calls (The Brains)
            if (msg.toolCall) {
                this.handleFunctionCall(msg.toolCall);
            }
        } catch (e) {}
    }

    async handleFunctionCall(toolCall) {
        for (const fc of toolCall.functionCalls) {
            this.log(`🛠️ Calling Tool: ${fc.name}`);
            let result = { error: "Unknown tool" };
            
            if (fc.name === 'getAvailableSlots') {
                result = await this.getAvailableSlots(fc.args);
            } else if (fc.name === 'bookAppointment') {
                result = await this.bookAppointment(fc.args);
            }

            // Send result back to Gemini so it can speak the answer
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
        if (!this.geminiWs || this.geminiWs.readyState !== 1) return;
        try {
            const pcm16 = processTwilioAudio(buffer);
            this.geminiWs.send(JSON.stringify({
                realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16.toString('base64') }] }
            }));
        } catch (e) {}
    }

    endSession() { if (this.geminiWs) this.geminiWs.close(); }
    
    // ---------------------------------------------------------
    // REAL CALENDAR LOGIC
    // ---------------------------------------------------------
    
    async getAvailableSlots({ date, barber }) {
        this.log(`Checking calendar for ${barber} on ${date}`);
        // Default to primary if barber name doesn't match exactly
        const calendarId = this.calendarIds[barber] || 'primary'; 
        
        const startOfDay = new Date(`${date}T09:00:00`); // 9 AM
        const endOfDay = new Date(`${date}T19:00:00`);   // 7 PM

        try {
            // 1. Get existing events
            const response = await this.googleCalendar.events.list({
                calendarId,
                timeMin: startOfDay.toISOString(),
                timeMax: endOfDay.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
            });

            const busySlots = response.data.items.map(event => ({
                start: new Date(event.start.dateTime || event.start.date),
                end: new Date(event.end.dateTime || event.end.date),
            }));

            // 2. Calculate free slots (Simple 30 min intervals)
            const available = [];
            let current = new Date(startOfDay);

            while (current < endOfDay) {
                const nextSlot = new Date(current.getTime() + 30 * 60000); // +30 mins
                
                // Check if this slot overlaps with any busy slot
                const isBusy = busySlots.some(busy => {
                    return (current < busy.end && nextSlot > busy.start);
                });

                if (!isBusy) {
                    available.push(current.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' }));
                }
                current = nextSlot;
            }

            // Limit to first 5 to not overwhelm the AI
            return { 
                status: "success", 
                free_slots: available.slice(0, 8), 
                message: available.length > 0 ? "Here are the free slots." : "No slots available."
            };

        } catch (error) {
            this.log('Calendar Error', error);
            return { status: "error", message: "Could not check calendar." };
        }
    }

    async bookAppointment({ dateTime, barber, service, clientName }) {
        this.log(`Booking for ${clientName} at ${dateTime}`);
        const calendarId = this.calendarIds[barber] || 'primary';
        
        try {
            const start = new Date(dateTime);
            const end = new Date(start.getTime() + 30 * 60000); // 30 min duration

            const event = {
                summary: `${service} - ${clientName}`,
                description: `Booked via AI Agent for ${barber}`,
                start: { dateTime: start.toISOString(), timeZone: 'Europe/Sofia' },
                end: { dateTime: end.toISOString(), timeZone: 'Europe/Sofia' },
            };

            await this.googleCalendar.events.insert({ calendarId, resource: event });
            
            // Notify Frontend
            this.onAppointmentsUpdate(); 

            return { status: "success", message: "Appointment successfully booked." };
        } catch (error) {
            this.log('Booking Error', error);
            return { status: "error", message: "Failed to create event." };
        }
    }
} 