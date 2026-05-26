const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

const SITE_URL = "https://www.dotandkey.com/";
const authDir = path.resolve(__dirname, "..", "auth");
const storagePath = path.join(authDir, "dotandkey-storage-state.json");
const cookiesPath = path.join(authDir, "dotandkey-cookies.json");
const requestedAccountLabel = getArgValue("--account") || process.env.DOTKEY_ACCOUNT_LABEL;

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function waitForEnter(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function normalizeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    expires: cookie.expires && cookie.expires > 0 ? cookie.expires : null,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite || null
  };
}

async function getNextAccountLabel(client) {
  const result = await client.query(`
    SELECT account_label
    FROM dotkey_accounts
    WHERE account_label ~ '^a[0-9]+$'
    ORDER BY substring(account_label from 2)::int DESC
    LIMIT 1
  `);

  if (result.rowCount === 0) return "a1";

  const lastNumber = Number(result.rows[0].account_label.slice(1));
  return `a${lastNumber + 1}`;
}

async function saveStorageStateToPostgres(storageState) {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL set nahi hai, PostgreSQL save skip kiya.");
    return;
  }

  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    throw new Error("`pg` package missing hai. Pehle `npm install` ya `npm install pg` chalao.");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  await client.connect();

  try {
    await client.query("BEGIN");

    const accountLabel = requestedAccountLabel || await getNextAccountLabel(client);

    const accountResult = await client.query(
      `
        INSERT INTO dotkey_accounts (account_label, account_name, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (account_label)
        DO UPDATE SET updated_at = now()
        RETURNING id
      `,
      [accountLabel, `Dotkey account ${accountLabel}`]
    );

    const accountId = accountResult.rows[0].id;

    await client.query("DELETE FROM dotkey_cookies WHERE account_id = $1", [accountId]);

    for (const cookie of storageState.cookies.map(normalizeCookie)) {
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
          cookie.path,
          cookie.expires,
          cookie.httpOnly,
          cookie.secure,
          cookie.sameSite
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`PostgreSQL saved account: ${accountLabel}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

(async () => {
  fs.mkdirSync(authDir, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`Opening ${SITE_URL}`);
  await page.goto(SITE_URL, { waitUntil: "domcontentloaded" });

  console.log("");
  console.log("Browser me Dot & Key login complete karein.");
  console.log("Login ke baad yahan terminal me Enter press karein.");

  await waitForEnter("Press Enter after login is complete...");

  await page.waitForLoadState("domcontentloaded").catch(() => {});

  const storageState = await context.storageState({ path: storagePath });
  fs.writeFileSync(cookiesPath, JSON.stringify(storageState.cookies, null, 2));
  await saveStorageStateToPostgres(storageState);

  console.log("");
  console.log(`Storage state saved: ${storagePath}`);
  console.log(`Cookies saved: ${cookiesPath}`);

  await browser.close();
})().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
