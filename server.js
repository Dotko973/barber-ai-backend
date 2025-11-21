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
      callback(new Error('Not allowed by CORS'));
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
  "Джейсън": "primary" // potentially a second calendar ID
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
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  console.log(`Frontend connected: ${clientId}`);
  
  // Initial message
  res.write(`data: ${JSON.stringify({ type: "log", data: { message: "Connected to Backend Realtime Stream" } })}\n\n`);

  req.on("close", () => {
    console.log(`Frontend disconnected: ${clientId}`);
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// ===============================
// TWILIO INCOMING CALL (Route)
// ===============================
app.post("/incoming-call", (req, res) => {
  console.log("Incoming call received!");
  
  // Respond with TwiML to connect the call to our WebSocket stream
  const host = req.headers.host; 
  const twiml = `
    <Response>
      <Say language="bg-BG">Здравейте, свързвам ви с Ема, вашият AI асистент.</Say>
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

  // defined callbacks to send data to Frontend via SSE
  const onTranscript = (data) => broadcastToFrontend("transcript", data);
  const onLog = (data) => broadcastToFrontend("log", data);
  const onAppointmentsUpdate = () => broadcastToFrontend("appointment_update", { message: "New appointment booked!" });

  // Initialize Gemini Service
  const gemini = new GeminiService(
    onTranscript,
    onLog,
    onAppointmentsUpdate,
    oauth2Client,
    calendarIds
  );

  gemini.startSession(ws);

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.event === "media") {
        // Twilio sends base64 audio in data.media.payload
        const audioBuffer = Buffer.from(data.media.payload, "base64");
        gemini.handleAudio(audioBuffer);
      } 
      else if (data.event === "start") {
        console.log("Twilio Stream Started:", data.streamSid);
      }
      else if (data.event === "stop") {
        console.log("Twilio Stream Stopped");
        gemini.endSession();
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  });

  ws.on("close", () => {
    console.log("Twilio Media Stream Disconnected");
    gemini.endSession();
  });
});

// ===============================
// STANDARD API ROUTES
// ===============================
app.get("/", (req, res) => res.send("Barbershop AI Backend"));
app.get("/api", (req, res) => res.json({ status: "Backend is ready" }));

app.get("/api/test-calendar", async (req, res) => {
  if (calendar) res.json({ success: true, message: "Calendar service ready." });
  else res.status(500).json({ success: false, error: "Calendar not init." });
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

// IMPORTANT: Listen with 'server', not 'app', to support WebSockets
server.listen(PORT, () => {
  console.log(`✅ Barbershop backend running on port ${PORT}`);
});















