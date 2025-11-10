/**
 * Tesla Third-Party Proxy (EU only, no legacy)
 * --------------------------------------------
 * - VIN -> Proxy (signed VCP), multiple route variants
 * - Fallback: direct VCP (EU hosts only)
 * - NO legacy /command fallback
 *
 * Cloudflare Worker calls:
 *   POST /info                          { token }
 *   POST /command/:vehicleId/:command   { token, params }
 */

import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// Configuration (EU only)
// -----------------------------------------------------------------------------
const REGION = "eu"; // lukittu EU:hun
const FLEET_API_BASE = `https://fleet-api.prd.${REGION}.vn.cloud.tesla.com`;
const VCP_PROXY_BASE = (process.env.TESLA_VCP_PROXY_BASE || process.env.TESLA_RENDER_PROXY || "").trim();

/** EU-only VCP host candidates for direct VCP fallback */
const FLEET_COMMAND_BASES = [
  FLEET_API_BASE, // joillain kokoonpanoilla VCP on datan hostissa
  "https://fleet-command.prd.eu.vn.cloud.tesla.com",
].map((u) => u.replace(/\/+$/, ""));

// -----------------------------------------------------------------------------
// Utils
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

function attachAttempts(target, attempts, key = "vcp_attempts") {
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
    "accepted","acknowledged","queued","pending","received","in_progress","executing",
    "sent","success","succeeded","completed","done"
  ];
  for (const v of statusFields) {
    if (typeof v === "string" && positive.includes(v.toLowerCase())) return true;
  }
  if (payload.command_id || payload.id) return true;
  return false;
}

/** Resolve to { id, vin } — input may be VIN or numeric id */
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

  const vehicles = Array.isArray(parsed.data?.response) ? parsed.data.response : [];
  for (const v of vehicles) {
    const vid = String(v?.id || "");
    const vvin = String(v?.vin || "").toUpperCase();
    if ((looksLikeVin && vvin === maybeVin) || (!looksLikeVin && vid === String(vehicleIdentifier))) {
      const rec = { id: vid, vin: vvin };
      log(`✅ Resolved vehicle: id=${rec.id} vin=${rec.vin}`);
      return rec;
    }
  }
  log("⚠️ Vehicle not found from list.");
  return null;
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "Tesla Render Proxy (Third-Party Tokens)",
    region: REGION,
    vcp_proxy: VCP_PROXY_BASE || null,
    usage: {
      info: "POST /info  { token: '<access_token>' }",
      command: "POST /command/:vehicleId/:command  { token: '<access_token>', params: { ... } }",
    },
  });
});

app.post("/info", async (req, res) => {
  const token = extractAccessToken(req);
  if (!token) {
    return res.status(400).json({
      error: "Missing token",
      details: "Lähetä Tesla access_token joko bodyn 'token'-kentässä tai Authorization: Bearer -headerissa."
    });
  }

  try {
    const url = `${FLEET_API_BASE}/api/1/vehicles`;
    log("→ Fetching vehicles from Tesla (EU):", url);

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const parsed = await parseJsonResponse(response);
    if (!response.ok) {
      log("❌ Fleet API error on /vehicles:", response.status, parsed.raw);
      const errorPayload = {
        error: parsed.data?.error || parsed.data?.message || "Tesla API HTTP error on /vehicles",
        details: parsed.data || parsed.raw,
      };
      return res.status(response.status).json(errorPayload);
    }

    const vehicles = Array.isArray(parsed.data?.response) ? parsed.data.response : [];
    log("✅ Vehicle list fetched. Count:", vehicles.length);
    return res.json({ success: true, response: vehicles });
  } catch (err) {
    log("⚠️ Server error on /info:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/command/:vehicleId/:command", async (req, res) => {
  const token = extractAccessToken(req);
  const rawVehicleIdOrVin = req.params.vehicleId;
  const command = req.params.command;
  const params = extractCommandParams(req.body);

  log(`➡️ Command received: /command/${rawVehicleIdOrVin}/${command}`);

  if (!token) {
    return res.status(400).json({
      error: "Missing token",
      details: "Tesla access_token puuttuu. Välitä token bodyn 'token'-kentässä tai Authorization-headerissa."
    });
  }

  try {
    const rec = await resolveVehicleRecord(rawVehicleIdOrVin, token);
    if (!rec) {
      return res.status(404).json({
        error: "Vehicle not found",
        details: { message: "VIN/ID ei löytynyt /vehicles-listauksesta.", provided: rawVehicleIdOrVin },
      });
    }

    const result = await sendVehicleCommand({ vehicleId: rec.id, vin: rec.vin, command, params, token });
    if (!result.ok) return res.status(result.status).json(result.errorPayload);

    return res.json({
      success: result.success,
      command,
      vehicleId: rec.id,
      vin: rec.vin,
      response: result.body,
    });
  } catch (err) {
    log("⚠️ Server error on command:", err);
    return res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Command forwarding: Proxy (VIN) -> Direct VCP (EU only). NO legacy.
// -----------------------------------------------------------------------------
async function sendVehicleCommand({ vehicleId, vin, command, params, token }) {
  const requestId = typeof randomUUID === "function"
    ? randomUUID()
    : `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // 1) Preferred: Tesla HTTP proxy (VIN in path, signed VCP on proxy)
  if (VCP_PROXY_BASE) {
    const base = VCP_PROXY_BASE.replace(/\/+$/, "");
    const vinPath = encodeURIComponent(vin);

    const proxyVariants = [
      { url: `${base}/api/1/vehicles/${vinPath}/commands/${encodeURIComponent(command)}`, body: params || {} },
      { url: `${base}/api/1/vehicles/${vinPath}/commands`, body: { command, parameters: params || {} } },
      { url: `${base}/vehicles/${vinPath}/commands/${encodeURIComponent(command)}`, body: params || {} },
      { url: `${base}/vehicles/${vinPath}/commands`, body: { command, parameters: params || {} } },
      { url: `${base}/api/1/vehicles/${vinPath}/command/${encodeURIComponent(command)}`, body: params || {} },
      { url: `${base}/vehicles/${vinPath}/command/${encodeURIComponent(command)}`, body: params || {} },
    ];

    for (const variant of proxyVariants) {
      log("→ Proxy try:", variant.url, "payload:", JSON.stringify(variant.body));
      let resp;
      try {
        resp = await fetch(variant.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Tesla-Request-Id": requestId,
          },
          body: JSON.stringify(variant.body),
        });
      } catch (err) {
        log("❌ Proxy network error:", variant.url, err);
        continue;
      }

      const parsed = await parseJsonResponse(resp);
      const body = parsed.data || {};

      if (resp.status === 404) {
        log("ℹ️ Proxy 404 (route mismatch), trying next:", variant.url);
        continue;
      }

      if (!resp.ok) {
        log("❌ Proxy error:", resp.status, parsed.raw);
        return {
          ok: false,
          status: resp.status,
          errorPayload: {
            error: body?.error || body?.message || "Tesla proxy HTTP error",
            details: body?.details || parsed.raw,
          },
        };
      }

      const success = interpretCommandSuccess(body);
      if (success) log("✅ Command accepted via signed VCP proxy:", command, "requestId:", requestId);
      else log("⚠️ Proxy response did not explicitly signal success:", parsed.raw);
      return { ok: true, status: resp.status, success, body };
    }

    log("ℹ️ All proxy variants returned 404 → falling back to direct VCP (EU only)");
  }

  // 2) Direct VCP (EU hosts only). No legacy fallback.
  const vcpAttempts = [];
  for (const base of FLEET_COMMAND_BASES) {
    const variants = [
      { url: `${base}/api/1/vehicles/${encodeURIComponent(vehicleId)}/commands/${encodeURIComponent(command)}`, body: { parameters: params || {} } },
      { url: `${base}/api/1/vehicles/${encodeURIComponent(vehicleId)}/commands`, body: { command, parameters: params || {} } },
    ];

    for (const t of variants) {
      log("→ Forwarding command via VCP (EU):", t.url, "payload:", JSON.stringify(t.body));
      let resp;
      try {
        resp = await fetch(t.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Tesla-Request-Id": requestId,
          },
          body: JSON.stringify(t.body),
        });
      } catch (err) {
        log("⚠️ VCP fetch error:", t.url, err);
        vcpAttempts.push({ url: t.url, networkError: err?.message || String(err) });
        continue;
      }

      const parsed = await parseJsonResponse(resp);
      const body = parsed.data || {};

      if (!resp.ok) {
        vcpAttempts.push({ url: t.url, status: resp.status, body: parsed.raw });
        if (resp.status === 404) {
          log("ℹ️ VCP 404 -> trying next EU variant:", t.url);
          continue;
        }
        const errorPayload = {
          error: body?.error || body?.message || "Tesla API HTTP error",
          details: body || parsed.raw,
        };
        attachAttempts(errorPayload, vcpAttempts);
        return { ok: false, status: resp.status, errorPayload };
      }

      const success = interpretCommandSuccess(body);
      if (success) {
        log("✅ Tesla command accepted via direct VCP (EU):", command, "requestId:", requestId);
      } else {
        log("⚠️ Tesla VCP response did not signal success explicitly:", parsed.raw);
      }
      return { ok: true, status: resp.status, success, body };
    }
  }

  // If we got here, proxy routes failed (404) and EU VCP didn’t succeed either.
  const errorPayload = { error: "No matching proxy route and direct EU VCP failed" };
  attachAttempts(errorPayload, [], "proxy_attempts"); // nothing collected for proxy 404-only
  return { ok: false, status: 502, errorPayload };
}

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`, { region: REGION, vcp_proxy: VCP_PROXY_BASE || null });
});
