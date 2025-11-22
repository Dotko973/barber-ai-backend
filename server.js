import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { WebSocketServer } from "ws";
import http from "http";
import { GeminiService } from "./GeminiService.js"; 

const app = express();
const server = http.createServer(app);

// ----------------------------------------------------
// CORS & MIDDLEWARE
// ----------------------------------------------------
const allowedOrigins = [
  "http://localhost:5173",
  "https://excellent-range-296913.web.app",
  "https://excellent-range-296913.firebaseapp.com"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------------------------------------------
// GOOGLE CALENDAR SETUP
// ----------------------------------------------------
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const calendar = google.calendar({ version: "v3", auth: oauth2Client });

const calendarIds = {
  "Мохамед": "primary", 
  "Джейсън": "primary" 
};

// ----------------------------------------------------
// SSE (REALTIME FRONTEND UPDATES)
// ----------------------------------------------------
let sseClients = [];

function broadcastToFrontend(type, data) {
  sseClients.forEach(client => {
    if (!client.res.writableEnded) {
      client.res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    }
  });
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (res.flushHeaders) res.flushHeaders();

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  // Initial Log
  res.write(`data: ${JSON.stringify({ type: "log", data: { message: "Connected to Backend Realtime Stream" } })}\n\n`);

  req.on("close", () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// ----------------------------------------------------
// API ROUTES (Restored)
// ----------------------------------------------------

// 1. Root Check
app.get("/api", (req, res) => res.json({ status: "Backend is ready" }));

// 2. Test Calendar Connection (FIXED: Restored this route)
app.get("/api/test-calendar", async (req, res) => {
  try {
    const response = await calendar.calendarList.list();
    res.json({ success: true, message: "Calendar service is ready.", data: response.data });
  } catch (error) {
    console.error("Calendar Test Failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Get Appointments
app.get("/api/appointments", async (req, res) => {
  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const appointments = response.data.items.map(event => {
      const start = new Date(event.start.dateTime || event.start.date);
      return {
        id: event.id,
        customerName: event.summary || "Busy",
        date: start.toLocaleDateString(),
        time: start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
    });
    res.json(appointments);
  } catch (error) {
    console.error("Fetch Appointments Error:", error);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

// ----------------------------------------------------
// TWILIO VOICE HANDLERS
// ----------------------------------------------------
app.post("/incoming-call", (req, res) => {
  const host = req.headers.host; 
  const twiml = `
    <Response>
      <Say language="bg-BG">Здравейте, свързвам ви с Ема.</Say>
      <Connect>
        <Stream url="wss://${host}/connection" />
      </Connect>
    </Response>
  `;
  res.type("text/xml").send(twiml);
});

// ----------------------------------------------------
// WEBSOCKET SERVER (Audio Stream)
// ----------------------------------------------------
const wss = new WebSocketServer({ server, path: "/connection" });

wss.on("connection", (ws) => {
  console.log("Twilio Media Stream Connected");

  const onTranscript = (data) => broadcastToFrontend("transcript", data);
  const onLog = (data) => broadcastToFrontend("log", data);
  const onAppointmentsUpdate = () => broadcastToFrontend("appointment_update", { message: "New appointment booked!" });

  const gemini = new GeminiService(
    onTranscript,
    onLog,
    onAppointmentsUpdate,
    oauth2Client,
    calendarIds
  );

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.event === "start") {
        console.log("Twilio Stream Started. SID:", data.start.streamSid);
        gemini.setStreamSid(data.start.streamSid);
        gemini.startSession(ws);
      }
      else if (data.event === "media") {
        const audioBuffer = Buffer.from(data.media.payload, "base64");
        gemini.handleAudio(audioBuffer);
      } 
      else if (data.event === "stop") {
        console.log("Twilio Stream Stopped");
        gemini.endSession();
      }
    } catch (error) {
      console.error("WS Error:", error);
    }
  });

  ws.on("close", () => {
    console.log("Twilio Disconnected");
    gemini.endSession();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Barbershop backend running on port ${PORT}`);
});















