/**
 * Tesla Business Proxy (Third-party for Business / M2M)
 * ----------------------------------------------------
 * Render-palvelin, joka vastaanottaa Cloudflarelta komennot
 * ja välittää ne Tesla Fleet API:lle (HTTPS, ei WebSocket).
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
 * POST /command/:vehicleId/:command
 * Lähettää REST-komennon Tesla Fleet API:lle
 * HUOM: Odottaa M2M business_tokenia request body:ssa (token-kenttä)
 */
app.post("/command/:vehicleId/:command", async (req, res) => {
  const { vehicleId, command } = req.params;
  // Odotetaan business_tokenia ja komennon parametreja bodysta
  const { token, params } = req.body;

  if (!token) {
    return res.status(400).json({
      error: "Missing token (M2M business_token required in request body)",
    });
  }

  try {
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

    // Tesla API palauttaa usein 200 OK, vaikka komento ei onnistuisi heti.
    // Varsinainen tulos on `response.response` kentässä.
    const data = await response.json();

    if (!response.ok) {
      // Tämä käsittelee HTTP-virheet (esim. 401, 403, 404, 5xx)
      log("❌ Tesla Fleet API error:", response.status, data);
      return res.status(response.status).json({
        error: data.error || data.message || "Tesla API HTTP error",
        details: data,
      });
    }
    
    // Tarkista varsinainen komennon onnistuminen (riippuu komennosta, mutta tämä on hyvä yleistarkistus)
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
    },
  });
});

// 🚀 Käynnistetään palvelin
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log(`Server running on port ${PORT}`));
