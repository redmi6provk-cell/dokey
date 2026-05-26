const fs = require("fs");
const http = require("http");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const SITE_URL = "https://www.dotandkey.com/";
const authDir = path.resolve(__dirname, "..", "auth");
const cookiesPath = path.join(authDir, "dotandkey-cookies.json");
const mode = process.argv.includes("--guest") ? "guest" : "incognito";
const port = Number(process.env.CHROME_DEBUG_PORT || (mode === "guest" ? 9223 : 9222));
const requestedAccountLabel = getArgValue("--account") || process.env.DOTKEY_ACCOUNT_LABEL;
let selectedAccountLabel = requestedAccountLabel || "a1";
const chromeArgs = getChromeArgs();

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function getChromeArgs() {
  const args = [];

  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];

    if (arg === "--guest" || arg === "--incognito") continue;
    if (arg === "--account") {
      index += 1;
      continue;
    }

    args.push(arg);
  }

  return args;
}

let rlInstance = null;

function getReadline() {
  if (!rlInstance) {
    rlInstance = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }
  return rlInstance;
}

function waitForEnter(message) {
  const rl = getReadline();
  return new Promise((resolve) => {
    rl.question(message, () => {
      resolve();
    });
  });
}

function askQuestion(message) {
  const rl = getReadline();
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      resolve(answer.trim());
    });
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("chrome.exe nahi mila. CHROME_PATH env var me chrome.exe ka full path set karo.");
  }
  return found;
}

function requestJson(route, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Chrome CDP ${method} ${route} failed: ${res.statusCode} ${body}`));
            return;
          }
          resolve(body ? JSON.parse(body) : {});
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForChrome() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await requestJson("/json/version");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Chrome remote debugging start nahi hua.");
}

async function getPageTarget() {
  const targets = await requestJson("/json/list");
  const existingPage = targets.find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl && target.url === "about:blank"
  ) || targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);

  if (existingPage) {
    return existingPage;
  }

  return requestJson(`/json/new?${encodeURIComponent("about:blank")}`, "PUT");
}

function cdpClient(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);

    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
    } else {
      resolve(message.result || {});
    }
  };

  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("Chrome websocket connection failed."));
  });

  return {
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() {
      ws.close();
    }
  };
}

function normalizeCookie(cookie) {
  const normalized = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly)
  };

  if (cookie.expires && cookie.expires > 0) {
    normalized.expires = cookie.expires;
  }

  if (cookie.sameSite) {
    normalized.sameSite = cookie.sameSite;
  }

  return normalized;
}

function getPostgresClient() {
  if (!process.env.DATABASE_URL) return null;

  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    throw new Error("`pg` package missing hai. Pehle `npm install` ya `npm install pg` chalao.");
  }

  return new Client({
    connectionString: process.env.DATABASE_URL
  });
}

function normalizeDbCookie(cookie) {
  return normalizeCookie({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.http_only,
    secure: cookie.secure,
    sameSite: cookie.same_site
  });
}

async function loadCookiesFromPostgres() {
  const client = getPostgresClient();
  if (!client) return null;

  await client.connect();

  try {
    if (!requestedAccountLabel) {
      const accounts = await client.query(
        `
          SELECT a.account_label, count(c.id)::int AS cookie_count
          FROM dotkey_accounts a
          LEFT JOIN dotkey_cookies c ON c.account_id = a.id
          WHERE a.is_active = true
          GROUP BY a.id, a.account_label
          ORDER BY substring(a.account_label from 2)::int NULLS LAST, a.account_label
        `
      );

      if (accounts.rowCount > 0) {
        console.log("Available accounts:");
        for (const account of accounts.rows) {
          console.log(`- ${account.account_label} (${account.cookie_count} cookies)`);
        }

        const answer = await askQuestion("Kaunsa account open karna hai? ");
        selectedAccountLabel = answer || accounts.rows[0].account_label;
      }
    }

    const result = await client.query(
      `
        SELECT c.name, c.value, c.domain, c.path, c.expires, c.http_only, c.secure, c.same_site
        FROM dotkey_cookies c
        JOIN dotkey_accounts a ON a.id = c.account_id
        WHERE a.account_label = $1
          AND a.is_active = true
        ORDER BY c.domain, c.path, c.name
      `,
      [selectedAccountLabel]
    );

    if (result.rowCount === 0) {
      throw new Error(`DB me account ${selectedAccountLabel} ke cookies nahi mile.`);
    }

    return result.rows.map(normalizeDbCookie);
  } finally {
    await client.end();
  }
}

async function saveCookiesToPostgres(cookies) {
  const client = getPostgresClient();
  if (!client) return false;

  await client.connect();

  try {
    await client.query("BEGIN");

    const accountResult = await client.query(
      `
        INSERT INTO dotkey_accounts (account_label, account_name, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (account_label)
        DO UPDATE SET updated_at = now()
        RETURNING id
      `,
      [selectedAccountLabel, `Dotkey account ${selectedAccountLabel}`]
    );

    const accountId = accountResult.rows[0].id;
    await client.query("DELETE FROM dotkey_cookies WHERE account_id = $1", [accountId]);

    for (const cookie of cookies) {
      await client.query(
        `
          INSERT INTO dotkey_cookies (
            account_id, name, value, domain, path, expires,
            http_only, secure, same_site, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
          ON CONFLICT (account_id, name, domain, path)
          DO UPDATE SET
            value = EXCLUDED.value,
            expires = EXCLUDED.expires,
            http_only = EXCLUDED.http_only,
            secure = EXCLUDED.secure,
            same_site = EXCLUDED.same_site,
            updated_at = now()
        `,
        [
          accountId,
          cookie.name,
          cookie.value,
          cookie.domain,
          cookie.path || "/",
          cookie.expires || null,
          Boolean(cookie.httpOnly),
          Boolean(cookie.secure),
          cookie.sameSite || null
        ]
      );
    }

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function loadCookies() {
  const dbCookies = await loadCookiesFromPostgres();
  if (dbCookies) {
    console.log(`Cookies loaded from PostgreSQL account: ${selectedAccountLabel}`);
    return dbCookies;
  }

  if (!fs.existsSync(cookiesPath)) {
    throw new Error(`Missing cookies file: ${cookiesPath}`);
  }

  console.log(`Cookies loaded from: ${cookiesPath}`);
  return JSON.parse(fs.readFileSync(cookiesPath, "utf8")).map(normalizeCookie);
}

async function saveLatestCookies(cdp) {
  const result = await cdp.send("Network.getAllCookies");
  const latestCookies = (result.cookies || [])
    .map(normalizeCookie)
    .sort((a, b) => {
      const left = `${a.domain}\u0000${a.path}\u0000${a.name}`;
      const right = `${b.domain}\u0000${b.path}\u0000${b.name}`;
      return left.localeCompare(right);
    });

  fs.writeFileSync(cookiesPath, JSON.stringify(latestCookies, null, 2));
  const savedToPostgres = await saveCookiesToPostgres(latestCookies);

  return {
    count: latestCookies.length,
    savedToPostgres
  };
}

async function closeBrowser(cdp, chromeProcess) {
  try {
    await cdp.send("Browser.close");
    return;
  } catch {
    // Fall back to the spawned process if Chrome closes the CDP socket first.
  }

  if (chromeProcess && !chromeProcess.killed) {
    chromeProcess.kill();
  }
}

(async () => {
  const cookies = await loadCookies();
  const chromePath = findChrome();
  const userDataDir = path.join(authDir, `chrome-cdp-${mode}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    mode === "guest" ? "--guest" : "--incognito",
    "about:blank",
    ...chromeArgs
  ];

  console.log(`Opening Chrome ${mode} without Playwright...`);
  const chrome = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore"
  });
  chrome.unref();

  await waitForChrome();

  const target = await getPageTarget();
  const client = cdpClient(target.webSocketDebuggerUrl);

  await client.send("Network.enable");
  await client.send("Network.setCookies", { cookies });
  await client.send("Page.navigate", { url: SITE_URL });

  console.log(`Cookies injected for account: ${selectedAccountLabel}`);
  console.log(`Opened: ${SITE_URL}`);
  console.log("Note: use incognito zyada reliable hota hai.");
  console.log("");
  console.log("Account use karne ke baad terminal me Enter press karo.");
  console.log("And after that scripts save latest cookies.");

  await waitForEnter("Press Enter to save latest cookies...");

  const saveResult = await saveLatestCookies(client);
  console.log(`Latest cookies saved: ${cookiesPath}`);
  if (saveResult.savedToPostgres) {
    console.log(`Latest cookies saved to PostgreSQL account: ${selectedAccountLabel}`);
  }
  console.log(`Cookie count: ${saveResult.count}`);

  await closeBrowser(client, chrome);
  client.close();
  if (rlInstance) {
    rlInstance.close();
  }
})().catch((error) => {
  console.error(error);
  if (rlInstance) {
    rlInstance.close();
  }
  process.exitCode = 1;
});
