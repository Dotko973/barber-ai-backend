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

// CORS
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
      callback(null, true); // Allow all for debug if needed
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

// CALENDAR AUTH
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const calendar = google.calendar({ version: "v3", auth: oauth2Client });
const calendarIds = { "Мохамед": "primary", "Джейсън": "primary" };

// SSE
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
  res.write(`data: ${JSON.stringify({ type: "log", data: { message: "Connected to Backend" } })}\n\n`);
  req.on("close", () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// API ROUTES
app.get("/", (req, res) => res.send("Barbershop AI Backend"));
app.get("/api", (req, res) => res.json({ status: "Backend is ready" }));

app.get("/api/test-calendar", async (req, res) => {
  try {
    await calendar.calendarList.list();
    res.json({ success: true, message: "Calendar ready." });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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
    res.json([]); 
  }
});

// TWILIO HANDLER
app.post("/incoming-call", (req, res) => {
  const host = req.headers.host; 
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${host}/connection" />
      </Connect>
    </Response>
  `;
  res.type("text/xml").send(twiml);
});

// WEBSOCKET
const wss = new WebSocketServer({ server, path: "/connection" });

wss.on("connection", (ws) => {
  console.log("Twilio Connected");
  
  const onTranscript = (data) => broadcastToFrontend("transcript", data);
  const onLog = (data) => broadcastToFrontend("log", data);
  const onAppointmentsUpdate = () => broadcastToFrontend("appointment_update", { message: "Booked!" });

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
        console.log("Stream Started:", data.start.streamSid);
        gemini.setStreamSid(data.start.streamSid);
        gemini.startSession(ws);
      }
      else if (data.event === "media") {
        gemini.handleAudio(Buffer.from(data.media.payload, "base64"));
      } 
      else if (data.event === "stop") {
        gemini.endSession();
      }
    } catch (error) {
      console.error("WS Error:", error);
    }
  });

  ws.on("close", () => gemini.endSession());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});















