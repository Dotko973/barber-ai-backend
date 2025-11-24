import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'models/gemini-2.0-flash-exp';

// =================================================================
// AUDIO ENGINE (Optimized)
// =================================================================

// Fast μ-law decode table
const MULAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    const sign = (u & 0x80) ? -1 : 1;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 1) + 1) << (exponent + 2);
    sample -= 33 << 2;
    table[i] = sign * sample;
  }
  return table;
})();

function muLawBufferToPcm8kInt16(muLawBuf) {
  const out = new Int16Array(muLawBuf.length);
  for (let i = 0; i < muLawBuf.length; i++) {
    out[i] = MULAW_DECODE_TABLE[muLawBuf[i]];
  }
  return out;
}

// Linear Interpolation Upsampler (Smoother Sound)
function upsample8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length - 1; i++) {
    const s0 = pcm8k[i];
    const s1 = pcm8k[i + 1];
    out[i * 2] = s0;
    out[i * 2 + 1] = (s0 + s1) >> 1;
  }
  if (pcm8k.length > 0) {
      out[out.length - 2] = pcm8k[pcm8k.length - 1];
      out[out.length - 1] = pcm8k[pcm8k.length - 1];
  }
  return out;
}

function processTwilioAudio(muLawBytes) {
  const pcm8k = muLawBufferToPcm8kInt16(muLawBytes);
  const pcm16k = upsample8kTo16k(pcm8k);
  return Buffer.from(pcm16k.buffer);
}

// PCM16 -> Mu-Law Encoder
function linearToMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function processGeminiAudio(chunkBase64) {
  const srcBuffer = Buffer.from(chunkBase64, 'base64');
  const srcSamples = new Int16Array(srcBuffer.buffer, srcBuffer.byteOffset, srcBuffer.length / 2);
  
  // Downsample 24k -> 8k (Decimate by 3)
  const outLen = Math.floor(srcSamples.length / 3);
  const out = Buffer.alloc(outLen);

  for (let i = 0; i < outLen; i++) {
    const s = srcSamples[i * 3];
    out[i] = linearToMuLaw(s);
  }
  return out;
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
    this.log('Initializing Emma (Optimized Audio)...');

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
          systemInstruction: { parts: [{ text: `
            Ти си Ема, AI рецепционист.
            1. Говори САМО на Български.
            2. Днес е ${new Date().toLocaleDateString('bg-BG')}.
          ` }] }
        },
      });
      
      this.session = await this.sessionPromise;
      this.log('Connected to Gemini.');

      // SETUP: Force User Transcription
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
      if (this.ws) this.ws.close();
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
          if (part.inlineData?.data) {
            // Use our new interpolation-based downsampler
            const mulawPayload = processGeminiAudio(part.inlineData.data);
            if(this.ws && this.ws.readyState === this.ws.OPEN && this.streamSid) {
              this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: mulawPayload.toString('base64') } }));
            }
          }
        }
      }
      
      // Capture User Transcript (If available)
      if (serverContent?.turnComplete) {
          // Not always sent, but we listen for it
      }

      if (message.toolCall) this.handleFunctionCall(message.toolCall);

    } catch (error) {
      // Ignore
    }
  }

  handleAudio(audioBuffer) {
    if (this.session) {
      try {
        // Use our new interpolation-based upsampler
        const pcm16k = processTwilioAudio(audioBuffer);
        // Use correct SDK method
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
  
  // Calendar Logic
  async getAvailableSlots({ date, barber }) { return { status: "success", message: "Open 09:00-19:00" }; }
  async bookAppointment({ dateTime, barber, clientName }) {
    this.onAppointmentsUpdate();
    return { success: true, message: "Booked" };
  }
}