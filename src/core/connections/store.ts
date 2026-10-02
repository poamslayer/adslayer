import { promises as fs } from "node:fs";
import path from "node:path";
import type { Connection, ConnectionMode } from "../types.js";

interface FileShape {
  version: 1;
  connections: Connection[];
}

/**
 * The one place that decides what an absent mode means, so no caller reads `connection.mode`
 * and picks its own answer. Absence means read: a record nobody marked writable does less,
 * not more. ADR-0004.
 */
export function modeOf(connection: Pick<Connection, "mode">): ConnectionMode {
  return connection.mode ?? "read";
}

export class ConnectionStore {
  constructor(private readonly file: string) {}

  async list(): Promise<Connection[]> {
    return (await this.read()).connections;
  }

  /** Accepts an alias or a domain's DNS name, which matches regardless of case. */
  async resolve(key: string): Promise<Connection | undefined> {
    const all = await this.list();
    const lower = key.toLowerCase();
    return all.find((c) => c.alias === key) ?? all.find((c) => c.domain.toLowerCase() === lower);
  }

  async upsert(connection: Connection): Promise<void> {
    const data = await this.read();
    const rest = data.connections.filter((c) => c.alias !== connection.alias);
    await this.write({ version: 1, connections: [...rest, connection] });
  }

  async remove(alias: string): Promise<boolean> {
    const data = await this.read();
    const rest = data.connections.filter((c) => c.alias !== alias);
    if (rest.length === data.connections.length) return false;
    await this.write({ version: 1, connections: rest });
    return true;
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return { version: 1, connections: Array.isArray(parsed.connections) ? parsed.connections : [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: [] };
      throw err;
    }
  }

  private async write(data: FileShape): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
