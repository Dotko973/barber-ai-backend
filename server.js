import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { WebSocketServer } from "ws";
import http from "http";
// Import the GeminiService class
import { GeminiService } from "./GeminiService.js"; 

// Create Express app
const app = express();
// Create HTTP server (needed for WebSockets)
const server = http.createServer(app);

// ----------------------------------------------------
// GLOBAL CORS CONFIG
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
      callback(null, true); // Allow all for testing if needed
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(bodyParser.json());
// Handle Twilio form data
app.use(bodyParser.urlencoded({ extended: false }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===============================
// GOOGLE CALENDAR AUTH
// ===============================
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// Define Calendar IDs (Replace with real IDs if you have multiple barbers)
const calendarIds = {
  "Мохамед": "primary", 
  "Джейсън": "primary" 
};

// ===============================
// SSE (Frontend Live Updates)
// ===============================
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

  // Initial message
  res.write(`data: ${JSON.stringify({ type: "log", data: { message: "Connected to Backend Realtime Stream" } })}\n\n`);

  req.on("close", () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// ===============================
// STANDARD API ROUTES
// ===============================
app.get("/", (req, res) => res.send("Barbershop Backend Running"));
app.get("/api", (req, res) => res.json({ status: "Backend is ready" }));

// 1. Test Calendar (Simple Check)
app.get("/api/test-calendar", async (req, res) => {
  console.log("Testing Calendar Connection...");
  try {
    const response = await calendar.calendarList.list();
    console.log("Calendar Connection Success");
    res.json({ success: true, message: "Google Calendar is connected!" });
  } catch (error) {
    console.error("Google Calendar Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Appointments List (For Dashboard)
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
        date: start.toLocaleDateString('bg-BG'),
        time: start.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })
      };
    });
    res.json(appointments);
  } catch (error) {
    console.error("Fetch Appointments Error:", error.message);
    res.json([]); // Return empty array instead of crashing
  }
});

// =================================================================
// 🔍 DEBUG ROUTE: MANUALLY TEST CALENDAR FLOW (Without Voice)
// =================================================================
app.get("/debug/test-calendar-flow", async (req, res) => {
  console.log("🔍 STARTING MANUAL CALENDAR TEST...");

  // 1. Mock the dependencies that GeminiService needs
  const mockCallback = (data) => console.log("Mock Callback:", JSON.stringify(data));
  
  // 2. Instantiate the Service manually
  const service = new GeminiService(
    mockCallback, // onTranscript
    mockCallback, // onLog
    mockCallback, // onAppointmentsUpdate
    oauth2Client, // Real OAuth Client
    calendarIds   // Real Barber IDs
  );

  try {
    // 3. TEST: Check Availability (for Today)
    const today = new Date().toISOString().split('T')[0];
    console.log(`Checking slots for ${today}...`);
    const slotsResult = await service.getAvailableSlots({ 
        date: today, 
        barber: "Мохамед" 
    });

    // 4. TEST: Book an Appointment (Right Now + 1 Hour)
    console.log("Attempting to book test appointment...");
    const testTime = new Date();
    testTime.setHours(testTime.getHours() + 1); // Book for 1 hour from now

    const bookingResult = await service.bookAppointment({
        dateTime: testTime.toISOString(),
        barber: "Мохамед",
        service: "DEBUG TEST CUT",
        clientName: "SYSTEM ADMIN"
    });

    // 5. Send Report to Browser
    res.json({
      status: "Test Complete",
      check_slots_result: slotsResult,
      booking_result: bookingResult,
      message: "Check your Google Calendar! You should see 'DEBUG TEST CUT' scheduled for 1 hour from now."
    });

  } catch (error) {
    console.error("Manual Test Failed:", error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// ===============================
// TWILIO INCOMING CALL (Route)
// ===============================
app.post("/incoming-call", (req, res) => {
  console.log("Incoming call received!");
  const host = req.headers.host; 
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${host}/connection" />
      </Connect>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

// ===============================
// WEBSOCKET SERVER (Twilio Audio Stream)
// ===============================
const wss = new WebSocketServer({ server, path: "/connection" });

wss.on("connection", (ws) => {
  console.log("Twilio Media Stream Connected");
  
  const gemini = new GeminiService(
    (d) => broadcastToFrontend("transcript", d),
    (d) => broadcastToFrontend("log", d),
    () => broadcastToFrontend("appointment_update", { message: "Booked!" }),
    oauth2Client, calendarIds
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
    } catch (error) { }
  });

  ws.on("close", () => gemini.endSession());
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`✅ Barbershop backend running on port ${PORT}`);
});















