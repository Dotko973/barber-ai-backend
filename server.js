import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { WebSocketServer } from "ws";
import http from "http";

// --- FIX: IMPORT WITH LOWERCASE 'g' TO MATCH LINUX SERVER FILE ---
import { GeminiService } from "./geminiService.js"; 

// --- CRASH HANDLING (Prints errors to Azure Logs) ---
process.on('uncaughtException', (err) => {
  console.error('🔥 FATAL UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 FATAL UNHANDLED REJECTION:', reason);
});

const app = express();
const server = http.createServer(app);

// MIDDLEWARE
app.use(cors({ origin: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// GOOGLE AUTH
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });
const calendarIds = { "Мохамед": "primary", "Джейсън": "primary" };

// SSE LOGGING
let sseClients = [];
function broadcastToFrontend(type, data) {
  sseClients.forEach(client => {
    if (!client.res.writableEnded) client.res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
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

// ROUTES
app.get("/", (req, res) => res.send("Barbershop Backend Running"));
app.get("/api", (req, res) => res.json({ status: "Backend is ready" }));
app.get("/appointments", (req, res) => res.redirect("/api/appointments"));
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
  } catch (error) { console.error("Calendar Error:", error); res.json([]); }
});

// TWILIO HANDLER
app.post("/incoming-call", (req, res) => {
  console.log("📞 Incoming call received!");
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
  console.log("✅ Twilio Connected");

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
      console.error("WS Error:", error);
    }
  });

  ws.on("close", () => gemini.endSession());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));















