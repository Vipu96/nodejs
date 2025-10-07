import cors from "cors";
app.use(cors());
import express from "express";
import fs from "fs";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Environment variables (add in Railway)
const TESLA_PRIVATE_KEY = process.env.TESLA_PRIVATE_KEY;
const TESLA_PUBLIC_KEY = process.env.TESLA_PUBLIC_KEY;

// Root test endpoint
app.get("/", (req, res) => {
  res.send("🚀 Tesla proxy server is alive and ready for commands!");
});

// Serve public key at Tesla-required path
app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem", (req, res) => {
  if (!TESLA_PUBLIC_KEY) {
    return res.status(500).send("TESLA_PUBLIC_KEY not set");
  }
  res.type("application/x-pem-file").send(TESLA_PUBLIC_KEY);
});

// Proxy command endpoint
app.post("/api/proxy/command/:vehicleId/:commandName", async (req, res) => {
  const { vehicleId, commandName } = req.params;

  try {
    if (!TESLA_PRIVATE_KEY) throw new Error("TESLA_PRIVATE_KEY missing");

    const payload = JSON.stringify(req.body || {});
    const signature = crypto
      .sign("RSA-SHA256", Buffer.from(payload), TESLA_PRIVATE_KEY)
      .toString("base64");

    const response = await fetch(
      `https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/${vehicleId}/command/${commandName}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": req.headers.authorization || "",
          "X-Tesla-Vehicle-Command-Signature": signature,
        },
        body: payload,
      }
    );

    const data = await response.text();
    res.status(response.status).send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚗 Tesla proxy live on port ${port}`));
