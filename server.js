import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Root Route
app.get("/", (req, res) => {
  res.send("Server is updated and running!");
});

// Twilio Webhook - SIMPLE TEST
app.post("/incoming-call", (req, res) => {
  console.log("Call received - Sending Test Response");
  
  // We are NOT connecting to a Stream. 
  // We are just telling Twilio to speak text.
  const twiml = `
    <Response>
      <Say language="bg-BG">Системата е обновена успешно. Тестът работи.</Say>
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Simple Test Server running on port ${PORT}`);
});















