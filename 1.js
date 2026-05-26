const fs = require("fs");

const cookies = JSON.parse(
  fs.readFileSync("cookies.json", "utf8")
);

const result = {};

let accountNo = 1;

for (let i = 0; i < cookies.length; i += 2) {
  result[`a${accountNo}`] = cookies.slice(i, i + 2);
  accountNo++;
}

fs.writeFileSync(
  "grouped_cookies.json",
  JSON.stringify(result, null, 2)
);

console.log(`Created ${accountNo - 1} groups`);