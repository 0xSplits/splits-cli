import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const targetPath = fileURLToPath(new URL("../dist/build-target.js", import.meta.url));
const devLine = "export const IS_PROD_BUILD = false;";
const prodLine = "export const IS_PROD_BUILD = true;";

const source = readFileSync(targetPath, "utf8");
if (!source.includes(devLine)) {
  throw new Error(`${targetPath} does not contain "${devLine}". Run tsc before this script.`);
}
writeFileSync(targetPath, source.replace(devLine, prodLine));

const { IS_PROD_BUILD } = await import(pathToFileURL(targetPath).href);
if (IS_PROD_BUILD !== true) {
  throw new Error(`${targetPath} is not a prod build after marking it.`);
}
