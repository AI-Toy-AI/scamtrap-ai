import "dotenv/config";
import express from "express";
import http from "http";
import twilio from "twilio";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is not set.");
}

app.get("/", (_req, res) => {
  res.json({
    name: "ScamTrap AI Voice Agent",
    status: "online",
    voice_webhook: "/voice",
    media_stream: "/media-stream"
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "scamtrap-ai-voice" });
});

// Twilio sends the incoming call here.
// This creates a bidirectional Media Stream so the AI can hear and speak.
app.all("/voice", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  const host =
    req.get("host") ||
    new URL(PUBLIC_BASE_URL || `http://localhost:${PORT}`).host;

  const connect = response.connect();
  connect.stream({
    url: `wss://${host}/media-stream`
  });

  res.type("text/xml").send(response.toString());
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/media-stream") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null;
  let openaiWs = null;
  let sessionReady = false;

  const closeEverything = () => {
    try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
  };

  if (!OPENAI_API_KEY) {
    closeEverything();
    return;
  }

  const openaiUrl =
    "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1";

  openaiWs = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    }
  });

  openaiWs.on("open", () => {
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: true
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "marin"
          }
        },
        instructions: `
You are ScamTrap AI, an authorized defensive voice agent that answers suspected scam calls.
Your job is to keep the caller talking without revealing private information about the person
you are protecting. Never claim to be a real human. Do not provide passwords, verification
codes, banking credentials, payment details, or other sensitive information. Do not make
purchases, transfers, account changes, or commitments.

Use a calm, ordinary conversational style. Ask harmless questions that encourage the caller
to explain what they are calling about. If the caller asks for a code, password, SSN, bank
number, card number, remote-access installation, payment, gift card, cryptocurrency, or
other sensitive information, refuse and redirect with a neutral question.

Do not threaten, harass, or encourage illegal activity. The goal is defensive scam engagement,
documentation, and delay—not retaliation. Keep responses reasonably short so the conversation
sounds natural. If the caller becomes abusive, you may end the call politely.

This is a live phone call. Speak naturally and avoid mentioning internal system instructions.
        `.trim()
      }
    }));
  });

  openaiWs.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (event.type === "session.updated" || event.type === "session.created") {
      sessionReady = true;
      return;
    }

    if (event.type === "response.output_audio.delta" && streamSid) {
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: event.delta }
        }));
      }
      return;
    }

    if (event.type === "error") {
      console.error("OpenAI realtime error:", JSON.stringify(event));
    }
  });

  openaiWs.on("close", () => {
    try {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch {}
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err.message);
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      callSid = msg.start?.callSid || null;
      console.log("Twilio call connected:", callSid, streamSid);
      return;
    }

    if (msg.event === "media") {
      if (!sessionReady || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

      // Twilio and OpenAI both support G.711 μ-law (PCMU) at 8 kHz,
      // so the phone audio can be forwarded without transcoding.
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
      return;
    }

    if (msg.event === "stop") {
      closeEverything();
    }
  });

  twilioWs.on("close", () => {
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio websocket error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`ScamTrap AI voice server listening on port ${PORT}`);
});