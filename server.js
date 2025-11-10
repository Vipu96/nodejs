/**
 * Tesla Third-Party Proxy -> Vehicle Command (VIN over your proxy)
 * ----------------------------------------------------------------
 * Tämä palvelin vastaanottaa Cloudflarelta (tai muilta integraatioilta)
 * pyynnöt ja välittää ne suoraan sinun Vehicle Command -proxylle:
 *   https://vehicle-command-08rv.onrender.com
 *
 * - /info  -> proxylle /api/1/vehicles (Bearer token)
 * - /command/:vehicleOrVin/:command -> proxylle /api/1/vehicles/:VIN/command/:command
 *
 * HUOM:
 *  - Vehicle Command -proxy odottaa VIN:iä polussa (ei numerista vehicle-id:tä).
 *    Jos asiakas lähettää numerisen id:n, tämä palvelin resolvaa VIN:in
 *    /api/1/vehicles -listauksen kautta (myös proxyn läpi).
 *  - Ei yritä suoraan Tesla Fleet API -hosteja, eikä käytä legacy /command -fallbackia.
 */

import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

// ---------------------------------------------------------------
// Asetukset
// ---------------------------------------------------------------
const REGION = process.env.TESLA_REGION?.trim() || "eu";
const VEHICLE_COMMAND_PROXY_BASE =
  (process.env.TESLA_VCP_PROXY_BASE ||
    process.env.TESLA_RENDER_PROXY ||
    "https://vehicle-command-08rv.onrender.com").replace(/\/+$/, "");

// Yhtenäinen lokitus
function log(...args) {
  console.log("[TeslaThirdPartyProxy]", ...args);
}

// Bearer-token headerista tai bodysta
function extractAccessToken(req) {
  if (req.body && typeof req.body.token === "string" && req.body.token.trim()) {
    return req.body.token.trim();
  }
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  return null;
}

// Erottele komennon parametrit (paitsi token)
function extractCommandParams(body) {
  if (!body || typeof body !== "object") return {};
  if (body.params && typeof body.params === "object") return body.params;
  const out = {};
  for (const k in body) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    if (k === "token") continue;
    out[k] = body[k];
  }
  return out;
}

// Vastauksen JSON -> {data, raw}
async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return { data: JSON.parse(text), raw: text };
  } catch {
    return { data: null, raw: text };
  }
}

// Tulkitse onnistuiko komento
function interpretCommandSuccess(body) {
  if (!body || typeof body !== "object") return false;
  const payload =
    typeof body.response === "object" && body.response !== null ? body.response : body;

  if (payload.result === true) return true;

  const fields = [payload.status, payload.state, payload.command_status];
  const okVals = [
    "accepted",
    "acknowledged",
    "queued",
    "pending",
    "received",
    "in_progress",
    "executing",
    "sent",
    "success",
    "succeeded",
    "completed",
    "done",
  ];
  for (const v of fields) {
    if (typeof v === "string" && okVals.includes(v.toLowerCase())) return true;
  }
  if (payload.command_id || payload.id) return true;
  return false;
}

// ---------------------------------------------------------------
// VIN-resolvaus proxyn läpi:
//  - jos syöte on VIN (17 merkkiä), palautetaan sellaisenaan
//  - jos syöte on numeroinen id, haetaan /api/1/vehicles ja etsitään VIN
// ---------------------------------------------------------------
async function resolveVin(vehicleOrVin, accessToken) {
  const maybe = String(vehicleOrVin || "").trim();
  const looksLikeVin = /^[A-HJ-NPR-Z0-9]{17}$/i.test(maybe);
  if (looksLikeVin) return maybe.toUpperCase();

  if (/^\d+$/.test(maybe)) {
    const url = `${VEHICLE_COMMAND_PROXY_BASE}/api/1/vehicles`;
    log("🔍 Resolving VIN via proxy:", url);

    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const parsed = await parseJsonResponse(resp);

    if (!resp.ok) {
      log("❌ /api/1/vehicles via proxy failed:", resp.status, parsed.raw);
      return null;
    }

    const vehicles = Array.isArray(parsed.data?.response) ? parsed.data.response : [];
    for (const v of vehicles) {
      if (String(v?.id || "") === maybe && v?.vin) {
        log(`✅ vehicle id ${maybe} resolved to VIN ${v.vin}`);
        return String(v.vin).toUpperCase();
      }
    }
    log("⚠️ Vehicle id not found in list.");
    return null;
  }

  // Muussa tapauksessa kelvoton
  return null;
}

// ---------------------------------------------------------------
// Reitit
// ---------------------------------------------------------------

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Tesla Render Proxy → Vehicle Command",
    region: REGION,
    proxy_base: VEHICLE_COMMAND_PROXY_BASE,
    usage: {
      info: "GET/POST /info   (Bearer <access_token> tai { token })",
      command:
        "POST /command/:vehicleOrVin/:command   body: { token: '<access_token>', params: { ... } }",
    },
  });
});

// Ajoneuvolistaus proxyn kautta
app.all("/info", async (req, res) => {
  const token = extractAccessToken(req);
  if (!token) {
    return res.status(400).json({
      error: "Missing token",
      details:
        "Lähetä Tesla access_token bodyn 'token'-kentässä tai Authorization: Bearer <token> -headerissa.",
    });
  }

  try {
    const url = `${VEHICLE_COMMAND_PROXY_BASE}/api/1/vehicles`;
    log("→ Fetching vehicles via Vehicle Command proxy:", url);

    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const parsed = await parseJsonResponse(resp);

    if (!resp.ok) {
      log("❌ Proxy /vehicles error:", resp.status, parsed.raw);
      return res.status(resp.status).json({
        error: parsed.data?.error || parsed.data?.message || "Proxy HTTP error on /vehicles",
        details: parsed.data || parsed.raw,
      });
    }

    const vehicles = Array.isArray(parsed.data?.response) ? parsed.data.response : [];
    log("✅ Vehicle list via proxy. Count:", vehicles.length);
    return res.json({ success: true, response: vehicles });
  } catch (err) {
    log("⚠️ Server error on /info:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Komennot VIN:lle proxyn kautta
app.post("/command/:vehicleOrVin/:command", async (req, res) => {
  const token = extractAccessToken(req);
  const vehicleOrVin = req.params.vehicleOrVin;
  const command = req.params.command;
  const params = extractCommandParams(req.body);

  log(`➡️ Command received: /command/${vehicleOrVin}/${command}`);

  if (!token) {
    return res.status(400).json({
      error: "Missing token",
      details:
        "Tesla access_token puuttuu. Välitä token bodyn 'token'-kentässä tai Authorization-headerissa.",
    });
  }

  try {
    const vin = await resolveVin(vehicleOrVin, token);
    if (!vin) {
      return res.status(404).json({
        error: "Vehicle not found",
        details: {
          message:
            "VIN/ID ei löytynyt proxyn /api/1/vehicles -listauksesta. Varmista oikeudet ja ajoneuvon jakaminen.",
          provided: vehicleOrVin,
        },
      });
    }

    const result = await sendViaVehicleCommandProxy({
      vin,
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
      vin,
      response: result.body,
    });
  } catch (err) {
    log("⚠️ Server error on command:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Lähetys Vehicle Command -proxylle (vain VIN-reitit)
// ---------------------------------------------------------------
async function sendViaVehicleCommandProxy({ vin, command, params, token }) {
  const requestId =
    typeof randomUUID === "function"
      ? randomUUID()
      : `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const base = VEHICLE_COMMAND_PROXY_BASE;
  const vinPath = encodeURIComponent(vin);
  const variants = [
    // Suora /command/:cmd
    {
      url: `${base}/api/1/vehicles/${vinPath}/command/${encodeURIComponent(command)}`,
      body: Object.keys(params || {}).length ? params : {},
    },
    // Vaihtoehtoinen /commands runko
    {
      url: `${base}/api/1/vehicles/${vinPath}/commands`,
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
      continue;
    }

    const parsed = await parseJsonResponse(resp);
    const body = parsed.data || {};

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
          error: body?.error || body?.message || "Vehicle Command proxy HTTP error",
          details: body || parsed.raw,
        },
      };
    }

    const success = interpretCommandSuccess(body);
    if (success) log("✅ Command accepted via Vehicle Command proxy:", command, "requestId:", requestId);
    else log("⚠️ Proxy response did not explicitly signal success:", parsed.raw);

    return { ok: true, status: resp.status, success, body };
  }

  // Molemmat variantit epäonnistuivat
  return {
    ok: false,
    status: 502,
    errorPayload: { error: "No matching route on Vehicle Command proxy" },
  };
}

// ---------------------------------------------------------------
// Start
// ---------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`, {
    region: REGION,
    proxy_base: VEHICLE_COMMAND_PROXY_BASE,
  });
});
