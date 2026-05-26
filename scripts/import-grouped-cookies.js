const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const jsonPath = path.resolve(process.argv[2] || "grouped_cookies.json");

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

async function upsertAccount(client, label) {
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
      label,
      `Dotkey account ${label}`,
      true
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
    throw new Error("DATABASE_URL environment variable set nahi hai. Pehle DATABASE_URL set karein.");
  }

  if (!fs.existsSync(jsonPath)) {
    throw new Error(`JSON file nahi mili: ${jsonPath}`);
  }

  console.log(`Reading grouped cookies from: ${jsonPath}`);
  const rawData = fs.readFileSync(jsonPath, "utf8");
  const groupedCookies = JSON.parse(rawData);

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  await client.connect();
  console.log("PostgreSQL Database connected successfully.");

  let importedAccounts = 0;
  let importedCookies = 0;

  try {
    const keys = Object.keys(groupedCookies);
    console.log(`Found ${keys.length} accounts in JSON.`);

    for (const label of keys) {
      const cookiesList = groupedCookies[label];
      if (!Array.isArray(cookiesList)) {
        console.log(`Skipping key ${label}: Value is not an array.`);
        continue;
      }

      await client.query("BEGIN");
      try {
        const account = await upsertAccount(client, label);
        const normalized = cookiesList.map(normalizeCookie);
        await replaceCookies(client, account.id, normalized);
        await client.query("COMMIT");

        importedAccounts += 1;
        importedCookies += normalized.length;
        console.log(`Imported account "${label}": ${normalized.length} cookies.`);
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`Error importing account ${label}:`, error);
        throw error;
      }
    }
  } finally {
    await client.end();
  }

  console.log("\n--- Import Summary ---");
  console.log(`Successfully imported/updated accounts: ${importedAccounts}`);
  console.log(`Successfully imported cookies: ${importedCookies}`);
}

main().catch((error) => {
  console.error("Execution failed:", error);
  process.exitCode = 1;
});
