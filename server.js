/**
 * Tesla Third-Party Proxy (Authorization Code / User Tokens)
 * ----------------------------------------------------------
 * Render-palvelin, joka vastaanottaa Cloudflarelta (tai muilta integraatioilta)
 * komennot ja välittää ne Teslan Vehicle Command -proxyyn (allekirjoitus TESLA_PRIVATE_KEY:llä)
 * tai suoraan Teslan Fleet/VCP-päätepisteisiin fallbackina.
 *
 * Yhteensopiva Cloudflare Worker -rajapinnan kanssa:
 *   POST /info                   { token }
 *   POST /command/:vehicleId/:command   { token, params }
 *
 * Ympäristömuuttujat (Render):
 *   TESLA_REGION=eu | na (oletus: eu)
 *   TESLA_VCP_PROXY_BASE=https://vcp-proxy.onrender.com   <-- SUOSITELTU (allekirjoittaa VCP:n)
 *   TESLA_COMMAND_BASES=comma,separated,override-hosts     <-- valinnainen (suorat VCP-yritykset)
 *   TESLA_COMMAND_BASE=single-host-override                 <-- valinnainen
 *   TESLA_DOMAIN=myspot.fi                                  <-- valinnainen (health/info)
 *
 * HUOM: Allekirjoitus tehdään Vehicle Command HTTP proxyssä,
 * johon on asennettu TESLA_PRIVATE_KEY (ECDSA P-256). Tämä noudattaa Teslan ohjetta.
 */

import express from "express";
import { randomUUID } from "crypto";

// -----------------------------------------------------------------------------
// Peruskonfiguraatio
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json());

const REGION = (process.env.TESLA_REGION || "eu").trim();
const FLEET_API_BASE = `https://fleet-api.prd.${REGION}.vn.cloud.tesla.com`;
const VCP_PROXY_BASE = (process.env.TESLA_VCP_PROXY_BASE || process.env.TESLA_RENDER_PROXY || "").trim();
const FLEET_COMMAND_BASES = buildFleetCommandBaseList();

// -----------------------------------------------------------------------------
// Apufunktiot
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
  const authHeader = req.headers && req.headers.authorization;
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

function buildFleetCommandBaseList() {
  const bases = [];
  const explicitList = process.env.TESLA_COMMAND_BASES;
  if (explicitList && typeof explicitList === "string") {
    explicitList.split(/[,\s]+/).forEach((c) => c && bases.push(c.trim()));
  }
  const override = (process.env.TESLA_COMMAND_BASE || "").trim();
  if (override) bases.push(override);

  // Fallbackit: data-host + tunnetut command-hostit
  bases.push(FLEET_API_BASE);
  bases.push(`https://fleet-command.prd.${REGION}.vn.cloud.tesla.com`);
  bases.push("https://fleet-command.prd.vn.cloud.tesla.com");
  bases.push("https://fleet-command.vn.cloud.tesla.com");
  if (REGION !== "na") bases.push("https://fleet-command.prd.na.vn.cloud.tesla.com");
  if (REGION !== "eu") bases.push("https://fleet-command.prd.eu.vn.cloud.tesla.com");

  // Normalisoi
  const normalized = [];
  for (const b of bases) {
    const candidate = (b || "").trim();
    if (!candidate) continue;
    const prefixed = candidate.startsWith("http") ? candidate : `https://${candidate}`;
    const cleaned = prefixed.replace(/\/+$/, "");
    if (!normalized.includes(cleaned)) normalized.push(cleaned);
  }
  log("Fleet command base candidates:", normalized.join(", "));
  return normalized;
}

function summarizeAttemptBody(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const limit = 512;
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}…`;
}

function attachVcpAttempts(target, attempts) {
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
  if (list.length > 0) target.vcp_attempts = list;
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

async function resolveVehicleId(vehicleIdentifier, token) {
  if (/^\d+$/.test(String(vehicleIdentifier))) return String(vehicleIdentifier);

  const vin = String(vehicleIdentifier || "").trim().toUpperCase();
  if (!vin) return null;

  const url = `${FLEET_API_BASE}/api/1/vehicles`;
  log("🔍 Resolving VIN via:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  const parsed = await parseJsonResponse(response);
  if (!response.ok) {
    log("❌ VIN resolution failed:", response.status, parsed.raw);
    return null;
  }

  const vehicles = Array.isArray(parsed.data?.response) ? parsed.data.response : [];
  for (const v of vehicles) {
    const vehicleVin = String(v?.vin || "").toUpperCase();
    if (vehicleVin === vin && v?.id) {
      log(`✅ VIN ${vin} resolved to vehicle id ${v.id}`);
      return v.id;
    }
  }
  log(`⚠️ VIN ${vin} not found in Tesla vehicle list.`);
  return null;
}

// -----------------------------------------------------------------------------
// Reitit
// -----------------------------------------------------------------------------

/**
 * Health check
 */
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

/**
 * --- Ajoneuvolistaus / tokenin validointi ---
 * POST /info   body: { token }
 */
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
    log("→ Fetching vehicles from Tesla:", url);

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const parsed = await parseJsonResponse(response);
    if (!response.ok) {
      log("❌ Tesla Fleet API error on /vehicles:", response.status, parsed.raw);
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

/**
 * --- Komento ---
 * POST /command/:vehicleId/:command
 * body: { token: '<access_token>', params: { ... } }
 */
app.post("/command/:vehicleId/:command", async (req, res) => {
  const token = extractAccessToken(req);
  const rawVehicleId = req.params.vehicleId;
  const command = req.params.command;
  const params = extractCommandParams(req.body);

  log(`➡️ Command received: /command/${rawVehicleId}/${command}`);

  if (!token) {
    return res.status(400).json({
      error: "Missing token",
      details: "Tesla access_token puuttuu. Välitä token bodyn 'token'-kentässä tai Authorization-headerissa."
    });
  }

  try {
    const vehicleId = await resolveVehicleId(rawVehicleId, token);
    if (!vehicleId) {
      return res.status(404).json({
        error: "Vehicle not found",
        details: {
          message: "VIN tai ajoneuvo-ID ei löytynyt /vehicles-listauksesta. Varmista jakaminen ja oikeudet.",
          provided: rawVehicleId,
        },
      });
    }

    const result = await sendVehicleCommand({ vehicleId, command, params, token });
    if (!result.ok) {
      return res.status(result.status).json(result.errorPayload);
    }
    return res.json({
      success: result.success,
      command,
      vehicleId,
      response: result.body,
    });
  } catch (err) {
    log("⚠️ Server error on command:", err);
    return res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Komentojen välitys: Proxy (allekirjoitettu VCP) -> suora VCP -> legacy
// -----------------------------------------------------------------------------
async function sendVehicleCommand({ vehicleId, command, params, token }) {
  const requestId = typeof randomUUID === "function"
    ? randomUUID()
    : `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // 1) SUOSITELTU: Tesla Vehicle Command HTTP proxy (allekirjoitus TESLA_PRIVATE_KEY:llä)
  if (VCP_PROXY_BASE) {
    const proxyUrl = `${VCP_PROXY_BASE.replace(/\/+$/, "")}/api/1/vehicles/${encodeURIComponent(
      vehicleId
    )}/command/${encodeURIComponent(command)}`;

    log("→ Forwarding command to Tesla HTTP proxy (signed VCP):", proxyUrl, "payload:", JSON.stringify(params || {}));

    let proxyResp;
    try {
      proxyResp = await fetch(proxyUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Tesla-Request-Id": requestId,
        },
        body: JSON.stringify(params || {}),
      });
    } catch (err) {
      log("❌ Proxy fetch error:", err);
      return {
        ok: false,
        status: 502,
        errorPayload: { error: "Tesla proxy fetch failed", details: { message: err?.message || String(err) } },
      };
    }

    const parsed = await parseJsonResponse(proxyResp);
    const body = parsed.data || {};
    if (!proxyResp.ok) {
      log("❌ Proxy error:", proxyResp.status, parsed.raw);
      return {
        ok: false,
        status: proxyResp.status,
        errorPayload: {
          error: body?.error || body?.message || "Tesla proxy HTTP error",
          details: body?.details || parsed.raw,
        },
      };
    }

    const success = interpretCommandSuccess(body);
    if (success) {
      log("✅ Command accepted via signed VCP proxy:", command, "requestId:", requestId);
    } else {
      log("⚠️ Proxy response did not explicitly signal success:", parsed.raw);
    }
    return { ok: true, status: proxyResp.status, success, body };
  }

  // 2) Suorat VCP-yritykset (ilman allekirjoitusta) – usein 404/403 jos allekirjoitusta vaaditaan
  const vcpAttempts = [];
  for (const base of FLEET_COMMAND_BASES) {
    const variants = [
      { url: `${base}/api/1/vehicles/${vehicleId}/commands/${encodeURIComponent(command)}`, body: { parameters: params || {} } },
      { url: `${base}/api/1/vehicles/${vehicleId}/commands`, body: { command, parameters: params || {} } },
    ];

    for (const t of variants) {
      log("→ Forwarding command via VCP:", t.url, "payload:", JSON.stringify(t.body));
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
        log("⚠️ Tesla VCP command fetch error:", t.url, err);
        vcpAttempts.push({ url: t.url, networkError: err?.message || String(err) });
        continue;
      }
      const parsed = await parseJsonResponse(resp);
      const body = parsed.data || {};

      if (!resp.ok) {
        vcpAttempts.push({ url: t.url, status: resp.status, body: parsed.raw });
        if (resp.status === 404) {
          log("ℹ️ VCP endpoint 404 -> trying next variant:", t.url);
          continue;
        }
        log("❌ Tesla VCP command error:", resp.status, parsed.raw);
        const errorPayload = {
          error: body?.error || body?.message || "Tesla API HTTP error",
          details: body || parsed.raw,
        };
        attachVcpAttempts(errorPayload, vcpAttempts);
        return { ok: false, status: resp.status, errorPayload };
      }

      const success = interpretCommandSuccess(body);
      if (success) {
        log("✅ Tesla command accepted via VCP:", command, "requestId:", requestId);
      } else {
        log("⚠️ Tesla VCP response did not signal success explicitly:", parsed.raw);
      }
      return { ok: true, status: resp.status, success, body };
    }
  }

  // 3) Legacy fallback (ei allekirjoitusta, ei kaikissa ympäristöissä käytettävissä)
  const legacyUrl = `${FLEET_API_BASE}/api/1/vehicles/${vehicleId}/command/${encodeURIComponent(command)}`;
  log("ℹ️ VCP endpoints unavailable, falling back to legacy:", legacyUrl);

  let legacyResponse;
  try {
    legacyResponse = await fetch(legacyUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(params || {}),
    });
  } catch (err) {
    log("❌ Tesla legacy command fetch error:", err);
    const errorPayload = { error: "Tesla legacy command fetch failed", details: { message: err?.message || String(err) } };
    attachVcpAttempts(errorPayload, vcpAttempts);
    return { ok: false, status: 502, errorPayload };
  }

  const parsedLegacy = await parseJsonResponse(legacyResponse);
  const legacyBody = parsedLegacy.data || {};
  if (!legacyResponse.ok) {
    log("❌ Tesla legacy command error:", legacyResponse.status, parsedLegacy.raw);
    const errorPayload = {
      error: legacyBody?.error || legacyBody?.message || "Tesla API HTTP error",
      details: legacyBody || parsedLegacy.raw,
    };
    attachVcpAttempts(errorPayload, vcpAttempts);
    return { ok: false, status: legacyResponse.status, errorPayload };
  }

  const success = interpretCommandSuccess(legacyBody);
  if (success) log("✅ Tesla command succeeded via legacy endpoint:", command);
  else log("⚠️ Tesla legacy response did not signal success explicitly:", parsedLegacy.raw);

  return { ok: true, status: legacyResponse.status, success, body: legacyBody };
}

// -----------------------------------------------------------------------------
// Käynnistys
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`, { region: REGION, vcp_proxy: VCP_PROXY_BASE || null });
});
