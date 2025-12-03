import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();

// --- MIDDLEWARE ---
app.use(cors({ origin: true })); 
app.use(bodyParser.json());

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
  "Mohamed": process.env.CALENDAR_ID_BARBER_1 || "primary",
  "Muhammed": process.env.CALENDAR_ID_BARBER_1 || "primary" // Safety fallback
};

// --- DASHBOARD LIVE UPDATES (SSE) ---
let sseClients = [];
function broadcast(type, data) {
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
  
  // Initial message to turn dashboard Green
  res.write(`data: ${JSON.stringify({ type: "log", data: { message: "Connected to Vapi Backend" } })}\n\n`);
  
  req.on("close", () => sseClients = sseClients.filter(c => c.id !== clientId));
});

// --- STANDARD API ROUTES (For Dashboard) ---
app.get("/", (req, res) => res.send("Barbershop Vapi Backend Running"));
app.get("/api", (req, res) => res.json({ status: "Vapi Backend Ready" }));

// Calendar Test Button
app.get("/api/test-calendar", async (req, res) => {
    try {
        await calendar.calendarList.list();
        res.json({ success: true, message: "Google Calendar connected!" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Appointments List
app.get("/api/appointments", async (req, res) => {
    try {
        const events = [];
        const targets = [{name: 'Mohamed', id: calendarIds['Mohamed']}, {name: 'Jason', id: calendarIds['Jason']}];
        
        for (const cal of targets) {
           try {
             const r = await calendar.events.list({ 
                 calendarId: cal.id, 
                 timeMin: new Date().toISOString(), 
                 maxResults: 10, 
                 singleEvents: true, 
                 orderBy: 'startTime' 
             });
             events.push(...r.data.items.map(e => ({
                 id: e.id, 
                 barber: cal.name, 
                 service: (e.summary||"").split(' - ')[0] || e.summary, 
                 clientName: (e.summary||"").split(' - ')[1] || "", 
                 dateTime: e.start.dateTime || e.start.date 
             })));
           } catch(e) {}
        }
        res.json(events);
    } catch (e) { res.json([]); }
});

// =================================================================
// 🚀 VAPI TOOL HANDLERS (The New Logic)
// =================================================================

// Tool 1: checkAvailability
app.post("/api/vapi/check-slots", async (req, res) => {
  try {
      // Vapi sends arguments inside message.toolCalls
      const toolCall = req.body.message.toolCalls[0];
      const { date, barber } = toolCall.function.arguments;
      
      console.log(`[VAPI] Checking slots for ${barber} on ${date}`);
      broadcast("log", `Checking calendar for ${barber} on ${date}...`);

      const calendarId = calendarIds[barber] || 'primary';
      const startOfDay = new Date(`${date}T09:00:00`);
      const endOfDay = new Date(`${date}T19:00:00`);

      const response = await calendar.events.list({
          calendarId,
          timeMin: startOfDay.toISOString(),
          timeMax: endOfDay.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
      });
      
      // Calculate BUSY times
      const busySlots = response.data.items.map(e => {
          const s = new Date(e.start.dateTime);
          const end = new Date(e.end.dateTime);
          return `${s.getHours()}:${s.getMinutes().toString().padStart(2,'0')} - ${end.getHours()}:${end.getMinutes().toString().padStart(2,'0')}`;
      });

      // Send result back to Vapi
      res.json({
          results: [{
              toolCallId: toolCall.id,
              result: JSON.stringify({ 
                  status: "success", 
                  busy_slots: busySlots,
                  info: "Shop is open 09:00 - 19:00" 
              })
          }]
      });
  } catch (error) {
      console.error("Vapi Check Error:", error);
      res.status(500).json({ error: error.message });
  }
});

// Tool 2: bookAppointment
app.post("/api/vapi/book", async (req, res) => {
  try {
      const toolCall = req.body.message.toolCalls[0];
      const { dateTime, duration, barber, service, clientName } = toolCall.function.arguments;

      console.log(`[VAPI] Booking ${clientName} with ${barber} at ${dateTime}`);
      broadcast("log", `Booking ${service} for ${clientName}...`);

      const calendarId = calendarIds[barber] || 'primary';
      const start = new Date(dateTime);
      const durationMins = duration || 30;
      const end = new Date(start.getTime() + durationMins * 60000);

      await calendar.events.insert({
          calendarId,
          resource: { 
              summary: `${service} - ${clientName}`, 
              description: `Vapi Booking: ${barber}`, 
              start: { dateTime: start.toISOString() }, 
              end: { dateTime: end.toISOString() } 
          }
      });

      // Notify Dashboard
      broadcast("appointment_update", { message: "Booked!" });

      res.json({
          results: [{
              toolCallId: toolCall.id,
              result: "success"
          }]
      });
  } catch (error) {
      console.error("Vapi Booking Error:", error);
      res.status(500).json({ error: error.message });
  }
});

// --- VAPI WEBHOOK (For Live Transcripts) ---
// You need to set this URL in Vapi Assistant Settings -> "Server URL"
app.post("/api/vapi/webhook", (req, res) => {
    const msg = req.body.message;
    
    // Check if it's a transcript message
    if (msg && msg.type === "transcript" && msg.transcriptType === "final") {
        broadcast("transcript", { 
            id: Date.now(), 
            speaker: msg.role === "assistant" ? "ai" : "user", 
            text: msg.transcript 
        });
    }
    
    res.sendStatus(200);
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Barbershop Vapi Backend running on port ${PORT}`);
});














