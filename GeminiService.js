import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const API_KEY = process.env.API_KEY;

// ✅ Live API requires a *Live* model. Your previous model name was not Live.
// Supported Live native-audio preview model (public preview): :contentReference[oaicite:5]{index=5}
const MODEL_NAME = 'gemini-live-2.5-flash-preview-native-audio-09-2025';

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
  const srcSamples = new Int16Array(
    srcBuffer.buffer,
    srcBuffer.byteOffset,
    srcBuffer.length / 2
  );

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

    // buffer audio until session is ready (prevents “early Twilio frames lost”)
    this.pendingAudio = [];
    this.maxPendingFrames = 50;
  }

  setStreamSid(sid) {
    this.streamSid = sid;
  }

  log(message, data) {
    const dataStr =
      data instanceof Error ? data.stack || data.message :
      (typeof data === 'object' ? JSON.stringify(data) : data);

    this.onLog({
      id: Date.now(),
      timestamp: new Date().toLocaleTimeString(),
      message,
      data: dataStr
    });
  }

  async startSession(ws) {
    this.ws = ws;
    this.log('[GEMINI] Starting Session Init...');

    const functionDeclarations = [
      {
        name: 'getAvailableSlots',
        description: 'Check available slots',
        parameters: {
          type: "object",
          properties: {
            date: { type: "string" },
            barber: { type: "string" }
          },
          required: ['date', 'barber'],
        },
      },
      {
        name: 'bookAppointment',
        description: 'Book appointment',
        parameters: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            barber: { type: "string" },
            service: { type: "string" },
            clientName: { type: "string" }
          },
          required: ['dateTime', 'barber', 'service', 'clientName'],
        },
      },
    ];

    try {
      // ✅ In JS Live SDK you receive messages via callbacks, not session.receive() :contentReference[oaicite:6]{index=6}
      this.sessionPromise = this.ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: ["AUDIO", "TEXT"],

          // Input transcription exists, but note: some SDK builds don’t send transcripts yet :contentReference[oaicite:7]{index=7}
          inputAudioTranscription: { model: "default" },

          // Hint audio expectations to Live (helps stability) :contentReference[oaicite:8]{index=8}
          audioConfig: { targetSampleRate: 16000 },

          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Aoede' }
            }
          },

          tools: [{ functionDeclarations }],

          systemInstruction: {
            parts: [{
              text: `
Ти си Ема, AI рецепционист.
1. Говори САМО на Български.
2. Днес е ${new Date().toLocaleDateString('bg-BG')}.
`
            }]
          }
        },

        callbacks: {
          onopen: () => this.log("[GEMINI] Socket OPEN"),
          onmessage: (msg) => this.handleLiveMessage(msg),
          onerror: (err) => {
            this.log("[GEMINI] Socket ERROR", err);
            this.endSession();
          },
          onclose: () => {
            this.log("[GEMINI] Socket CLOSED");
            this.endSession();
          }
        }
      });

      this.session = await this.sessionPromise;
      this.log('[GEMINI] Session Object Created. Connected!');

      // Flush any buffered Twilio audio that arrived early
      if (this.pendingAudio.length) {
        for (const frame of this.pendingAudio) {
          this._sendAudioFrame(frame);
        }
        this.pendingAudio = [];
      }

      // Optional proactive greeting:
      // await this.session.sendClientContent({
      //   turns: [{ role: "user", parts: [{ text: "Поздрави клиента и го попитай как можеш да помогнеш." }] }]
      // });

    } catch (error) {
      this.log('[GEMINI] Connection Failed', error);
      this.endSession();
    }
  }

  async handleFunctionCall(toolCall) {
    if (!toolCall?.functionCalls || !this.session) return;

    for (const fc of toolCall.functionCalls) {
      this.log(`[TOOL] ${fc.name}`, fc.args);

      try {
        let result;
        if (fc.name === 'getAvailableSlots') result = await this.getAvailableSlots(fc.args);
        else if (fc.name === 'bookAppointment') result = await this.bookAppointment(fc.args);
        else result = { error: `Unknown tool: ${fc.name}` };

        // ✅ Safer tool response shape: plain JSON result :contentReference[oaicite:9]{index=9}
        await this.session.sendToolResponse({
          functionResponses: [{
            id: fc.id,
            name: fc.name,
            response: result
          }]
        });

      } catch (error) {
        this.log('[TOOL] Error', error);
      }
    }
  }

  handleLiveMessage(message) {
    try {
      const serverContent = message?.serverContent;

      if (serverContent?.modelTurn?.parts) {
        for (const part of serverContent.modelTurn.parts) {
          if (part.text) {
            this.onTranscript({ id: Date.now(), speaker: 'ai', text: part.text });
          }

          if (part.inlineData?.data) {
            const mulawPayload = processGeminiAudio(part.inlineData.data);

            if (this.ws &&
                this.ws.readyState === this.ws.OPEN &&
                this.streamSid) {
              this.ws.send(JSON.stringify({
                event: 'media',
                streamSid: this.streamSid,
                media: { payload: mulawPayload.toString('base64') }
              }));
            }
          }
        }
      }

      if (message?.toolCall) this.handleFunctionCall(message.toolCall);

    } catch (error) {
      this.log('[GEMINI] handleLiveMessage error', error);
    }
  }

  // Internal helper to send a processed audio frame to Gemini
  _sendAudioFrame(muLawBytes) {
    if (!this.session) return;
    const pcm16k = processTwilioAudio(muLawBytes);

    this.session.sendRealtimeInput({
      media: {
        mimeType: "audio/pcm;rate=16000",
        data: pcm16k.toString('base64')
      }
    });
  }

  handleAudio(audioBuffer) {
    try {
      if (!this.session) {
        // buffer early frames until session is ready
        if (this.pendingAudio.length < this.maxPendingFrames) {
          this.pendingAudio.push(audioBuffer);
        }
        return;
      }

      this._sendAudioFrame(audioBuffer);

    } catch (e) {
      this.log("[GEMINI] sendRealtimeInput error", e);
    }
  }

  endSession() {
    try {
      if (this.session?.close) this.session.close();
    } catch (_) {}

    this.session = null;
    this.sessionPromise = null;
    this.streamSid = null;
    this.pendingAudio = [];
    this.log('[GEMINI] Session Ended');
  }

  // Calendar Logic (stub)
  async getAvailableSlots({ date, barber }) {
    return { status: "success", message: "Open 09:00-19:00" };
  }

  async bookAppointment({ dateTime, barber, clientName }) {
    this.onAppointmentsUpdate();
    return { success: true, message: "Booked" };
  }
}
