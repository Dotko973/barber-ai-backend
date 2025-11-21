import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

// Create Express app
const app = express();

// ----------------------------------------------------
// GLOBAL CORS CONFIG (Standard Library Fix)
// ----------------------------------------------------

const allowedOrigins = [
  "http://localhost:5173",                    // Your local frontend
  "https://excellent-range-296913.web.app",   // Firebase Hosting
  "https://excellent-range-296913.firebaseapp.com"
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, or server-to-server)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log("Blocked by CORS:", origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Essential for cookies/sessions if you use them
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Parse JSON bodies
app.use(bodyParser.json());

// Fix "__dirname" for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root route
app.get("/", (req, res) => {
  res.send("Barbershop backend running on Azure App Service");
});

// ✅ Health-check API root
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

// TEMP: Debug to verify environment variables
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
// SSE EVENTS ENDPOINT (Fixed)
// ===============================

app.get("/api/events", (req, res) => {
  // Global CORS middleware handles the Access-Control headers now.
  // We only set SSE specific headers here.

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Azure-specific: flush headers immediately to keep connection open
  if (res.flushHeaders) {
    res.flushHeaders();
  }

  const send = (payload) => {
    // Check if response is still writable before sending
    if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  // Initial log so the frontend knows SSE is connected
  send({
    type: "log",
    data: { message: "SSE stream connected." },
  });

  // Heartbeat to keep connection alive on Azure (every 25s)
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
        send({
            type: "log",
            data: { message: "heartbeat" },
        });
    }
  }, 25000);

  // Clean up on client disconnect
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















