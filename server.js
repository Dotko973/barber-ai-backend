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

app.use(cors({ origin: true })); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// --- CALENDAR MAP ---
const calendarIds = {
  "Jason": process.env.CALENDAR_ID_BARBER_2 || "primary",
  "Muhammed": process.env.CALENDAR_ID_BARBER_1 || "primary"
};

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

// ✅ FIXED: Added 'message' property back so dashboard doesn't say "undefined"
app.get("/api/test-calendar", async (req, res) => {
  try { 
      await calendar.calendarList.list(); 
      res.json({ success: true, message: "Google Calendar is connected!" }); 
  } 
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/appointments", async (req, res) => {
  try {
    const events = [];
    const targets = [{name: 'Mohamed', id: calendarIds['Mohamed']}, {name: 'Jason', id: calendarIds['Jason']}];
    
    for (const cal of targets) {
       if(cal.id === 'primary' && cal.name === 'Jason') continue; 
       try {
         const res = await calendar.events.list({ calendarId: cal.id, timeMin: new Date().toISOString(), maxResults: 5, singleEvents: true, orderBy: 'startTime' });
         events.push(...res.data.items.map(e => {
             const summary = e.summary || "Busy";
             let service = summary;
             let clientName = "";
             if(summary.includes(" - ")) { const p = summary.split(" - "); service = p[0]; clientName = p[1]; }
             
             return {
                 id: e.id, barber: cal.name, 
                 service: service,
                 clientName: clientName,
                 dateTime: e.start.dateTime
             };
         }));
       } catch(e) {}
    }
    res.json(events);
  } catch (e) { res.json([]); }
});

app.post("/incoming-call", (req, res) => {
  const host = req.headers.host; 
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${host}/connection" /></Connect></Response>`);
});

const wss = new WebSocketServer({ server, path: "/connection" });
wss.on("connection", (ws) => {
  console.log("Twilio Connected");
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
        gemini.setStreamSid(data.start.streamSid);
        gemini.startSession(ws);
      } else if (data.event === "media") {
        gemini.handleAudio(Buffer.from(data.media.payload, "base64"));
      } else if (data.event === "stop") {
        gemini.endSession();
      }
    } catch (e) {}
  });
  ws.on("close", () => gemini.endSession());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on ${PORT}`));














