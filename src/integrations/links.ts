// Which outside conversation belongs to which issue: a Linear agent session, a Slack thread, an A2A
// task. The dashboard writes a link when a surface starts a task; the watcher reads it to post the
// run's progress back. One small SQLite file in FACTORY_HOME, so both processes see it.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { factoryHome } from "../paths";

export interface Link {
  readonly surface: string;
  readonly external: string;
  readonly repo: string;
  readonly issue: number;
}

export class LinkStore {
  private readonly db: Database;

  constructor(path = join(factoryHome(), "integrations.db")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS links (surface TEXT NOT NULL, external TEXT NOT NULL,
      repo TEXT NOT NULL, issue INTEGER NOT NULL, PRIMARY KEY (surface, external))`);
  }

  put(link: Link): void {
    this.db
      .query("INSERT OR REPLACE INTO links (surface, external, repo, issue) VALUES (?, ?, ?, ?)")
      .run(link.surface, link.external, link.repo, link.issue);
  }

  byExternal(surface: string, external: string): Link | undefined {
    return (this.db.query("SELECT * FROM links WHERE surface = ? AND external = ?").get(surface, external) ??
      undefined) as Link | undefined;
  }

  byIssue(surface: string, repo: string, issue: number): Link[] {
    return this.db
      .query("SELECT * FROM links WHERE surface = ? AND repo = ? AND issue = ?")
      .all(surface, repo, issue) as Link[];
  }
}
