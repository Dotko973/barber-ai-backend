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

// --- MIDDLEWARE ---
app.use(cors({ origin: true })); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- GOOGLE CALENDAR AUTH ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// --- CALENDAR MAPPING ---
const calendarIds = {
  "Jason": process.env.CALENDAR_ID_BARBER_2 || "primary",
  "Muhammed": process.env.CALENDAR_ID_BARBER_1 || "primary"
};

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

app.get("/api/test-calendar", async (req, res) => {
  try {
    await calendar.calendarList.list();
    res.json({ success: true, message: "Calendar connected." });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ APPOINTMENTS FIX
app.get("/api/appointments", async (req, res) => {
  try {
    const events = [];
    const calendarsToCheck = [
        { name: 'Muhammed', id: calendarIds['Muhammed'] },
        { name: 'Jason', id: calendarIds['Jason'] }
    ];

    for (const cal of calendarsToCheck) {
        if (cal.id === 'primary' && cal.name === 'Jason') continue; 

        try {
            const response = await calendar.events.list({
                calendarId: cal.id,
                timeMin: new Date().toISOString(),
                maxResults: 10,
                singleEvents: true,
                orderBy: 'startTime',
            });
            
            const mapped = response.data.items.map(event => {
                // Parse Summary "Service - Name"
                const summary = event.summary || "Busy";
                let service = summary;
                let clientName = "";
                
                if (summary.includes(" - ")) {
                    const parts = summary.split(" - ");
                    service = parts[0];
                    clientName = parts[1];
                }

                return {
                    id: event.id,
                    barber: cal.name,
                    service: service,     // Fixes "undefined" service
                    clientName: clientName, // Fixes client name display
                    dateTime: event.start.dateTime || event.start.date // Fixes "Invalid Date"
                };
            });
            events.push(...mapped);
        } catch (e) { console.error(`Error fetching ${cal.name}:`, e.message); }
    }

    res.json(events);
  } catch (error) {
    res.json([]); 
  }
});

// --- TWILIO ---
app.post("/incoming-call", (req, res) => {
  const host = req.headers.host; 
  res.type("text/xml").send(`
    <Response>
      <Connect><Stream url="wss://${host}/connection" /></Connect>
    </Response>
  `);
});

// --- WEBSOCKET ---
const wss = new WebSocketServer({ server, path: "/connection" });

wss.on("connection", (ws) => {
  console.log("Twilio Connected");
  const gemini = new GeminiService(
    (d) => broadcastToFrontend("transcript", d),
    (d) => broadcastToFrontend("log", d),
    () => broadcastToFrontend("appointment_update", { message: "Booked!" }),
    oauth2Client,
    calendarIds
  );

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === "start") {
        gemini.setStreamSid(data.start.streamSid);
        gemini.startSession(ws);
      }
      else if (data.event === "media") {
        gemini.handleAudio(Buffer.from(data.media.payload, "base64"));
      } 
      else if (data.event === "stop") {
        gemini.endSession();
      }
    } catch (error) { }
  });
  ws.on("close", () => gemini.endSession());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on ${PORT}`));














