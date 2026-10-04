# ScamTrap AI — live phone agent

This service connects a Twilio Voice number to the OpenAI Realtime API.

Architecture:

Twilio phone number
  -> POST /voice
  -> <Connect><Stream>
  -> wss://.../media-stream
  -> OpenAI Realtime
  -> audio back to Twilio

Twilio Media Streams use G.711 μ-law at 8 kHz, and the OpenAI Realtime API supports
PCMU at 8 kHz, so this implementation forwards the audio without an intermediate
transcoder.

## 1. Deploy

Deploy this folder as a Node web service on Render.

Set these environment variables:

OPENAI_API_KEY = your OpenAI API key
PUBLIC_BASE_URL = your Render URL, for example:
https://scamtrap-ai-voice.onrender.com

Do not put the OpenAI key in browser code, GitHub source, or the Twilio console.

## 2. Configure Twilio

For the Twilio phone number:

Voice configuration -> A call comes in -> Webhook

Use:
https://YOUR-RENDER-URL/voice

Method:
POST

Save.

## 3. Test

Call the Twilio number from a different phone.

The agent should answer and have a live speech conversation.

## Important

This is a defensive scam-screening prototype. It should not request, collect, or
store passwords, verification codes, banking credentials, SSNs, card numbers, or other
sensitive information. Before production use, add authentication, call logging controls,
Twilio signature validation, abuse/rate limits, monitoring, and a clear caller disclosure
policy appropriate to the jurisdictions where the service operates.
