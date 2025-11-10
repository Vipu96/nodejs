/**
 * Tesla Third-Party Proxy (EU, Tesla HTTP proxy first, no legacy)
 * ---------------------------------------------------------------
 * - VIN -> Tesla Vehicle Command HTTP Proxy (allekirjoitus proxyn päässä)
 * - Tuetut proxyn reitit (dokumentoitu):
 *     1) POST /api/1/vehicles/:vin/commands/:command      (body = params)
 *     2) POST /api/1/vehicles/:vin/commands               (body = { command, parameters })
 * - Valinnainen: suora VCP (EU-alue) jos TESLA_ALLOW_DIRECT_VCP=true
 * - Ei legacy /command -fallbackia
 *
 * Cloudflare Worker kutsuu:
 *   POST /info                          { token }
 *   POST /command/:vehicleId/:command   { token, params }
 */

import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// Konfiguraatio (EU)
// -----------------------------------------------------------------------------
const REGION = "eu";
const FLEET_API_BASE = `https://fleet-api.prd.${REGION}.vn.cloud.tesla.com`;

// 👉 Aseta Renderissä TESLA_VCP_PROXY_BASE = https://<sinun vcp-proxy host>
// (Tämä on teslamotors/vehicle-command -instanssin URL, EI tämän Node-appin URL)
const VCP_PROXY_BASE = (process.env.TESLA_VCP_PROXY_BASE || "").trim().replace(/\/+$/, "");

// Salli suorat VCP-yritykset vain jos haluat (yleensä ei tarvita, proxy tekee allekirjoituksen)
const ALLOW_DIRECT_VCP = /^true$/i.test(process.env.TESLA_ALLOW_DIRECT_VCP || "");

// EU-only VCP hostit mahdolliseen fallbackiin
const FLEET_COMMAND_BASES = [
  FLEET_API_BASE, // joissain kokoonpanoissa VCP on datan hostissa
  "https://fleet-command.prd.eu.vn.cloud.tesla.com",
].map((u) => u.replace(/\/+$/, ""));

// -----------------------------------------------------------------------------
// Utilit
// -----------------------------------------------------------------------------
function log() {
  const parts = ["[TeslaThirdPartyProxy]"];
  for (let i = 0; i < arguments.length; i += 1) parts.push(arguments[i]);
  console.log.apply(console, parts);
}

function extractAccessToken(req) {
  if (req.body && typeof req.body.token === "string") {
    const trimmed = req.body.token.trim();
    if (trimmed) return trimmed;
  }
  const authHeader = req.headers?.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return null;
}

function extractCommandParams(body) {
  if (!body || typeof body !== "object") return {};
  if (body.params && typeof body.params === "object") return body.params;
  const params = {};
  for (const key in body) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (key === "token") continue;
    params[key] = body[key];
  }
  return params;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return { data: JSON.parse(text), raw: text };
  } catch {
    return { data: null, raw: text };
  }
}

function summarizeAttemptBody(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const limit = 512;
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}…`;
}

function attachAttempts(target, attempts, key = "attempts") {
  if (!attempts || !attempts.length) return target;
  const list = [];
  for (const a of attempts) {
    const entry = {};
    if (a?.url) entry.url = a.url;
    if (typeof a?.status === "number") entry.status = a.status;
    if (a?.networkError) entry.networkError = a.networkError;
    if (a?.body) entry.body = summarizeAttemptBody(a.body);
    if (Object.keys(entry).length > 0) list.push(entry);
  }
  if (list.length > 0) target[key] = list;
  return target;
}

function interpretCommandSuccess(body) {
  if (!body || typeof body !== "object") return false;
  const payload = typeof body.response === "object" && body.response !== null ? body.response : body;
  if (payload.result === true) return true;

  const statusFields = [payload.status, payload.state, payload.command_status];
  const positive = [
    "accepted", "acknowledged", "queued", "pending", "received",
    "in_progress", "executing", "sent", "success", "succeeded",
    "completed", "done"
  ];
  for (const v of statusFields) {
    if (typeof v === "string" && positive.includes(v.toLowerCase())) return true;
  }
  if (payload.command_id || payload.id) return true;
  return false;
}

/** Palauttaa { id, vin } — syöte voi olla VIN tai numeerinen id */
async function resolveVehicleRecord(vehicleIdentifier, token) {
  const maybeVin = String(vehicleIdentifier || "").trim().toUpperCase();
  const looksLikeVin = /^[A-HJ-NPR-Z0-9]{17}$/.test(maybeVin);

  const url = `${FLEET_API_BASE}/api/1/vehicles`;
  log("🔍 Resolving vehicle via:", url);

  const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  const parsed = await parseJsonResponse(response);
  if (!response.ok) {
    log("❌ /vehicles failed:", response.status, parsed.raw);
    return null;
  }

  const vehicles = Array.isArray(parsed.data?.response) ?
