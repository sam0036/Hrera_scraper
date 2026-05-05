import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { getReraStatusFromExpiry } from "./reraStatus.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();
const inProgress = new Map();

const PROXY_URL = process.env.PROXY_URL || null;

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

    const args = [
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
    ];

    if (PROXY_URL) {
      args.push(`--proxy-server=${PROXY_URL}`);
    }

    browser = await puppeteer.launch({
      args,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    if (PROXY_URL && PROXY_URL.includes("@")) {
      const proxyAuth = PROXY_URL.match(/\/\/([^:]+):([^@]+)@/);
      if (proxyAuth) {
        await page.authenticate({
          username: proxyAuth[1],
          password: proxyAuth[2],
        });
      }
    }

    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "max-age=0",
    });

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "stylesheet", "font", "media", "manifest", "other"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ✅ FIXED: Track all navigation events to detect redirects
    let lastUrl = "";
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        console.log("Navigated to:", frame.url());
        lastUrl = frame.url();
      }
    });

    // ✅ FIXED: Don't catch timeout — let it throw, but check page state first
    let response;
    try {
      response = await page.goto(
        "https://haryanarera.gov.in/admincontrol/registered_agents/2",
        {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        }
      );
    } catch (navErr) {
      console.log("Navigation error:", navErr.message);
      console.log("Last URL:", lastUrl);
      
      // Check current page state without evaluating (avoid context destroyed)
      const currentUrl = page.url();
      console.log("Current URL:", currentUrl);
      
      // If we're on a different page, the site redirected us (block page?)
      if (currentUrl && !currentUrl.includes("registered_agents")) {
        throw new Error(`Redirected to ${currentUrl} — possible bot block`);
      }
      
      throw navErr;
    }

    if (response && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} from server`);
    }

    // ✅ FIXED: Wait a bit for any client-side redirects to settle
    await new Promise((r) => setTimeout(r, 2000));

    console.log("PAGE TITLE:", await page.title());
    console.log("PAGE URL:", page.url());

    // Check content safely
    const content = await page.content();
    console.log("Content length:", content.length);
    console.log("Content snippet:", content.slice(0, 500));

    if (content.length < 200 || 
        content.includes("Access Denied") || 
        content.includes("blocked") || 
        content.includes("captcha") ||
        content.includes("403") ||
        content.includes("Forbidden")) {
      throw new Error("Page blocked or empty");
    }

    const searchSelector = 'input[type="search"]';
    const maxWaitTime = 15000;
    const pollInterval = 500;
    const startTime = Date.now();
    let searchInput = null;

    while (Date.now() - startTime < maxWaitTime) {
      searchInput = await page.$(searchSelector);
      if (searchInput) break;
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    if (!searchInput) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 25000 });
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

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.value = "";
        el.focus();
      }
    }, searchSelector);
    await page.type(searchSelector, reraNumber, { delay: 15 });

    await new Promise((r) => setTimeout(r, 1500));

    const tableStart = Date.now();
    let rows = [];
    while (Date.now() - tableStart < 15000) {
      rows = await page.$$eval("table tbody tr", (trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.innerText.trim()))
      );
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
