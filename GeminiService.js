import WebSocket from 'ws';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// =================================================================
// AUDIO ENGINE (G.711 + Volume Boost)
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
    const len = buffer.length;
    const pcm16k = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) {
        let s = muLawToPcmTable[buffer[i]];
        s = s * 2; // Volume Boost
        if (s > 32767) s = 32767; if (s < -32768) s = -32768;
        pcm16k[i * 2] = s; 
        pcm16k[i * 2 + 1] = s;
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
        this.log('Connecting...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                this.log('✅ Connected.');
                
                const setup = {
                    setup: {
                        model: MODEL_NAME,
                        generation_config: {
                            response_modalities: ["AUDIO"], 
                            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: 'Aoede' } } }
                        },
                        system_instruction: {
                            parts: [{ text: `
                                Ти си Ема, телефонен AI рецепционист в "Gentleman’s Choice Barbershop".
                                
                                ИЗИСКВАНИЯ ЗА ГОВОР (СТРИКТНО):
                                1. Говори САМО на чист, правилен Български език. Без руски или английски акцент.
                                2. Когато казваш името на салона, произнасяй го като "Джентълменс Чойс".
                                3. Всички дати и часове трябва да се произнасят на български (пример: не "ten thirty", а "десет и тридесет").
                                4. Използвай кратки, ясни изречения.

                                ТВОЯТ СЦЕНАРИЙ:
                                1. Поздрави точно така: "Добър ден, благодаря че се обадихте в Gentleman's Choice Barbershop. Аз съм Ема с какво мога да ви помогна днес?"
                                2. Разбери услугата (подстрижка 30мин, брада 20мин, комбо 45мин).
                                3. Разбери бръснаря (Jason или Muhammed).
                                4. Попитай за ден и час.
                                5. Провери графика (getAvailableSlots).
                                6. Предложи час.
                                7. Поискай името.
                                8. Запиши часа (bookAppointment).
                                
                                Днешната дата е ${new Date().toLocaleDateString('bg-BG')}.
                            ` }]
                        },
                        tools: [{ function_declarations: [
                            { name: "getAvailableSlots", description: "Check slots", parameters: { type: "OBJECT", properties: { date: { type: "STRING" }, barber: { type: "STRING", enum: ["Jason", "Muhammed"] } }, required: ["date", "barber"] } },
                            { name: "bookAppointment", description: "Book appt", parameters: { type: "OBJECT", properties: { dateTime: { type: "STRING" }, duration: { type: "NUMBER" }, barber: { type: "STRING", enum: ["Jason", "Muhammed"] }, service: { type: "STRING" }, clientName: { type: "STRING" } }, required: ["dateTime", "duration", "barber", "service", "clientName"] } }
                        ]}]
                    }
                };
                this.geminiWs.send(JSON.stringify(setup));
                
                // 2. KICKSTART (Force Exact Greeting)
                this.geminiWs.send(JSON.stringify({
                    client_content: {
                        turns: [{
                            role: "user",
                            // We instruct the model that the call has started, so it says the greeting defined in Step 1
                            parts: [{ text: "Обаждането започна. Кажи встъпителния поздрав." }]
                        }],
                        turn_complete: true
                    }
                }));
            });

            this.geminiWs.on('message', (data) => this.handleGeminiMessage(data));
            this.geminiWs.on('close', (c, r) => this.log(`Closed: ${c}`));
            this.geminiWs.on('error', (e) => this.log(`Error: ${e.message}`));

        } catch (e) { this.log('Init Error', e); }
    }

    handleGeminiMessage(data) {
        try {
            const msg = JSON.parse(data.toString());
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
            if (msg.toolCall) this.handleFunctionCall(msg.toolCall);
        } catch (e) {}
    }

    async handleFunctionCall(toolCall) {
        for (const fc of toolCall.functionCalls) {
            this.log(`Tool: ${fc.name}`, fc.args);
            let result = { result: "Success" };
            if (fc.name === 'getAvailableSlots') result = await this.getAvailableSlots(fc.args);
            else if (fc.name === 'bookAppointment') result = await this.bookAppointment(fc.args);
            this.geminiWs.send(JSON.stringify({ tool_response: { function_responses: [{ id: fc.id, name: fc.name, response: { result: { object_value: result } } }] } }));
        }
    }

    handleAudio(buffer) {
        if (!this.geminiWs || this.geminiWs.readyState !== 1) return;
        try {
            const pcm16 = processTwilioAudio(buffer);
            this.geminiWs.send(JSON.stringify({
                realtime_input: { media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: pcm16.toString('base64') }] }
            }));
        } catch (e) {}
    }
    endSession() { if (this.geminiWs) this.geminiWs.close(); }
    
    async getAvailableSlots({ date, barber }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        try {
            const res = await this.googleCalendar.events.list({ calendarId, timeMin: new Date(`${date}T09:00:00`).toISOString(), timeMax: new Date(`${date}T19:00:00`).toISOString(), singleEvents: true });
            const busy = res.data.items.map(e => e.start.dateTime);
            return { status: "success", busy_slots: busy };
        } catch (e) { return { error: "Calendar error" }; }
    }

    async bookAppointment({ dateTime, duration, barber, service, clientName }) {
        const calendarId = this.calendarIds[barber] || 'primary';
        try {
            const start = new Date(dateTime);
            const end = new Date(start.getTime() + (duration || 30)*60000);
            await this.googleCalendar.events.insert({
                calendarId,
                resource: { summary: `${service} - ${clientName}`, description: `Barber: ${barber}`, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
            });
            this.onAppointmentsUpdate();
            return { success: true };
        } catch (e) { return { error: "Booking failed" }; }
    }
}