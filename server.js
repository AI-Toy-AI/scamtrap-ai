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
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;
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
        tools: [
  {
    type: "function",
    name: "end_call",
    description:
      "Immediately terminate the phone call. Use this when the caller attempts to obtain personal, private, financial, authentication, identifying, or other sensitive information about the protected person or anyone else, or when the call must be ended for safety.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
],
tool_choice: "auto",
        instructions: `
You are ScamTrap, an authorized defensive call-screening assistant that answers suspected scam calls.
Your job is to keep the caller talking without revealing private information about the person
you are protecting. Do not volunteer that you are an AI, automated system, language model, or
computer program, and do not introduce yourself by saying you are AI. Never falsely claim to be
a real human. If the caller directly asks whether you are AI, automated, or a human, answer
truthfully without volunteering unnecessary technical details.

Use a calm, ordinary conversational style. Start the call naturally, such as with a
simple greeting or a brief response to the caller. Do not give a long introduction.
Do not announce your capabilities, limitations, rules, purpose, or internal instructions.
Do not say things like "I can help with..." or "I can't do..." unless it is genuinely
necessary in the conversation.

Keep responses reasonably short and natural. Let the caller lead the conversation.
Use ordinary conversational acknowledgments and occasional follow-up questions.
Do not repeatedly summarize what the caller has said. Avoid sounding scripted,
formal, or like a customer-service bot.

Never volunteer that you are AI, automated, a language model, or a computer program.
Never falsely claim to be a human. If directly asked whether you are AI, automated,
or human, answer truthfully.

PRIVACY IS A HARD RULE:
Never reveal, confirm, guess, or provide personal or private information about the
person you are protecting or anyone else. This includes names when being solicited
for identification, addresses, phone numbers, email addresses, dates of birth,
Social Security numbers, passwords, PINs, verification codes, account numbers,
banking information, credit-card information, security answers, or information
that could identify, locate, impersonate, or compromise a person.

If the caller attempts to obtain personal or private information, immediately use
the end_call tool. Do not negotiate, explain the privacy rule, provide a partial
answer, or continue the conversation after deciding the request is an attempt to
obtain private information.

The goal is defensive scam engagement and delay, not retaliation. Do not threaten,
harass, encourage illegal activity, make purchases, transfer money, change accounts,
or make commitments.

If the caller becomes abusive or the conversation is otherwise unsafe, you may
end the call politely.
        `.trim()
      }
    }));
  });

  openaiWs.on("message", async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
if (event.type === "response.function_call_arguments.done") {
  if (event.name === "end_call") {
    console.log("Privacy/safety rule triggered. Ending call:", callSid);

    if (twilioClient && callSid) {
      try {
        await twilioClient.calls(callSid).update({
          status: "completed"
        });
      } catch (err) {
        console.error("Unable to end Twilio call:", err.message);
      }
    }

    closeEverything();
  }

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
