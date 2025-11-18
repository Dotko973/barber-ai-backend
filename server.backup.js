// =======================
// ✅ Imports & Setup
// =======================
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import twilio from "twilio";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import fetch from "node-fetch";
import { generateGeminiResponse } from "./geminiService.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// =======================
// ✅ Google Calendar Setup
// =======================
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

const auth = new GoogleAuth({
  scopes: SCOPES,
});

const calendar = google.calendar({ version: "v3", auth });

// Test endpoint for Google Calendar connection
app.get("/test-calendar", async (req, res) => {
  try {
    const calendarList = await calendar.calendarList.list();
    res.status(200).json({
      message: "Google Calendar connection works!",
      calendars: calendarList.data.items.map((c) => c.summary),
    });
  } catch (error) {
    console.error("❌ Google Calendar error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// =======================
// ✅ Twilio Voice Endpoint
// =======================
app.post("/twilio/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    console.log("📞 Incoming call received...");

    // Example: Simple dynamic AI logic
    const aiResponse = await generateGeminiResponse(
      "Incoming call to Barbershop AI. Provide a friendly greeting."
    );

    twiml.say(aiResponse);
    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("❌ Twilio Voice error:", error.message);
    twiml.say("Sorry, something went wrong.");
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// =======================
// ✅ Health Check
// =======================
app.get("/", (req, res) => {
  res.send("✅ Barbershop backend is running successfully!");
});

// =======================
// ✅ Server Initialization
// =======================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
});














