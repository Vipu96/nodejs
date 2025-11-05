/**
 * Tesla Business Proxy (Third-party for Business / M2M)
 * ----------------------------------------------------
 * Render-palvelin, joka vastaanottaa Cloudflarelta komennot
 * ja välittää ne Tesla Fleet API:lle (HTTPS, ei WebSocket).
 * * HUOM: Tämä versio käyttää app.all() tukeakseen tokenin välitystä bodyssä /info-reitille.
 */

import express from "express";

const app = express();
app.use(express.json());

// 🌍 Tesla API -asetukset
// EU-alueelle Fleet API:n perusosoite on: https://fleet-api.prd.eu.vn.cloud.tesla.com
const REGION = process.env.TESLA_REGION || "eu";
// KORJAUS: Lisätty .vn.cloud osoitteeseen DNS-resoluutio-ongelmien korjaamiseksi.
const FLEET_API_BASE = `https://fleet-api.prd.${REGION}.vn.cloud.tesla.com`;

// 🧠 Pieni log-funktio Renderin logeihin
function log(...args) {
  console.log("[TeslaBusinessProxy]", ...args);
}

/**
 * --- TÄRKEÄ TESTIREITTI ---
 * GET/POST /info
 * -----------------------------
 * Käytetään ajoneuvolistausten hakuun ja M2M-tunnuksen kelpoisuuden tarkistamiseen.
 * Ottaa M2M business_tokenin suoraan request body:sta (token-kenttä).
 */
app.all("/info", async (req, res) => { // Käytetään app.all() hyväksymään GET JA POST
  // Odotetaan business_tokenia request body:sta.
  const { token } = req.body; 

  if (!token) {
     return res.status(400).json({
       error: "Missing token (M2M business_token required in request body)",
       details: "Käytä Cloudflare Workerin /api/proxy/info -reittiä, joka lisää tokenin automaattisesti."
     });
   }
  
  try {
    // API kutsu ajoneuvolistaan
    const url = `${FLEET_API_BASE}/api/1/vehicles`;
    log("→ Sending GET request for vehicle list to Tesla:", url);

    const response = await fetch(url, {
      method: "GET", // Tesla API:lle itse kutsu on GET
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      log("❌ Tesla Fleet API error on /vehicles:", response.status, data);
      return res.status(response.status).json({
        error: data.error || data.message || "Tesla API HTTP error on /vehicles",
        details: data,
      });
    }

    log("✅ Vehicle list successful. Found:", data.response.length, "vehicles.");
    res.json({
      success: true,
      response: data.response,
      // TÄRKEÄ: Jokaisella ajoneuvolla pitäisi olla numeerinen "id" jota käytetään /command-reitissä
    });
  } catch (err) {
    log("⚠️ Server error on /info:", err);
    res.status(500).json({ error: err.message });
  }
});


/**
 * POST /command/:vehicleId/:command
 * Lähettää REST-komennon Tesla Fleet API:lle
 * HUOM: Odottaa M2M business_tokenia request body:ssa (token-kenttä)
 */
app.post("/command/:vehicleId/:command", async (req, res) => {
  const { vehicleId: rawVehicleId, command } = req.params;
  // Odotetaan business_tokenia ja komennon parametreja bodysta
  const { token, params } = req.body;

  log(`➡️ Vastaanotettu komento Renderissä: /command/${rawVehicleId}/${command}`); // LOKITUS RENDER-PUOLELLA

  if (!token) {
    return res.status(400).json({
      error: "Missing token (M2M business_token required in request body)",
    });
  }

  try {
    // Selvitetään numeerinen ajoneuvo-ID. Jos polussa oleva ID näyttää VIN-koodilta,
    // haetaan vastaava numeerinen id erillisellä /vehicles -pyynnöllä.
    const vehicleId = await resolveVehicleId(rawVehicleId, token);
    if (!vehicleId) {
      return res.status(404).json({
        error: "Vehicle not found",
        details: {
          message:
            "VIN tai ajoneuvo-ID ei löytynyt Tesla Fleet API:n kautta. Varmista, että ajoneuvo on jaettu sovellukselle.",
          provided: rawVehicleId,
        },
      });
    }

    const url = `${FLEET_API_BASE}/api/1/vehicles/${vehicleId}/command/${command}`;
    log("→ Sending command to Tesla:", url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        // Tunnus otetaan bodysta ja välitetään Authorization-headerissa
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // Komennot Teslalle ovat aina POST-pyyntöjä, joilla on usein tyhjä tai täytetty body.
      body: JSON.stringify(params || {}),
    });

    const data = await response.json();

    if (!response.ok) {
      // Tämä käsittelee HTTP-virheet (esim. 401, 403, 404, 5xx)
      log("❌ Tesla Fleet API error:", response.status, data);
      return res.status(response.status).json({
        error: data.error || data.message || "Tesla API HTTP error",
        details: data,
      });
    }
    
    const commandSuccess = data.response?.result === true;
    
    if (commandSuccess) {
        log("✅ Tesla command successful:", command);
    } else {
         // Jos HTTP-status on 200, mutta komennon tulos on epäonnistunut
        log("⚠️ Tesla command result failed (HTTP 200 but result: false):", command, data);
    }


    res.json({
      success: commandSuccess,
      command,
      vehicleId,
      response: data,
    });
  } catch (err) {
    log("⚠️ Server error:", err);
    res.status(500).json({ error: err.message });
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

  const vin = String(vehicleIdentifier).trim().toUpperCase();
  if (!vin) {
    return null;
  }

  const url = `${FLEET_API_BASE}/api/1/vehicles`;
  log("🔍 Resolving VIN to vehicle id via:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log("❌ VIN resolution failed:", response.status, errorBody);
    return null;
  }

  const data = await response.json();
  const vehicles = data?.response || [];
  const match = vehicles.find((vehicle) => {
    if (!vehicle) return false;
    const vehicleVin = String(vehicle.vin || "").toUpperCase();
    return vehicleVin === vin;
  });

  if (match?.id) {
    log(`✅ VIN ${vin} resolved to vehicle id ${match.id}`);
    return match.id;
  }

  log(`⚠️ VIN ${vin} not found in vehicle list.`);
  return null;
}

/**
 * Health check endpoint
 */
app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "Tesla Render Proxy (Third-party for Business)",
    region: REGION,
    usage: {
      method: "POST /command/:vehicleId/:command",
      body: "{ token: '<business_token>', params: { /* command body */ } }",
      info: "GET/POST /info (käytä Cloudflare Workerin /api/proxy/info -reittiä)",
    },
  });
});

// 🚀 Käynnistetään palvelin
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log(`Server running on port ${PORT}`));
