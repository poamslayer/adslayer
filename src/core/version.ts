import { createRequire } from "node:module";

/**
 * Read from package.json, so bumping the version for a release is the only edit. The path is
 * the same from src/core and from dist/core, and npm always ships package.json.
 */
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

export const SERVER_NAME = "adslayer";
export const SERVER_VERSION = version;

/** Sent to Microsoft Learn by the docs tool. */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
