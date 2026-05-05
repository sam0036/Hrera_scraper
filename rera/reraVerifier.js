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
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-features=TranslateUI",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
        "--safebrowsing-disable-auto-update",
      ],
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // ✅ Anti-bot: Realistic UA + viewport + locale
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    // ✅ CRITICAL FIX: Block heavy resources BEFORE goto to prevent hangs
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "stylesheet", "font", "media", "manifest", "other"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ✅ CRITICAL FIX: Hard timeout on goto — don't wait for networkidle
    // Use domcontentloaded with a 15s cap, then manually wait for the table
    await page.goto("https://haryanarera.gov.in/admincontrol/registered_agents/2", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    console.log("PAGE TITLE:", await page.title());

    // ✅ CRITICAL FIX: Don't rely on waitForSelector alone — use polling with timeout
    const searchSelector = 'input[type="search"]';
    const maxWaitTime = 10000;
    const pollInterval = 500;
    const startTime = Date.now();
    let searchInput = null;

    while (Date.now() - startTime < maxWaitTime) {
      searchInput = await page.$(searchSelector);
      if (searchInput) break;
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    if (!searchInput) {
      // One reload attempt if selector missing
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      const reloadStart = Date.now();
      while (Date.now() - reloadStart < maxWaitTime) {
        searchInput = await page.$(searchSelector);
        if (searchInput) break;
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    }

    if (!searchInput) {
      throw new Error("Search input not found after retries");
    }

    // ✅ Clear and type reliably
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.value = "";
        el.focus();
      }
    }, searchSelector);
    await page.type(searchSelector, reraNumber, { delay: 10 });

    // ✅ CRITICAL FIX: Poll for table rows instead of waitForSelector
    // DataTables often updates DOM asynchronously
    const tableRowsSelector = "table tbody tr";
    const tableStart = Date.now();
    let rows = [];

    while (Date.now() - tableStart < 15000) {
      rows = await page.$$eval(tableRowsSelector, (trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.innerText.trim()))
      );
      // If we have rows with actual content, break
      if (rows.length > 0 && rows[0].length > 0) break;
      await new Promise((r) => setTimeout(r, 800));
    }

    if (rows.length === 0) {
      return {
        success: false,
        status: "NOT_FOUND",
        message: "RERA number was not found",
      };
    }

    const normalizedTarget = reraNumber.trim().toLowerCase();
    const match = rows.find((cells) => cells[1]?.toLowerCase() === normalizedTarget);

    if (!match) {
      return {
        success: false,
        status: "NOT_FOUND",
        message: "RERA number was not found",
      };
    }

    const data = {
      registrationNumber: match[1] || "",
      agentName: match[2] || "",
      district: match[3] || "",
      status: match[4] || "",
      validity: match[6] || "",
    };

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
