/**
 * Tesla Third-Party Proxy (Authorization Code / User Tokens)
 * ----------------------------------------------------------
 * Render-palvelin, joka vastaanottaa Cloudflarelta (tai muilta integraatioilta)
 * komennot ja välittää ne Tesla Fleet API:lle EU-alueen VCP-päätteen kautta.
 * VAIN EU VCP. Ei alue-tunnistusta, ei legacy-fallbackia.
 */

import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

// 🌍 Tesla API -asetukset — lukittu EU VCP:hen
// Ei REGION-ympäristömuuttujaa, ei muita regioita.
const FLEET_API_BASE = "https://fleet-api.prd.eu.vn.cloud.tesla.com";

// 🧠 Yhtenäinen lokitus Render-logeihin
function log() {
  const parts = ["[TeslaThirdPartyProxy]"];
  for (let i = 0; i < arguments.length; i += 1) parts.push(arguments[i]);
  console.log.apply(console, parts);
}

// 🔐 Hakee bearer-tokenin bodysta tai Authorization-headerista
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

/**
 * --- Ajoneuvolistaus / tokenin validointi ---
 * GET/POST /info
 */
app.all("/info", async (req, res) => {
  const token = extractAccessToken(req);
  if (!token) {
    return res.status(400).json({
      error: "Missing token",
      details: "Lähetä Tesla access_token joko request bodyn 'token'-kentässä tai Authorization-headerissa."
    });
  }

  try {
    const url = `${FLEET_API_BASE}/api/1/vehicles`;
    log("→ Fetching vehicles from Tesla (EU VCP base):", url);

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const parsed = await parseJsonResponse(response);
    const body = parsed.data || {};
    const hasBody = body && typeof body === "object" && Object.keys(body).length > 0;

    if (!response.ok) {
      log("❌ Tesla Fleet API error on /vehicles:", response.status, parsed.raw);
      const errorPayload = {
        error: body.error || body.message || "Tesla API HTTP error on /vehicles",
        ...(hasBody ? { details: body } : parsed.raw ? { details: parsed.raw } : {})
      };
      return res.status(response.status).json(errorPayload);
    }

    const vehicles = Array.isArray(body.response) ? body.response : [];
    log("✅ Vehicle list fetched. Count:", vehicles.length);

    return res.json({ success: true, response: vehicles });
  } catch (err) {
    log("⚠️ Server error on /info:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /command/:vehicleId/:command
 * Lähettää REST-komennon Tesla Fleet API:lle (EU VCP) käyttäjän access_tokenilla.
 */
app.post("/command/:vehicleId/:command", async (req, res) => {
  const token = extractAccessToken(req);
  const rawVehicleId = req.params.vehicleId;
  const command = req.params.command;
  const params = extractCommandParams(req.body);

  log(`➡️ Command received: /command/${rawVehicleId}/${command} (EU VCP only)`);

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
          message:
            "VIN tai ajoneuvo-ID ei löytynyt Tesla Fleet API:n kautta. Varmista, että ajoneuvo on jaettu sovellukselle ja että tokenilla on oikeudet.",
          provided: rawVehicleId,
        },
      });
    }

    const result = await sendVehicleCommandEU({
      vehicleId,
      command,
      params,
      token,
    });

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

// 🔒 VAIN EU VCP; ei legacyä, ei alue-fallbackia
async function sendVehicleCommandEU({ vehicleId, command, params = {}, token }) {
  const requestId = typeof randomUUID === "function"
    ? randomUUID()
    : `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const vcpUrl = `${FLEET_API_BASE}/api/1/vehicles/${vehicleId}/commands`;
  const payload = { command, parameters: params };

  log("→ Forwarding command via EU VCP:", vcpUrl, "payload:", JSON.stringify(payload));

  const vcpResponse = await fetch(vcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Tesla-Request-Id": requestId,
    },
    body: JSON.stringify(payload),
  });

  const parsedVcp = await parseJsonResponse(vcpResponse);
  const vcpBody = parsedVcp.data || {};

  if (!vcpResponse.ok) {
    log("❌ Tesla EU VCP command error:", vcpResponse.status, parsedVcp.raw);
    const errorPayload = {
      error: (vcpBody && (vcpBody.error || vcpBody.message)) || "Tesla EU VCP HTTP error",
      ...(vcpBody && typeof vcpBody === "object" && Object.keys(vcpBody).length > 0
        ? { details: vcpBody }
        : parsedVcp.raw
        ? { details: parsedVcp.raw }
        : {}),
    };
    return { ok: false, status: vcpResponse.status, errorPayload };
  }

  const success = interpretCommandSuccess(vcpBody);
  if (success) {
    log("✅ Tesla command accepted via EU VCP:", command, "requestId:", requestId);
  } else {
    log("⚠️ Tesla EU VCP response did not signal success explicitly:", parsedVcp.raw);
  }
  return { ok: true, status: vcpResponse.status, success, body: vcpBody };
}

function interpretCommandSuccess(body) {
  if (!body || typeof body !== "object") return false;

  const payload = typeof body.response === "object" && body.response !== null ? body.response : body;
  if (payload.result === true) return true;

  const statusFields = [payload.status, payload.state, payload.command_status];
  for (let i = 0; i < statusFields.length; i += 1) {
    const value = statusFields[i];
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      if (
        normalized === "accepted" || normalized === "queued" || normalized === "pending" ||
        normalized === "in_progress" || normalized === "sent" || normalized === "success" ||
        normalized === "succeeded" || normalized === "completed" || normalized === "done"
      ) return true;
    }
  }
  if (payload.command_id || payload.id) return true;
  return false;
}

/**
 * VIN → vehicle id (numerical). Käyttää EU-pohjaa.
 */
async function resolveVehicleId(vehicleIdentifier, token) {
  if (/^\d+$/.test(vehicleIdentifier)) return vehicleIdentifier;

  const vin = String(vehicleIdentifier || "").trim().toUpperCase();
  if (!vin) return null;

  const url = `${FLEET_API_BASE}/api/1/vehicles`;
  log("🔍 Resolving VIN via (EU base):", url);

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  const parsed = await parseJsonResponse(response);
  const body = parsed.data || {};
  if (!response.ok) {
    log("❌ VIN resolution failed:", response.status, parsed.raw);
    return null;
  }

  const vehicles = Array.isArray(body.response) ? body.response : [];
  for (let i = 0; i < vehicles.length; i += 1) {
    const vehicle = vehicles[i] || {};
    const vehicleVin = String(vehicle.vin || "").toUpperCase();
    if (vehicleVin === vin && vehicle.id) {
      log(`✅ VIN ${vin} resolved to vehicle id ${vehicle.id}`);
      return vehicle.id;
    }
  }

  log(`⚠️ VIN ${vin} not found in Tesla vehicle list.`);
  return null;
}

/**
 * Health check
 */
app.get("/", function (_, res) {
  res.json({
    ok: true,
    service: "Tesla Render Proxy (Third-Party Tokens, EU VCP only)",
    region_locked: "eu",
    usage: {
      method: "POST /command/:vehicleId/:command",
      body: "{ token: '<access_token>', params: { /* command body */ } }",
      info: "GET/POST /info (token bodyn 'token'-kentässä tai Authorization-headerissa)",
    },
  });
});

// 🚀 Käynnistys
const PORT = process.env.PORT || 10000;
app.listen(PORT, function () {
  log(`Server running on port ${PORT}`);
});
