import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO ENGINE (Stable G.711)
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
        console.log(`[GEMINI] ${msg}`);
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message: msg, data: String(data) });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Connecting to Google...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('✅ Connected.');

                // 1. DEFINE THE PERSONA & TOOLS
                const setupMessage = {
                    setup: {
                        model: MODEL_NAME,
                        generationConfig: {
                            responseModalities: ["AUDIO"], 
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        systemInstruction: {
                            parts: [{ text: `
                                Ти си телефонен AI рецепционист в "Gentleman’s Choice Barbershop".
                                Говориш само на български език. Тонът ти е лек, приятелски и професионален.
                                Не казвай, че си AI.

                                СЛЕДВАЙ ТОЗИ ПРОЦЕС СТРИКТНО:
                                1. Поздрави: "Здравейте, благодарим, че се обадихте в Gentleman’s Choice Barbershop. С какво мога да ви помогна?"
                                2. Разбери услугата (подстрижка, брада или комбо).
                                3. Попитай за предпочитан бръснар (Jason, Muhammed или без значение).
                                4. Попитай за ден/час.
                                5. Провери 'getAvailableSlots' за избрания ден.
                                6. Предложи свободен час. Винаги питай: "Този час устройва ли ви?"
                                7. Когато потвърдят, поискай ИМЕ и ФАМИЛИЯ.
                                8. Използвай 'bookAppointment' със съответната продължителност:
                                   - Подстрижка: 30 мин
                                   - Брада: 20 мин
                                   - Комбо: 45 мин
                                9. Потвърди и затвори: "Супер, всичко е готово. Записах ви. Лек ден!"

                                Днешната дата е: ${new Date().toLocaleDateString('bg-BG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
                            ` }]
                        },
                        tools: [
                            {
                                functionDeclarations: [
                                    {
                                        name: "getAvailableSlots",
                                        description: "Check calendar for free slots.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: { 
                                                date: { type: "STRING", description: "YYYY-MM-DD" }, 
                                                barber: { type: "STRING", description: "Barber Name" } 
                                            },
                                            required: ["date", "barber"]
                                        }
                                    },
                                    {
                                        name: "bookAppointment",
                                        description: "Book the appointment.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: { 
                                                dateTime: { type: "STRING", description: "ISO 8601 Start Time" }, 
                                                duration: { type: "NUMBER", description: "Duration in minutes (30, 20, or 45)" },
                                                barber: { type: "STRING" }, 
                                                service: { type: "STRING" }, 
                                                clientName: { type: "STRING" } 
                                            },
                                            required: ["dateTime", "duration", "barber", "service", "clientName"]
                                        }
                                    }
                                ]
                            }
                        ]
                    }
                };
                this.geminiWs.send(JSON.stringify(setupMessage));
                
                // 2. KICKSTART (Forces her to speak the greeting immediately)
                const triggerMessage = {
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: "Телефонът звъни. Вдигни и кажи поздрава от инструкциите." }]
                        }],
                        turnComplete: true
                    }
                };
                this.geminiWs.send(JSON.stringify(triggerMessage));
            });

            this.geminiWs.on('message', (data) => {
                this.handleGeminiMessage(data);
            });

            this.geminiWs.on('close', (code, reason) => this.log(`Socket Closed: ${code}`));
            this.geminiWs.on('error', (err) => this.log(`Socket Error: ${err.message}`));

        } catch (error) {
            this.log('Init Error', error);
        }
    }

    handleGeminiMessage(data) {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.serverContent?.modelTurn?.parts) {
                for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.inlineData?.data) {
                        const mulawAudio = processGeminiAudio(part.inlineData.data);
                        if (this.ws && this.ws.readyState === 1 && this.streamSid) {
                            this.ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: this.streamSid,
                                media: { payload: mulawAudio.toString('base64') }
                            }));
                        }
                    }
                }
            }
            if (msg.toolCall) this.handleFunctionCall(msg.toolCall);
        } catch (e) {}
    }

    async handleFunctionCall(toolCall) {
        for (const fc of toolCall.functionCalls) {
            this.log(`Tool: ${fc.name}`, fc.args);
            let result = { result: "Error" };
            
            if (fc.name === 'getAvailableSlots') {
                result = await this.getAvailableSlots(fc.args);
            } else if (fc.name === 'bookAppointment') {
                result = await this.bookAppointment(fc.args);
            }

            this.geminiWs.send(JSON.stringify({
                toolResponse: {
                    functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: { result: { object_value: result } }
                    }]
                }
            }));
        }
    }

    handleAudio(buffer) {
        if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
        try {
            const pcm16 = processTwilioAudio(buffer);
            this.geminiWs.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16.toString('base64') }]
                }
            }));
        } catch (e) {}
    }

    endSession() {
        if (this.geminiWs) {
            this.geminiWs.close();
            this.geminiWs = null;
        }
    }
    
    // --- REAL CALENDAR LOGIC ---
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
            
            // List BUSY times so AI can calculate FREE times
            const busy = response.data.items.map(e => {
                const s = new Date(e.start.dateTime);
                const end = new Date(e.end.dateTime);
                return `${s.getHours()}:${s.getMinutes().toString().padStart(2,'0')} - ${end.getHours()}:${end.getMinutes().toString().padStart(2,'0')}`;
            });

            return { status: "success", busy_slots: busy, info: "Shop open 09:00-19:00. Slots: 00/30." };
        } catch (e) { return { error: "Calendar unavailable" }; }
    }

    async bookAppointment({ dateTime, duration, barber, service, clientName }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        try {
            // Calculate End Time based on Duration (Default 30 if missing)
            const start = new Date(dateTime);
            const durationMins = duration || 30;
            const end = new Date(start.getTime() + durationMins * 60000);

            await this.googleCalendar.events.insert({
                calendarId,
                resource: { 
                    summary: `${service} - ${clientName}`,
                    description: `Barber: ${barber} | Duration: ${durationMins}m`,
                    start: { dateTime: start.toISOString() }, 
                    end: { dateTime: end.toISOString() } 
                }
            });
            this.onAppointmentsUpdate();
            return { success: true, message: "Booking Configured." };
        } catch (e) { return { error: "Booking failed" }; }
    }
}