// Every board the factory can be steered from, each a fresh tracker over its vendor's fixture server.
// tests/any-board-steers.test.ts holds this list equal to the tracker manifests, so a new tracker
// cannot land without proving a command sent through it reaches the runner.

import { AsanaTracker } from "../../src/adapters/trackers/asana";
import { ClickUpTracker } from "../../src/adapters/trackers/clickup";
import { JiraTracker } from "../../src/adapters/trackers/jira";
import { LinearTracker } from "../../src/adapters/trackers/linear";
import { PlaneTracker } from "../../src/adapters/trackers/plane";
import { HttpTracker } from "../../src/adapters/http-tracker";
import type { TrackerPort } from "../../src/ports/scm";
import { FakeGitHub } from "../harness";
import { startTracker } from "./tracker-server";
import { startAsana } from "./trackers/asana-server";
import { startClickUp } from "./trackers/clickup-server";
import { startJira } from "./trackers/jira-server";
import { startLinear } from "./trackers/linear-server";
import { startPlane } from "./trackers/plane-server";

export interface Boards {
  readonly make: Readonly<Record<string, () => TrackerPort>>;
  stop(): void;
}

export function startBoards(): Boards {
  const http = startTracker("t");
  const linear = startLinear("k");
  const jira = startJira("bot@acme.test:k");
  const plane = startPlane("k");
  const clickup = startClickUp("k");
  const asana = startAsana("k");
  let n = 0;
  return {
    make: {
      github: () => new FakeGitHub([]),
      http: () => new HttpTracker({ kind: "http", url: http.url, tokenEnv: "T", project: `B${++n}` }, { T: "t" }),
      linear: () => {
        const team = `B${++n}`;
        linear.store.addTeam(team);
        return new LinearTracker({ kind: "linear", team, tokenEnv: "K", url: linear.url }, { K: "k" });
      },
      jira: () => {
        const project = `B${++n}`;
        jira.store.addProject(project);
        return new JiraTracker({ kind: "jira", url: jira.url, project, tokenEnv: "K" }, { K: "bot@acme.test:k" });
      },
      plane: () => {
        const project = `b${++n}`;
        plane.store.addProject(project);
        return new PlaneTracker({ kind: "plane", workspace: "acme", project, tokenEnv: "K", url: plane.url }, { K: "k" });
      },
      clickup: () => {
        const list = `b${++n}`;
        clickup.store.addList(list);
        return new ClickUpTracker(
          { kind: "clickup", workspace: "ws1", list, tokenEnv: "K", url: clickup.url, labelTrust: "creator" },
          { K: "k" },
        );
      },
      asana: () => {
        const project = String(1_202_000_000_000_000 + ++n);
        asana.store.projects.add(project);
        return new AsanaTracker({ kind: "asana", workspace: "ws1", project, tokenEnv: "K", url: asana.url }, { K: "k" });
      },
    },
    stop() {
      for (const s of [http, linear, jira, plane, clickup, asana]) s.stop();
    },
  };
}
