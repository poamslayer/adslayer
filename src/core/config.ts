import path from "node:path";

export interface Config {
  homeDir: string;
  connectionsFile: string;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME ?? env.USERPROFILE ?? process.cwd();
  const homeDir = env.ADSLAYER_HOME ?? path.join(home, ".adslayer");
  return {
    homeDir,
    connectionsFile: path.join(homeDir, "connections.json"),
  };
}
