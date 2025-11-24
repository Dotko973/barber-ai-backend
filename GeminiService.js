import WebSocket from 'ws';

const API_KEY = process.env.API_KEY;
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// G.711 Encode Table
const pcmToMuLawMap = new Int8Array(65536);
for (let i=-32768; i<=32767; i++) {
    let s=i, si=(s>>8)&0x80; if(s<0)s=-s; s+=132; if(s>32767)s=32767;
    let e=7, m=0x4000; while((s&m)===0&&e>0){e--;m>>=1;}
    let man=(s>>(e+3))&0x0F; pcmToMuLawMap[i+32768]=~(si|(e<<4)|man);
}

// G.711 Decode Table
const muLawToPcmTable = new Int16Array(256);
for (let i=0; i<256; i++) {
    let u=~i&0xff, s=(u&0x80)?-1:1, e=(u>>4)&0x07, m=u&0x0f;
    let v=((m<<1)+1)<<(e+2); v-=132; muLawToPcmTable[i]=s*v;
}

// 24k -> 8k Downsampler (Safe Mode)
function processGeminiAudio(chunkBase64) {
    const srcBuffer = Buffer.from(chunkBase64, 'base64');
    // Safety check
    if (srcBuffer.length % 2 !== 0) return Buffer.alloc(0);
    
    const numSamples = srcBuffer.length / 2;
    const outLen = Math.floor(numSamples / 3);
    const outBuffer = Buffer.alloc(outLen);

    for (let i = 0; i < outLen; i++) {
        // Read 16-bit integer explicitly as Little Endian (Standard for WAV/PCM)
        // i * 3 skips samples to downsample from 24k to 8k
        const val = srcBuffer.readInt16LE(i * 3 * 2);
        outBuffer[i] = pcmToMuLawMap[val + 32768];
    }
    return outBuffer;
}

// 8k -> 16k Upsampler
function processTwilioAudio(buffer) {
    const pcm16k = new Int16Array(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) {
        const s = muLawToPcmTable[buffer[i]];
        pcm16k[i * 2] = s; pcm16k[i * 2 + 1] = s;
    }
    return Buffer.from(pcm16k.buffer);
}

export class GeminiService {
    constructor(onTranscript, onLog, onAppointmentsUpdate, oAuth2Client, calendarIds) {
        this.ws = null;
        this.geminiWs = null;
        this.streamSid = null;
    }

    setStreamSid(sid) { this.streamSid = sid; }

    async startSession(ws) {
        this.ws = ws;
        console.log('[GEMINI] Connecting...');

        try {
            this.geminiWs = new WebSocket(GEMINI_URL);

            this.geminiWs.on('open', () => {
                console.log('[GEMINI] OPEN');
                
                // SETUP: Audio Only, No Trigger
                const setup = {
                    setup: {
                        model: "models/gemini-2.0-flash-exp",
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
                        },
                        // EMPTY SYSTEM INSTRUCTION TO FORCE SILENCE
                        // We want to prove it can listen before it speaks
                        systemInstruction: { parts: [{ text: "Listen. Only reply if user speaks." }] }
                    }
                };
                this.geminiWs.send(JSON.stringify(setup));
            });

            this.geminiWs.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.serverContent?.modelTurn?.parts) {
                        for (const part of msg.serverContent.modelTurn.parts) {
                            if (part.inlineData?.data) {
                                const audio = processGeminiAudio(part.inlineData.data);
                                if (this.ws && this.ws.readyState === 1 && this.streamSid) {
                                    this.ws.send(JSON.stringify({
                                        event: 'media',
                                        streamSid: this.streamSid,
                                        media: { payload: audio.toString('base64') }
                                    }));
                                }
                            }
                        }
                    }
                } catch (e) {}
            });

            this.geminiWs.on('close', (c, r) => console.log('[GEMINI] CLOSE', c, r));
            this.geminiWs.on('error', (e) => console.log('[GEMINI] ERROR', e));

        } catch (e) { console.log(e); }
    }

    handleAudio(buffer) {
        if (!this.geminiWs || this.geminiWs.readyState !== 1) return;
        const pcm16 = processTwilioAudio(buffer);
        this.geminiWs.send(JSON.stringify({
            realtimeInput: {
                mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16.toString('base64') }]
            }
        }));
    }

    endSession() {
        if (this.geminiWs) this.geminiWs.close();
    }
}
