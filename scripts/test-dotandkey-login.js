const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

const SITE_URL = "https://www.dotandkey.com/";
const authDir = path.resolve(__dirname, "..", "auth");
const storagePath = path.join(authDir, "dotandkey-storage-state.json");
const screenshotPath = path.join(authDir, "dotandkey-login-test.png");
const noWait = process.argv.includes("--no-wait");

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

(async () => {
  if (!fs.existsSync(storagePath)) {
    console.error(`Missing storage state: ${storagePath}`);
    console.error("Pehle `npm run login` chalao aur login complete karke cookies save karo.");
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50
  });

  const context = await browser.newContext({
    storageState: storagePath
  });
  const page = await context.newPage();

  console.log(`Testing saved login with: ${storagePath}`);
  await page.goto(SITE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const currentUrl = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const lowerText = bodyText.toLowerCase();
  const looksLoggedOut =
    currentUrl.toLowerCase().includes("/login") ||
    lowerText.includes("login") ||
    lowerText.includes("log in") ||
    lowerText.includes("sign in") ||
    lowerText.includes("otp");

  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log("");
  console.log(`Page title: ${title}`);
  console.log(`Current URL: ${currentUrl}`);
  console.log(`Screenshot saved: ${screenshotPath}`);
  console.log(
    looksLoggedOut
      ? "Result: Shayad login active nahi hai ya site ne dobara verification maanga hai."
      : "Result: Saved cookies/storage likely valid hain."
  );
  console.log("");

  if (!noWait) {
    await waitForEnter("Browser inspect kar lo. Close karne ke liye Enter press karo...");
  }

  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
