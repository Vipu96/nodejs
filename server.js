/**
 * Tesla Third-Party Proxy (Authorization Code / User Tokens)
 * ----------------------------------------------------------
 * Render-palvelin, joka vastaanottaa Cloudflarelta (tai muilta integraatioilta)
 * komennot ja välittää ne Tesla Fleet API:lle. Tämä versio olettaa, että
 * käytössä on kolmannen osapuolen (Third-Party) käyttäjäkohtaiset access tokenit.
 */

import express from "express";

const app = express();
app.use(express.json());

// 🌍 Tesla API -asetukset
// EU-alueelle Fleet API:n perusosoite on: https://fleet-api.prd.eu.vn.cloud.tesla.com
const REGION = process.env.TESLA_REGION || "eu";
const FLEET_API_BASE = `https://fleet-api.prd.${REGION}.vn.cloud.tesla.com`;

// 🧠 Yhtenäinen lokitus Render-logeihin
function log() {
  const parts = ["[TeslaThirdPartyProxy]"];
  for (let i = 0; i < arguments.length; i += 1) {
    parts.push(arguments[i]);
  }
  console.log.apply(console, parts);
}

// 🔐 Hakee bearer-tokenin bodysta tai Authorization-headerista
function extractAccessToken(req) {
  if (req.body && typeof req.body.token === "string") {
    const trimmed = req.body.token.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  const authHeader = req.headers && req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().indexOf("bearer ") === 0) {
    return authHeader.slice(7).trim();
  }

  return null;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return { data: JSON.parse(text), raw: text };
  } catch (err) {
    return { data: null, raw: text };
  }
}

/**
 * --- Ajoneuvolistaus / tokenin validointi ---
 * GET/POST /info
 * -----------------------------
 * Käytetään ajoneuvolistausten hakuun ja käyttäjätunnuksen kelpoisuuden tarkistamiseen.
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
    log("→ Fetching vehicles from Tesla:", url);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const parsed = await parseJsonResponse(response);
    const body = parsed.data || {};

    const hasBody = body && typeof body === "object" && Object.keys(body).length > 0;

    if (!response.ok) {
      log("❌ Tesla Fleet API error on /vehicles:", response.status, parsed.raw);
      const errorPayload = {
        error: body.error || body.message || "Tesla API HTTP error on /vehicles",
      };
      if (hasBody) {
        errorPayload.details = body;
      } else if (parsed.raw) {
        errorPayload.details = parsed.raw;
      }
      return res.status(response.status).json(errorPayload);
    }

    const vehicles = Array.isArray(body.response) ? body.response : [];
    log("✅ Vehicle list fetched. Count:", vehicles.length);

    return res.json({
      success: true,
      response: vehicles,
    });
  } catch (err) {
    log("⚠️ Server error on /info:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /command/:vehicleId/:command
 * Lähettää REST-komennon Tesla Fleet API:lle käyttäjän access_tokenilla.
 */
app.post("/command/:vehicleId/:command", async (req, res) => {
  const token = extractAccessToken(req);
  const rawVehicleId = req.params.vehicleId;
  const command = req.params.command;
  const params = req.body && typeof req.body === "object" ? req.body.params || {} : {};

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
          message: "VIN tai ajoneuvo-ID ei löytynyt Tesla Fleet API:n kautta. Varmista, että ajoneuvo on jaettu sovellukselle ja että tokenilla on oikeudet.",
          provided: rawVehicleId,
        },
      });
    }

    const url = `${FLEET_API_BASE}/api/1/vehicles/${vehicleId}/command/${command}`;
    log("→ Forwarding command to Tesla:", url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params || {}),
    });

    const parsed = await parseJsonResponse(response);
    const body = parsed.data || {};

    const hasBody = body && typeof body === "object" && Object.keys(body).length > 0;

    if (!response.ok) {
      log("❌ Tesla Fleet API command error:", response.status, parsed.raw);
      const errorPayload = {
        error: body.error || body.message || "Tesla API HTTP error",
      };
      if (hasBody) {
        errorPayload.details = body;
      } else if (parsed.raw) {
        errorPayload.details = parsed.raw;
      }
      return res.status(response.status).json(errorPayload);
    }

    const commandResult = body && body.response ? body.response.result === true : false;
    if (commandResult) {
      log("✅ Tesla command succeeded:", command);
    } else {
      log("⚠️ Tesla command responded with result=false:", parsed.raw);
    }

    return res.json({
      success: commandResult,
      command,
      vehicleId,
      response: body,
    });
  } catch (err) {
    log("⚠️ Server error on command:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Muuntaa VIN-koodin numeeriseksi ajoneuvo-ID:ksi. Jos syöte on jo numeerinen,
 * palautetaan se sellaisenaan. Muussa tapauksessa haetaan /vehicles -listaus
 * ja etsitään vastaava VIN-koodi.
 */
async function resolveVehicleId(vehicleIdentifier, token) {
  if (/^\d+$/.test(vehicleIdentifier)) {
    return vehicleIdentifier;
  }

  const vin = String(vehicleIdentifier || "").trim().toUpperCase();
  if (!vin) {
    return null;
  }

  const url = `${FLEET_API_BASE}/api/1/vehicles`;
  log("🔍 Resolving VIN via:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
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
    if (vehicleVin === vin) {
      if (vehicle.id) {
        log(`✅ VIN ${vin} resolved to vehicle id ${vehicle.id}`);
        return vehicle.id;
      }
    }
  }

  log(`⚠️ VIN ${vin} not found in Tesla vehicle list.`);
  return null;
}

/**
 * Health check endpoint
 */
app.get("/", function (_, res) {
  res.json({
    ok: true,
    service: "Tesla Render Proxy (Third-Party Tokens)",
    region: REGION,
    usage: {
      method: "POST /command/:vehicleId/:command",
      body: "{ token: '<access_token>', params: { /* command body */ } }",
      info: "GET/POST /info (token bodyn 'token'-kentässä tai Authorization-headerissa)",
    },
  });
});

// 🚀 Käynnistetään palvelin
const PORT = process.env.PORT || 10000;
app.listen(PORT, function () {
  log(`Server running on port ${PORT}`);
});
