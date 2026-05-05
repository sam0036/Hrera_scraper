import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { getReraStatusFromExpiry } from "./reraStatus.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();
const inProgress = new Map();

// ---------------- DATE PARSER ----------------
export function parseReraDate(value) {
  if (!value) return null;
  const text = String(value).trim();

  const ddmmyyyy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------- CACHE ----------------
function cacheKey(reraNumber, state) {
  return `${String(state || "").toLowerCase()}::${String(reraNumber || "").toLowerCase()}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

// ---------------- SCRAPER ----------------
async function scrapeHaryanaDatabase(reraNumber) {
  let browser;

  try {
    const executablePath = await chromium.executablePath();
    if (!executablePath) throw new Error("Chromium not found");

    // ✅ FIXED: Use chromium.args for Render compatibility
    // Added memory and stability flags for containerized environments
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-plugins",
        "--single-process",
        "--no-zygote",
        "--js-flags=--max-old-space-size=2048",
      ],
      executablePath,
      headless: chromium.headless, // ✅ Use chromium.headless instead of true
    });

    const page = await browser.newPage();

    // ✅ FIXED: Set a realistic user-agent to avoid bot detection
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.setViewport({ width: 1366, height: 768 });

    // ✅ FIXED: Use shorter default timeouts but catch them gracefully
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(20000);

    // ✅ RE-ENABLED: Block unnecessary resources to reduce memory and speed up loads
    // This prevents Render from hanging on heavy assets
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (["image", "stylesheet", "font", "media", "script"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ✅ FIXED: Use networkidle2 instead of domcontentloaded for better stability
    // But keep a fallback catch to prevent hangs
    await page.goto("https://haryanarera.gov.in/admincontrol/registered_agents/2", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    console.log("PAGE TITLE:", await page.title());

    const searchSelector = 'input[type="search"]';

    // ✅ FIXED: More robust retry logic with explicit error handling
    let retries = 2;
    while (retries > 0) {
      try {
        await page.waitForSelector(searchSelector, { timeout: 15000 });
        break;
      } catch (err) {
        retries--;
        if (retries === 0) throw new Error("Search input not found after retries");
        console.log("Selector not found, reloading...");
        await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
      }
    }

    // ✅ FIXED: Clear and type more reliably
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (el) el.value = "";
    }, searchSelector);
    
    await page.type(searchSelector, reraNumber, { delay: 10 });

    // ✅ FIXED: Wait for table with a more specific selector and timeout
    await page.waitForSelector("table tbody tr", { timeout: 15000 });

    const data = await page.evaluate((targetID) => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const normalizedTarget = targetID.trim().toLowerCase();

      const match = rows.find((row) => {
        const cells = row.querySelectorAll("td");
        return cells[1]?.innerText.trim().toLowerCase() === normalizedTarget;
      });

      if (!match) return null;

      const cells = match.querySelectorAll("td");

      return {
        registrationNumber: cells[1]?.innerText.trim() || "",
        agentName: cells[2]?.innerText.trim() || "",
        district: cells[3]?.innerText.trim() || "",
        status: cells[4]?.innerText.trim() || "",
        validity: cells[6]?.innerText.trim() || "",
      };
    }, reraNumber);

    if (!data) {
      return {
        success: false,
        status: "NOT_FOUND",
        message: "RERA number was not found",
      };
    }

    const parsedValidity = parseReraDate(data.validity);
    const verificationStatus = getReraStatusFromExpiry(parsedValidity);

    return {
      success: true,
      status: verificationStatus,
      data: {
        ...data,
        parsedValidity,
      },
    };
  } catch (error) {
    console.error("SCRAPER ERROR:", error.message, error.stack);
    return {
      success: false,
      status: "FAILED",
      message: "RERA authority verification is temporarily unavailable",
    };
  } finally {
    // ✅ FIXED: Ensure browser closes even if it throws
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("Browser close error:", closeErr.message);
      }
    }
  }
}

// ---------------- MAIN ----------------
export async function verifyRera(reraNumber, state = "Haryana") {
  const normalizedNumber = String(reraNumber || "").trim();
  const normalizedState = String(state || "").trim();

  if (!normalizedNumber) {
    return {
      success: false,
      status: "INVALID_INPUT",
      message: "RERA number is required",
    };
  }

  if (normalizedState && normalizedState.toLowerCase() !== "haryana") {
    return {
      success: false,
      status: "UNSUPPORTED_STATE",
      message: "Automated verification is currently available for Haryana RERA only",
    };
  }

  const key = cacheKey(normalizedNumber, normalizedState || "Haryana");

  const cached = getCached(key);
  if (cached) return cached;

  if (inProgress.has(key)) return inProgress.get(key);

  const promise = scrapeHaryanaDatabase(normalizedNumber);
  inProgress.set(key, promise);

  try {
    const result = await promise;

    if (result.success) {
      cache.set(key, { value: result, cachedAt: Date.now() });
    }

    return result;
  } finally {
    inProgress.delete(key);
  }
}
