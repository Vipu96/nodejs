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
const REGION = process.env.TESLA_REGION || "eu";
const FLEET_API_BASE = `https://fleet-api.prd.${REGION}.tesla.com`;

// 🧠 Pieni log-funktio Renderin logeihin
function log(...args) {
  console.log("[TeslaBusinessProxy]", ...args);
}

/**
 * POST /command/:vehicleId/:command
 * Lähettää REST-komennon Tesla Fleet API:lle
 */
app.post("/command/:vehicleId/:command", async (req, res) => {
  const { vehicleId, command } = req.params;
  const { token, params } = req.body;

  if (!token) {
    return res.status(400).json({
      error: "Missing token (business_token required in request body)",
    });
  }

  try {
    const url = `${FLEET_API_BASE}/api/1/vehicles/${vehicleId}/command/${command}`;
    log("→ Sending command to Tesla:", url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params || {}),
    });

    const data = await response.json();

    if (!response.ok) {
      log("❌ Tesla Fleet API error:", response.status, data);
      return res.status(response.status).json({
        error: data.error || data.message || "Tesla API error",
        details: data,
      });
    }

    log("✅ Tesla command successful:", command);
    res.json({
      success: true,
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
      headers: { Authorization: "Bearer <business_token>" },
    },
  });
});

// 🚀 Käynnistetään palvelin
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log(`Server running on port ${PORT}`));
