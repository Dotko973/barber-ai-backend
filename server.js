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

// --- CRASH CATCHER (Prevents "Application Error") ---
process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 UNHANDLED REJECTION:', reason);
});

// --- MIDDLEWARE ---
app.use(cors({ origin: true })); // Allow all for debug
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- GOOGLE AUTH ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });
const calendarIds = { "Мохамед": "primary", "Джейсън": "primary" };

// --- SSE ---
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
  req.on("close", () => sseClients = sseClients.filter(c => c.id !== clientId));
});

// --- ROUTES ---
app.get("/", (req, res) => res.send("Barbershop Backend Running"));
app.get("/api", (req, res) => res.json({ status: "Backend is ready" }));
app.get("/appointments", (req, res) => res.redirect("/api/appointments")); // Fix frontend mismatch
app.get("/api/appointments", async (req, res) => {
  try {
    const response = await calendar.events.list({
      calendarId: 'primary', timeMin: new Date().toISOString(), maxResults: 10, singleEvents: true, orderBy: 'startTime',
    });
    const appointments = response.data.items.map(e => ({
      id: e.id, customerName: e.summary || "Busy", 
      date: new Date(e.start.dateTime).toLocaleDateString(), 
      time: new Date(e.start.dateTime).toLocaleTimeString()
    }));
    res.json(appointments);
  } catch (error) { res.json([]); }
});

// --- TWILIO WEBHOOK (Safe Mode) ---
app.post("/incoming-call", (req, res) => {
  console.log("📞 Incoming call received!");
  const host = req.headers.host; 
  
  // Using English greeting to prevent Twilio 13512 Error
  // The AI will speak Bulgarian afterwards.
  const twiml = `
    <Response>
      <Say>Connecting you to Emma.</Say>
      <Connect>
        <Stream url="wss://${host}/connection" />
      </Connect>
    </Response>
  `;
  res.type("text/xml").send(twiml);
});

// --- WEBSOCKET ---
const wss = new WebSocketServer({ server, path: "/connection" });

wss.on("connection", (ws) => {
  console.log("✅ Twilio Media Stream Connected");

  const gemini = new GeminiService(
    (data) => broadcastToFrontend("transcript", data),
    (data) => broadcastToFrontend("log", data),
    () => broadcastToFrontend("appointment_update", { message: "Booked!" }),
    oauth2Client, calendarIds
  );

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === "start") {
        console.log("▶️ Stream Started:", data.start.streamSid);
        gemini.setStreamSid(data.start.streamSid);
        gemini.startSession(ws);
      }
      else if (data.event === "media") {
        gemini.handleAudio(Buffer.from(data.media.payload, "base64"));
      } 
      else if (data.event === "stop") {
        console.log("⏹️ Stream Stopped");
        gemini.endSession();
      }
    } catch (error) {
      console.error("WS Parsing Error:", error);
    }
  });

  ws.on("close", () => gemini.endSession());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));















