import express from "express";
import WebSocket from "ws";
import crypto from "crypto";

const app = express();
app.use(express.json());

app.post("/command/:vehicleId/:command", async (req, res) => {
  const { vehicleId, command } = req.params;
  const { token, params, privateKeyPem, domain } = req.body;

  if (!token || !privateKeyPem || !domain) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const region = "eu";
  const wsUrl = `wss://fleet-gateway.prd.${region}.teslaapis.com/v1`;

  try {
    const handshake = {
      type: "VehicleCommandHandshake",
      token: token,
      domain: domain,
    };

    const message = JSON.stringify(params || {});
    const sign = crypto.createSign("SHA256");
    sign.update(message);
    sign.end();

    const key = crypto.createPrivateKey(privateKeyPem);
    const signature = sign.sign(key).toString("base64");

    const commandMsg = {
      type: "VehicleCommandRequest",
      command,
      vehicle_id: vehicleId,
      params,
      signature,
    };

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    ws.on("open", () => {
      ws.send(JSON.stringify(handshake));
      setTimeout(() => ws.send(JSON.stringify(commandMsg)), 300);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "VehicleCommandResponse") {
          res.json(msg);
          ws.close();
        }
      } catch (err) {
        console.error("Invalid JSON:", data.toString());
      }
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.send("✅ Tesla VCP Proxy running");
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`🚀 Proxy ready on port ${port}`));
