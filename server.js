import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { WebSocketServer } from "ws";
import http from "http";

// IMPORT WITH LOWERCASE 'g' (Matches Linux file system)
import { GeminiService } from "./geminiService.js"; 

const app = express();
const server = http.createServer(app);

// --- GLOBAL CRASH HANDLERS (Crucial for logs) ---
process.on('uncaughtException', (err) => {
  console.error('🔥 FATAL UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 FATAL UNHANDLED REJECTION:', reason);
});

app.use(cors({ origin: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });
const calendarIds = { "Мохамед": "primary", "Джейсън": "primary" };

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
  res.write(`data: ${JSON.stringify({ type: "log", data: { message: "Connected" } })}\n\n`);
  req.on("close", () => sseClients = sseClients.filter(c => c.id !== clientId));
});

app.get("/", (req, res) => res.send("Backend Running"));
app.get("/api", (req, res) => res.json({ status: "Ready" }));
app.get("/appointments", (req, res) => res.redirect("/api/appointments"));
app.get("/api/appointments", async (req, res) => {
  try {
    const response = await calendar.events.list({ calendarId: 'primary', maxResults: 5 });
    res.json(response.data.items);
  } catch (e) { res.json([]); }
});

app.post("/incoming-call", (req, res) => {
  console.log("📞 Incoming Call");
  const host = req.headers.host; 
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${host}/connection" />
      </Connect>
    </Response>
  `);
});

const wss = new WebSocketServer({ server, path: "/connection" });

wss.on("connection", (ws) => {
  console.log("✅ Socket Connected");
  const gemini = new GeminiService(
    (d) => broadcastToFrontend("transcript", d),
    (d) => broadcastToFrontend("log", d),
    () => broadcastToFrontend("appointment_update", {}),
    oauth2Client, calendarIds
  );

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.event === "start") {
        console.log("▶️ Stream Start");
        gemini.setStreamSid(data.start.streamSid);
        gemini.startSession(ws);
      } else if (data.event === "media") {
        gemini.handleAudio(Buffer.from(data.media.payload, "base64"));
      } else if (data.event === "stop") {
        gemini.endSession();
      }
    } catch (e) { console.error("WS Error", e); }
  });
  ws.on("close", () => gemini.endSession());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));















