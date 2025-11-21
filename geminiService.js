// GeminiService.js - Updated for ES Modules (import/export)

import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;

// --- Helper Functions for Audio Resampling ---
function upsample(buffer) {
  const newSampleRate = 16000;
  const oldSampleRate = 8000;
  const newLength = Math.round(buffer.length * (newSampleRate / oldSampleRate));
  const result = new Int16Array(newLength);
  const springFactor = (buffer.length - 1) / (newLength - 1);
  result[0] = buffer[0];
  result[newLength - 1] = buffer[buffer.length - 1];

  for (let i = 1; i < newLength - 1; i++) {
    const tmp = i * springFactor;
    const before = Math.floor(tmp);
    const after = Math.ceil(tmp);
    const atPoint = tmp - before;
    result[i] = buffer[before] + (buffer[after] - buffer[before]) * atPoint;
  }
  return result;
}

function downsample(buffer) {
    const newSampleRate = 8000;
    const oldSampleRate = 24000;
    const sampleRateRatio = oldSampleRate / newSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Int16Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < newLength) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
        let accum = 0, count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
            accum += buffer[i];
            count++;
        }
        result[offsetResult] = accum / count;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
    }
    return result;
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
        this.onLog({ id: Date.now(), timestamp: new Date().toLocaleTimeString(), message, data });
    }

    async startSession(ws) {
        this.ws = ws;
        this.log('Starting new Gemini Live session.');

        const functionDeclarations = [
            {
                name: 'getAvailableSlots',
                description: 'Checks for available appointment slots for a specific barber on a given date. Use this before booking. The current year is 2024.',
                parameters: {
                    type: "OBJECT",
                    properties: {
                        date: { type: "STRING", description: 'The date to check in YYYY-MM-DD format.' },
                        barber: { type: "STRING", description: 'The name of the barber, either "Мохамед" or "Джейсън".' },
                    },
                    required: ['date', 'barber'],
                },
            },
            {
                name: 'bookAppointment',
                description: 'Books a new appointment. Must confirm available slots first.',
                parameters: {
                    type: "OBJECT",
                    properties: {
                        dateTime: { type: "STRING", description: 'The start time of the appointment in ISO 8601 format (e.g., "2024-07-28T14:30:00.000Z").' },
                        barber: { type: "STRING", description: 'The name of the barber, either "Мохамед" or "Джейсън".' },
                        service: { type: "STRING", description: 'The service requested (e.g., "подстригване", "оформяне на брада").' },
                        clientName: { type: "STRING", description: 'The client\'s full name.' },
                    },
                    required: ['dateTime', 'barber', 'service', 'clientName'],
                },
            },
        ];

        try {
            this.sessionPromise = this.ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                config: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
                    tools: [{ functionDeclarations }],
                    systemInstruction: { parts: [{ text: `Ти си "Ема", професионален и приятелски настроен AI асистент за "Gentleman's Choice Barbershop". Твоята единствена цел е да помагаш на клиенти да запазват часове. Говори **само и единствено на български език**. Не преминавай към английски или руски. Бъди кратка и ясна. Днешната дата е ${new Date().toLocaleDateString('bg-BG')}. Работното време е от 09:00 до 19:00. Първо попитай за кой фризьор се интересуват: "Мохамед" или "Джейсън", след което провери за свободни часове като използваш предоставените инструменти.` }] }
                },
            });
            
            this.session = await this.sessionPromise;
            this.log('Gemini session connected successfully.');

            // Listen for incoming messages from Gemini
            (async () => {
                try {
                    for await (const msg of this.session.receive()) {
                        this.handleLiveMessage(msg);
                    }
                } catch (err) {
                    this.log('Gemini stream error:', err);
                }
            })();

        } catch (error) {
            this.log('Failed to connect to Gemini.', error);
            if(this.ws) this.ws.close();
        }
    }

    async handleFunctionCall(toolCall) {
        for (const fc of toolCall.functionCalls) {
            this.log(`Attempting to execute function: ${fc.name}`, fc.args);
            let result;
            try {
                if (fc.name === 'getAvailableSlots') {
                    result = await this.getAvailableSlots(fc.args);
                } else if (fc.name === 'bookAppointment') {
                    result = await this.bookAppointment(fc.args);
                } else {
                    result = { error: 'Unknown function' };
                }

                this.log(`Function ${fc.name} executed. Result:`, result);
                await this.session.sendToolResponse({
                    functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: { result: { object_value: result } } 
                    }]
                });

            } catch (error) {
                this.log(`Error executing function ${fc.name}:`, error);
            }
        }
    }

    handleLiveMessage(message) {
        if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                    this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
                }
                if (part.inlineData && part.inlineData.data) {
                    const audioBase64 = part.inlineData.data;
                    const audioInt16 = new Int16Array(Buffer.from(audioBase64, 'base64').buffer);
                    const downsampledAudio = downsample(audioInt16);
                    if(this.ws && this.ws.readyState === this.ws.OPEN) {
                        this.ws.send(Buffer.from(downsampledAudio.buffer).toString('base64')); // Twilio needs base64 string, not buffer
                    }
                }
            }
        }
        
        if (message.toolCall) {
            this.handleFunctionCall(message.toolCall);
        }
    }

    handleAudio(audioData) {
        if (this.session) {
            const audioInt16 = new Int16Array(audioData.buffer);
            const upsampledAudio = upsample(audioInt16);
            
            const base64Audio = Buffer.from(upsampledAudio.buffer).toString('base64');
            
            this.session.sendRealtimeInput([{
                mimeType: "audio/pcm;rate=16000",
                data: base64Audio
            }]);
        }
    }

    endSession() {
        if (this.session) {
            // connection is closed automatically when loop ends or via client
            this.session = null;
            this.sessionPromise = null;
            this.log('Gemini session ended.');
        }
    }
    
    // --- Calendar Functions ---
    async getAvailableSlots({ date, barber }) {
        const calendarId = this.calendarIds[barber];
        if (!calendarId) return { error: `Barber "${barber}" not found.` };

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
            const busySlots = response.data.items.map(event => ({
                start: new Date(event.start.dateTime),
                end: new Date(event.end.dateTime),
            }));

            const availableSlots = [];
            let currentTime = new Date(startOfDay);

            while (currentTime < endOfDay) {
                const isBusy = busySlots.some(slot => currentTime >= slot.start && currentTime < slot.end);
                if (!isBusy) {
                    availableSlots.push(new Date(currentTime));
                }
                currentTime.setMinutes(currentTime.getMinutes() + 30);
            }
            // Return simpler object for AI
            return { available_slots: availableSlots.map(s => s.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })) };
        } catch (error) {
            this.log('Error fetching from Google Calendar', error);
            return { error: 'Failed to check calendar.' };
        }
    }

    async bookAppointment({ dateTime, barber, service, clientName }) {
        const calendarId = this.calendarIds[barber];
        if (!calendarId) return { error: `Barber "${barber}" not found.` };

        const startTime = new Date(dateTime);
        const endTime = new Date(startTime.getTime() + 30 * 60000);

        const event = {
            summary: service,
            start: { dateTime: startTime.toISOString(), timeZone: 'Europe/Sofia' },
            end: { dateTime: endTime.toISOString(), timeZone: 'Europe/Sofia' },
            description: `Client: ${clientName}`,
        };
        try {
            await this.googleCalendar.events.insert({ calendarId, resource: event });
            this.onAppointmentsUpdate();
            return { success: true, message: `Appointment booked for ${clientName} with ${barber}.` };
        } catch (error) {
             this.log('Error creating calendar event', error);
            return { success: false, error: 'Failed to book appointment.' };
        }
    }
}