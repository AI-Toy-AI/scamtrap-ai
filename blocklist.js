import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep the blocklist beside the existing monitoring data so both use the
// same persistent-disk location when Render's disk is mounted there.
const DATA_DIR = path.join(__dirname, "monitor-data");
const BLOCKLIST_FILE = path.join(DATA_DIR, "blocked-numbers.json");

function normalizeNumber(value) {
  const number = String(value || "").trim();
  // Only block explicit international-format phone numbers. Anonymous,
  // withheld, client identifiers, and malformed values are not blockable.
  if (!/^\+[1-9]\d{7,14}$/.test(number)) return null;
  return number;
}

function readBlocklist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(BLOCKLIST_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(BLOCKLIST_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.number === "string") : [];
  } catch (error) {
    console.error("ScamDecoy blocklist read error:", error.message);
    return [];
  }
}

function writeBlocklist(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = BLOCKLIST_FILE + ".tmp";
  fs.writeFileSync(temporaryFile, JSON.stringify(entries, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryFile, BLOCKLIST_FILE);
}

export function isBlockedNumber(value) {
  const number = normalizeNumber(value);
  if (!number) return false;
  return readBlocklist().some(entry => entry.number === number);
}

export function blockNumber(value, details = {}) {
  const number = normalizeNumber(value);
  if (!number) return false;

  try {
    const entries = readBlocklist();
    const existing = entries.find(entry => entry.number === number);
    if (existing) {
      existing.lastFlaggedAt = new Date().toISOString();
      if (details.reason) existing.reason = String(details.reason).slice(0, 240);
      if (details.callSid) existing.lastCallSid = String(details.callSid).slice(0, 80);
      writeBlocklist(entries);
      return true;
    }

    entries.push({
      number,
      blockedAt: new Date().toISOString(),
      lastFlaggedAt: new Date().toISOString(),
      reason: String(details.reason || "Flagged by ScamDecoy").slice(0, 240),
      callSid: details.callSid ? String(details.callSid).slice(0, 80) : null,
      source: String(details.source || "voice-agent").slice(0, 40)
    });
    writeBlocklist(entries);
    return true;
  } catch (error) {
    console.error("ScamDecoy blocklist write error:", error.message);
    return false;
  }
}
