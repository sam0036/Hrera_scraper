import express from "express";
import { verifyRera } from "./rera/reraVerifier.js";

const app = express();

// Optional: parse JSON if you expand API later
app.use(express.json());

// ✅ Health check route (important for Render)
app.get("/", (req, res) => {
  res.send("RERA scraper running");
});

// ✅ Main verification route
app.get("/verify", async (req, res) => {
  const { reraNumber, state } = req.query;

  if (!reraNumber) {
    return res.status(400).json({
      success: false,
      message: "Missing RERA number",
    });
  }

  try {
    const result = await verifyRera(reraNumber, state);
    return res.json(result);
  } catch (err) {
    console.error("API ERROR:", err);

    return res.status(500).json({
      success: false,
      message: "Scraper failed",
    });
  }
});

// ✅ Start server (Render uses PORT env variable)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`RERA scraper running on port ${PORT}`);
});
