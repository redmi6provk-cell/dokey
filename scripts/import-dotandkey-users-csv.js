const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Client } = require("pg");

const csvPath = path.resolve(process.argv[2] || "dotandkey_users.csv");
const defaultDomain = process.env.DOTKEY_COOKIE_DOMAIN || ".dotandkey.com";
const defaultPath = process.env.DOTKEY_COOKIE_PATH || "/";

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quoted) {
      if (char === "\"") {
        if (line[index + 1] === "\"") {
          current += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function toBoolean(value) {
  return ["true", "t", "1", "yes", "y"].includes(String(value).toLowerCase());
}

function normalizeLabel(row) {
  const raw = row.name || `csv_${row.id}`;
  return raw.trim().replace(/\s+/g, "_").toLowerCase();
}

function extractDotandkeyCookies(row) {
  if (!row.browser_data) return [];

  const browserData = JSON.parse(row.browser_data);
  const cookieObjects = browserData.dotandkey?.cookies || [];
  const mergedCookies = Object.assign({}, ...cookieObjects);

  return Object.entries(mergedCookies)
    .filter(([name, value]) => name && value !== undefined && value !== null)
    .map(([name, value]) => ({
      name,
      value: String(value),
      domain: defaultDomain,
      path: defaultPath,
      expires: null,
      httpOnly: false,
      secure: true,
      sameSite: null
    }));
}

async function upsertAccount(client, row) {
  const accountLabel = normalizeLabel(row);
  const result = await client.query(
    `
      INSERT INTO dotkey_accounts (
        account_label, account_name, is_active, updated_at
      )
      VALUES ($1, $2, $3, now())
      ON CONFLICT (account_label)
      DO UPDATE SET
        account_name = EXCLUDED.account_name,
        is_active = EXCLUDED.is_active,
        updated_at = now()
      RETURNING id, account_label
    `,
    [
      accountLabel,
      row.email ? `${row.name} (${row.email})` : row.name,
      toBoolean(row.is_active)
    ]
  );

  return result.rows[0];
}

async function replaceCookies(client, accountId, cookies) {
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
        cookie.path,
        cookie.expires,
        cookie.httpOnly,
        cookie.secure,
        cookie.sameSite
      ]
    );
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL set karo.");
  }

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file nahi mila: ${csvPath}`);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  await client.connect();

  const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  let header = null;
  let importedAccounts = 0;
  let importedCookies = 0;
  let skippedRows = 0;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      if (!header) {
        header = parseCsvLine(line);
        continue;
      }

      const values = parseCsvLine(line);
      const row = Object.fromEntries(header.map((column, index) => [column, values[index] || ""]));

      let cookies;
      try {
        cookies = extractDotandkeyCookies(row);
      } catch (error) {
        skippedRows += 1;
        console.warn(`Skipped row ${row.id || "unknown"}: browser_data parse failed`);
        continue;
      }

      if (cookies.length === 0) {
        skippedRows += 1;
        continue;
      }

      await client.query("BEGIN");
      try {
        const account = await upsertAccount(client, row);
        await replaceCookies(client, account.id, cookies);
        await client.query("COMMIT");

        importedAccounts += 1;
        importedCookies += cookies.length;
        console.log(`Imported ${account.account_label}: ${cookies.length} cookies`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }

  console.log("");
  console.log(`Imported accounts: ${importedAccounts}`);
  console.log(`Imported cookies: ${importedCookies}`);
  console.log(`Skipped rows: ${skippedRows}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
