import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storeRoutesPath = path.resolve(__dirname, "routes/storeRoutes.js");
const content = fs.readFileSync(storeRoutesPath, "utf8");
const lines = content.split("\n");

console.log("Searching for 'label' inside storeRoutes.js:");
lines.forEach((line, idx) => {
  if (line.toLowerCase().includes("label")) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
