/**
 * Project registry.
 *
 * A JSON file in the state volume for now; ticket #4 replaces it with SQLite
 * once concurrent deploys make transactions necessary. The interface is what
 * the router depends on, so the swap will not reach the routing rules.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectRecord } from "./router";

export class Registry {
  private projects = new Map<string, ProjectRecord>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const records = JSON.parse(raw) as ProjectRecord[];
      this.projects = new Map(records.map((record) => [record.name, record]));
    } catch {
      this.projects = new Map();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify([...this.projects.values()], null, 2));
  }

  lookup(name: string): ProjectRecord | null {
    return this.projects.get(name) ?? null;
  }

  list(): ProjectRecord[] {
    return [...this.projects.values()];
  }

  /** Records a project, replacing any existing entry of the same name. */
  async upsert(record: ProjectRecord): Promise<void> {
    this.projects.set(record.name, record);
    await this.persist();
  }

  async remove(name: string): Promise<void> {
    this.projects.delete(name);
    await this.persist();
  }
}

