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

// Aseta Renderissä: TESLA_VCP_PROXY_BASE = https://<sinun vcp-proxy host>
// (Tämä on teslamotors/vehicle-command -instanssin URL, EI tämän Node-appin URL)
const VCP_PROXY_BASE = (process.env.TESLA_VCP_PROXY_BASE || "").trim().replace(/\/+$/, "");

// Salli suorat VCP-yritykset vain jos haluat (yleensä ei tarvita, proxy allekirjoittaa)
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
    "completed", "done",
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
// Reitit
// -----------------------------------------------------------------------------
app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "Tesla Render Proxy (Third-Party Tokens)",
    region: REGION,
    vcp_proxy: VCP_PROXY_BASE || null,
    allow_direct_vcp: ALLOW_DIRECT_VCP,
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
      details: "Lähetä Tesla access_token joko bodyn 'token'-kentässä tai Authorization: Bearer -headerissa.",
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
      details: "Tesla access_token puuttuu. Välitä token bodyn 'token'-kentässä tai Authorization-headerissa.",
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
// Komentien välitys: Tesla HTTP proxy (VIN). Valinnainen suora VCP (EU).
// -----------------------------------------------------------------------------
async function sendVehicleCommand({ vehicleId, vin, command, params, token }) {
  const requestId =
    typeof randomUUID === "function"
      ? randomUUID()
      : `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // --- 1) Tesla Vehicle Command HTTP proxy (VIN polussa) ---
  if (!VCP_PROXY_BASE) {
    return {
      ok: false,
      status: 400,
      errorPayload: {
        error: "TESLA_VCP_PROXY_BASE missing",
        details:
          "Aseta TESLA_VCP_PROXY_BASE osoittamaan tesla/vehicle-command -instanssiin (ei tähän Node-sovellukseen).",
      },
    };
  }

  const proxyAttempts = [];
  {
    const vinPath = encodeURIComponent(vin);
    const variants = [
      // 1) Dokumentoitu perusmuoto: body = params
      {
        url: `${VCP_PROXY_BASE}/api/1/vehicles/${vinPath}/commands/${encodeURIComponent(command)}`,
        body: params || {},
      },
      // 2) Dokumentoitu wrapper: body = { command, parameters }
      {
        url: `${VCP_PROXY_BASE}/api/1/vehicles/${vinPath}/commands`,
        body: { command, parameters: params || {} },
      },
    ];

    for (const v of variants) {
      log("→ Proxy try:", v.url, "payload:", JSON.stringify(v.body));
      let resp;
      try {
        resp = await fetch(v.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Tesla-Request-Id": requestId,
          },
          body: JSON.stringify(v.body),
        });
      } catch (err) {
        log("❌ Proxy network error:", v.url, err);
        proxyAttempts.push({ url: v.url, networkError: err?.message || String(err) });
        continue;
      }

      const parsed = await parseJsonResponse(resp);
      const body = parsed.data || {};
      proxyAttempts.push({ url: v.url, status: resp.status, body: parsed.raw });

      if (resp.status === 404) {
        log("ℹ️ Proxy 404 (route mismatch), trying next:", v.url);
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
            proxy_attempts: proxyAttempts,
          },
        };
      }

      const success = interpretCommandSuccess(body);
      if (success) {
        log("✅ Command accepted via Tesla HTTP proxy:", command, "requestId:", requestId);
      } else {
        log("⚠️ Proxy response did not explicitly signal success:", parsed.raw);
      }
      return { ok: true, status: resp.status, success, body };
    }
  }

  // --- 2) (Valinnainen) suora VCP vain jos sallittu ---
  if (!ALLOW_DIRECT_VCP) {
    const errorPayload = {
      error: "No matching proxy route",
      details: "Tesla HTTP proxy ei vastannut tunnetuilla reiteillä.",
      hint:
        "Onko TESLA_VCP_PROXY_BASE varmasti tesla/vehicle-command -instanssi? Testaa curl: /api/1/vehicles/:VIN/commands/:command.",
    };
    attachAttempts(errorPayload, proxyAttempts, "proxy_attempts");
    return { ok: false, status: 502, errorPayload };
  }

  const vcpAttempts = [];
  for (const base of FLEET_COMMAND_BASES) {
    const variants = [
      {
        url: `${base}/api/1/vehicles/${encodeURIComponent(
          vehicleId
        )}/commands/${encodeURIComponent(command)}`,
        body: { parameters: params || {} },
      },
      {
        url: `${base}/api/1/vehicles/${encodeURIComponent(vehicleId)}/commands`,
        body: { command, parameters: params || {} },
      },
    ];

    for (const t of variants) {
      log("→ Forwarding command via direct VCP (EU):", t.url, "payload:", JSON.stringify(t.body));
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
        attachAttempts(errorPayload, proxyAttempts, "proxy_attempts");
        attachAttempts(errorPayload, vcpAttempts, "vcp_attempts");
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

  const errorPayload = {
    error: "No matching proxy route and direct EU VCP failed",
    hint: "Varmista että VIN on polussa ja TESLA_VCP_PROXY_BASE osoittaa tesla/vehicle-command -palveluun.",
  };
  attachAttempts(errorPayload, proxyAttempts, "proxy_attempts");
  return { ok: false, status: 502, errorPayload };
}

// -----------------------------------------------------------------------------
// Käynnistys
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`, {
    region: REGION,
    vcp_proxy: VCP_PROXY_BASE || null,
    allow_direct_vcp: ALLOW_DIRECT_VCP,
  });
});
