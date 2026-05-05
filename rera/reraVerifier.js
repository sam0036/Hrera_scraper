import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
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

// ---------------- API FALLBACK: Try direct HTTP first ----------------
async function fetchViaApi(reraNumber) {
  try {
    // DataTables serverside processing endpoint
    const url = "https://haryanarera.gov.in/admincontrol/registered_agents/2";

    // Common DataTables payload — adjust if needed based on actual site behavior
    const body = new URLSearchParams({
      draw: "1",
      columns: JSON.stringify([
        { data: "0", name: "", searchable: "true", orderable: "true", search: { value: "", regex: "false" } },
        { data: "1", name: "", searchable: "true", orderable: "true", search: { value: reraNumber, regex: "false" } },
        { data: "2", name: "", searchable: "true", orderable: "true", search: { value: "", regex: "false" } },
        { data: "3", name: "", searchable: "true", orderable: "true", search: { value: "", regex: "false" } },
        { data: "4", name: "", searchable: "true", orderable: "true", search: { value: "", regex: "false" } },
        { data: "5", name: "", searchable: "true", orderable: "true", search: { value: "", regex: "false" } },
        { data: "6", name: "", searchable: "true", orderable: "true", search: { value: "", regex: "false" } },
      ]),
      start: "0",
      length: "10",
      search: JSON.stringify({ value: "", regex: "false" }),
      _: String(Date.now()),
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": "https://haryanarera.gov.in/admincontrol/registered_agents/2",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.log("API fallback: HTTP", response.status);
      return null;
    }

    const json = await response.json();
    console.log("API response:", JSON.stringify(json).slice(0, 500));

    if (!json.data || json.data.length === 0) {
      return {
        success: false,
        status: "NOT_FOUND",
        message: "RERA number was not found",
      };
    }

    // Find matching row
    const normalizedTarget = reraNumber.trim().toLowerCase();
    const match = json.data.find((row) => {
      // row is usually an array of HTML strings
      const regNum = row[1]?.replace(/<[^>]+>/g, "").trim().toLowerCase();
      return regNum === normalizedTarget;
    });

    if (!match) {
      return {
        success: false,
        status: "NOT_FOUND",
        message: "RERA number was not found",
      };
    }

    const data = {
      registrationNumber: match[1]?.replace(/<[^>]+>/g, "").trim() || "",
      agentName: match[2]?.replace(/<[^>]+>/g, "").trim() || "",
      district: match[3]?.replace(/<[^>]+>/g, "").trim() || "",
      status: match[4]?.replace(/<[^>]+>/g, "").trim() || "",
      validity: match[6]?.replace(/<[^>]+>/g, "").trim() || "",
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
  } catch (err) {
    console.log("API fallback failed:", err.message);
    return null;
  }
}

// ---------------- SCRAPER ----------------
async function scrapeHaryanaDatabase(reraNumber) {
  // ✅ TRY API FIRST — much faster, no browser needed
  const apiResult = await fetchViaApi(reraNumber);
  if (apiResult) return apiResult;

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

    // ✅ FIXED: No waitUntil at all — just load raw HTML, then evaluate
    const response = await page.goto(
      "https://haryanarera.gov.in/admincontrol/registered_agents/2",
      {
        waitUntil: "load",
        timeout: 25000,
      }
    );

    if (!response) {
      throw new Error("No response from server");
    }

    const status = response.status();
    console.log("Response status:", status);

    if (status >= 400) {
      throw new Error(`HTTP ${status} from server`);
    }

    console.log("PAGE TITLE:", await page.title());

    // If page is blank or error, bail
    const content = await page.content();
    if (content.length < 200 || content.includes("Access Denied") || content.includes("blocked")) {
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
      await page.reload({ waitUntil: "load", timeout: 20000 });
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
