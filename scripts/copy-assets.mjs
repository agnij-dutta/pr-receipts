// Copies non-TS assets the compiled code reads at runtime.
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/config", { recursive: true });
cpSync("config/pricing.json", "dist/config/pricing.json");
