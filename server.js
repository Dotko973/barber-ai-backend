import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

// Create Express app
const app = express();

// ----------------------------------------------------
// CORS CONFIG
// ----------------------------------------------------
const allowedOrigins = [
  "http://localhost:5173",
  "https://excellent-range-296913.web.app",
  "https://excellent-range-296913.firebaseapp.com",
];

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // allow everything (frontend dev mode & Azure)
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  // Required for some browsers
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  
  next();
});

// Handle preflight requests explicitly (good for Azure)
app.options("*", cors());

// Parse JSON bodies
app.use(bodyParser.json());

// Fix "__dirname" for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root route
app.get("/", (req, res) => {
  res.send("Barbershop backend running on Azure App Service");
});

// ✅ Health-check API root (Firebase / frontend proxy-friendly)
app.get("/api", (req, res) => {
  res.json({ status: "Barbershop backend running on Azure App Service" });
});

// ✅ GET ALL APPOINTMENTS (test route)
app.get("/api/appointments", (req, res) => {
  const sampleAppointments = [
    { id: 1, customerName: "John Doe", date: "2025-11-01", time: "10:00 AM" },
    { id: 2, customerName: "Jane Smith", date: "2025-11-02", time: "2:00 PM" },
  ];
  res.json(sampleAppointments);
});

// ===============================
// ⭐ GOOGLE CALENDAR AUTH SETUP
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

// TEMP: Debug to verify environment variables (remove later)
console.log("OAuth ENV CHECK:", {
  client_id: !!process.env.GOOGLE_CLIENT_ID,
  secret: !!process.env.GOOGLE_CLIENT_SECRET,
  refresh: !!process.env.GOOGLE_REFRESH_TOKEN,
  redirect: process.env.GOOGLE_REDIRECT_URI,
});

// ===============================
// TEST GOOGLE CALENDAR
// ===============================

app.get("/api/test-calendar", async (req, res) => {
  if (calendar) {
    res.json({ success: true, message: "Calendar service is ready." });
  } else {
    res
      .status(500)
      .json({ success: false, error: "Calendar service is not initialized." });
  }
});

// ===============================
// SSE EVENTS ENDPOINT
// ===============================

app.get("/api/events", (req, res) => {
  // CORS for SSE – global cors() has already run, but we add a safety net:
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // If available, flush headers immediately
  if (res.flushHeaders) {
    res.flushHeaders();
  }

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Initial log so the frontend knows SSE is connected
  send({
    type: "log",
    data: { message: "SSE stream connected." },
  });

  // Optional heartbeat to keep connection alive on Azure
  const heartbeat = setInterval(() => {
    send({
      type: "log",
      data: { message: "heartbeat" },
    });
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    res.end();
  });
});

// ===============================
// CREATE EVENT
// ===============================

app.post("/create-event", async (req, res) => {
  try {
    const { customerName, date, time } = req.body;
    if (!customerName || !date || !time) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const event = {
      summary: `Appointment with ${customerName}`,
      description: `Barbershop appointment for ${customerName}`,
      start: { dateTime: `${date}T${time}:00`, timeZone: "Europe/Sofia" },
      end: { dateTime: `${date}T${time}:00`, timeZone: "Europe/Sofia" },
    };

    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });

    res.json({ success: true, eventId: response.data.id });
  } catch (error) {
    console.error("Error creating event:", error);
    res.status(500).json({ error: "Failed to create event." });
  }
});

// ===============================
// CANCEL EVENT
// ===============================

app.post("/cancel-event", async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) {
      return res.status(400).json({ error: "Missing eventId." });
    }

    await calendar.events.delete({
      calendarId: "primary",
      eventId: eventId,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error canceling event:", error);
    res.status(500).json({ error: "Failed to cancel event." });
  }
});

// ===============================
// START SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `✅ Barbershop backend running on Azure App Service on port ${PORT}`
  );
});















