const fs = require("fs");

const raw = fs.readFileSync("11.json", "utf8");

const auths = [...raw.matchAll(/flo_auth""\s*:\s*""([^"]+)/g)];
const refreshes = [...raw.matchAll(/flo_refresh""\s*:\s*""([^"]+)/g)];
const authTokens = [...raw.matchAll(/flo_auth_token""\s*:\s*""([^"]+)/g)];
const refreshTokens = [...raw.matchAll(/flo_refresh_token""\s*:\s*""([^"]+)/g)];

const output = [];

const max = Math.max(
  auths.length,
  refreshes.length,
  authTokens.length,
  refreshTokens.length
);

for (let i = 0; i < max; i++) {
  if (auths[i]) {
    output.push({
      name: "flo_auth",
      value: auths[i][1],
      domain: "checkout.shopflo.co",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "None"
    });
  }

  if (refreshes[i]) {
    output.push({
      name: "flo_refresh",
      value: refreshes[i][1],
      domain: "checkout.shopflo.co",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "None"
    });
  }

  if (authTokens[i]) {
    output.push({
      name: "flo_auth_token",
      value: authTokens[i][1],
      domain: "checkout.shopflo.co",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "None"
    });
  }

  if (refreshTokens[i]) {
    output.push({
      name: "flo_refresh_token",
      value: refreshTokens[i][1],
      domain: "checkout.shopflo.co",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "None"
    });
  }
}

fs.writeFileSync("cookies.json", JSON.stringify(output, null, 2));

console.log(`Done! Found ${output.length} cookies`);