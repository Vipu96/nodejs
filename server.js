import express from "express";
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🚀 Tesla proxy server is alive!");
});

app.listen(port, () => console.log(`✅ Running on port ${port}`));
