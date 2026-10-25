// Draws each <figure class="scene"> from the JSON spec inside it, the same way lwp-deck draws a
// `.scene.json`: nodes on a grid, edges between them, rough.js lines and Excalifont labels.
// The <ol class="narr"> beside the spec is the text of the drawing, for print and screen readers.
//
// A node is { id, at: [col, row], label, shape?, tone?, who?, span?, dashed?, strong?, faint? }.
//   shape: box (default), ellipse (a start or an end), diamond (a decision), doc (a file),
//          store (a branch, a database, a list), text (a bare label).
//   tone:  accent (a human owns it), pass (a check that can say no), fail (missing or broken),
//          wait (the work sits).
// An edge is { from, to, label?, tone?, dashed?, both?, bend?, via? }.
//   bend curves the line by that many units; via routes it through grid points, for a loop back.
// lanes [{ label, rows: [r0, r1] }] draw bands behind the nodes; groups [{ label, nodes }] a
// dashed frame round some of them.
//
// The pure half (layout and check) also loads in bun: tests/homework-scenes.test.ts fails on a
// label that overflows its box, an arrow that crosses a node, or an edge to a missing node.
(function () {
  const CELL_W = 500, CELL_H = 280, NODE_W = 290, NODE_H = 140;
  const DIAMOND_W = 400, DIAMOND_H = 180;
  const NODE_FONT = 34, WHO_FONT = 22, EDGE_FONT = 27, LANE_FONT = 28;
  const CHAR_EM = 0.54, LINE_H = 1.25, LABEL_PAD = 10, ARROW_GAP = 12;
  const STORE_CAP = 44;
  const LANE_W = 250, FRAME_PAD = 30, MARGIN = 24;
  const SHAPES = ["box", "ellipse", "diamond", "doc", "store", "text"];
  const TONES = ["accent", "pass", "fail", "wait"];
  const PAINT = {
    ink: "#1e1e1e", paper: "#FFFFFF",
    accent: ["#1e1e1e", "#FAFF69"], pass: ["#1F7A45", "#DFF9E9"], fail: ["#B4233A", "#FCF0F0"], wait: ["#7A5D00", "#FDF6D3"],
  };

  const offsetX = (spec) => (spec.lanes && spec.lanes.length ? LANE_W : 0);

  function boxOf(spec, n) {
    const span = n.span || 1;
    const x = offsetX(spec) + n.at[0] * CELL_W, y = n.at[1] * CELL_H, width = (span - 1) * CELL_W + NODE_W;
    if (n.shape !== "diamond") return { x, y, width, height: NODE_H };
    return { x: x + width / 2 - DIAMOND_W / 2, y: y + NODE_H / 2 - DIAMOND_H / 2, width: DIAMOND_W, height: DIAMOND_H };
  }

  // The room a label has inside the outline: a diamond or an ellipse keeps only the inscribed part.
  function labelRoom(spec, n) {
    const { width, height } = boxOf(spec, n);
    const [wide, tall, margin] = n.shape === "diamond" ? [0.52, 0.56, 4] : n.shape === "ellipse" ? [0.78, 0.66, 12] : [1, 0.86, 16];
    const room = height * tall - (n.who ? WHO_FONT * 1.3 : 0) - (n.shape === "store" ? STORE_CAP : 0);
    return { width: width * wide - 2 * margin, lines: Math.max(1, Math.floor(room / (NODE_FONT * LINE_H))) };
  }

  function wrapLabel(spec, n) {
    const { width, lines } = labelRoom(spec, n);
    const per = Math.floor(width / (NODE_FONT * CHAR_EM));
    const out = [];
    let line = "";
    for (const word of n.label.trim().split(/\s+/)) {
      if (word.length > per) return null;
      if (line && (line + " " + word).length > per) { out.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    out.push(line);
    return out.length <= lines ? out : null;
  }

  const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const gridPoint = (spec, p) => [offsetX(spec) + p[0] * CELL_W + NODE_W / 2, p[1] * CELL_H + NODE_H / 2];
  const isRect = (n) => !["ellipse", "diamond"].includes(n.shape);

  function facing(b, p) {
    const [cx, cy] = centre(b);
    const [dx, dy] = [p[0] - cx, p[1] - cy];
    if (Math.abs(dx) / b.width >= Math.abs(dy) / b.height) return dx >= 0 ? "r" : "l";
    return dy >= 0 ? "b" : "t";
  }

  // The point an edge aims at from one end: its first bend, its first via point, or the far node.
  function aim(spec, e, end) {
    const byId = nodesById(spec);
    const [a, b] = [centre(boxOf(spec, byId[e.from])), centre(boxOf(spec, byId[e.to]))];
    if (e.via && e.via.length) return gridPoint(spec, end === "from" ? e.via[0] : e.via[e.via.length - 1]);
    if (e.bend) return control(a, b, e.bend);
    return end === "from" ? b : a;
  }

  function control(a, b, bend) {
    const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [mx - ((b[1] - a[1]) / len) * bend * 2, my + ((b[0] - a[0]) / len) * bend * 2];
  }

  const nodesById = (spec) => Object.fromEntries(spec.nodes.map((n) => [n.id, n]));

  // Where an edge meets a box: the side facing what it aims at, spread among every edge on that side.
  function port(spec, n, e, end) {
    const b = boxOf(spec, n);
    const target = aim(spec, e, end);
    if (!isRect(n)) {
      const [cx, cy] = centre(b), [a, h] = [b.width / 2, b.height / 2];
      const [dx, dy] = [target[0] - cx, target[1] - cy];
      const len = Math.hypot(dx, dy) || 1, [ux, uy] = [dx / len, dy / len];
      const t = n.shape === "ellipse" ? 1 / Math.hypot(ux / a, uy / h) : 1 / (Math.abs(ux) / a + Math.abs(uy) / h);
      return [cx + ux * (t + ARROW_GAP), cy + uy * (t + ARROW_GAP)];
    }
    const side = facing(b, target);
    const sharing = [];
    for (const x of spec.edges) {
      for (const which of ["from", "to"]) {
        if (x[which] !== n.id) continue;
        const p = aim(spec, x, which);
        if (facing(b, p) === side) sharing.push({ x, which, p });
      }
    }
    sharing.sort((u, v) => (side === "l" || side === "r" ? u.p[1] - v.p[1] : u.p[0] - v.p[0]));
    const i = sharing.findIndex((s) => s.x === e && s.which === end);
    const at = (i + 1) / (sharing.length + 1);
    if (side === "l") return [b.x - ARROW_GAP, b.y + at * b.height];
    if (side === "r") return [b.x + b.width + ARROW_GAP, b.y + at * b.height];
    if (side === "t") return [b.x + at * b.width, b.y - ARROW_GAP];
    return [b.x + at * b.width, b.y + b.height + ARROW_GAP];
  }

  // The edge as a list of points: two for a straight line, more for via, sampled for a bend.
  function edgePoints(spec, e) {
    const byId = nodesById(spec);
    const tail = port(spec, byId[e.from], e, "from");
    const head = port(spec, byId[e.to], e, "to");
    if (e.via && e.via.length) return [tail, ...e.via.map((p) => gridPoint(spec, p)), head];
    if (e.bend) {
      const c = control(tail, head, e.bend);
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12, u = 1 - t;
        pts.push([u * u * tail[0] + 2 * u * t * c[0] + t * t * head[0], u * u * tail[1] + 2 * u * t * c[1] + t * t * head[1]]);
      }
      return pts;
    }
    return [tail, head];
  }

  function labelAt(points) {
    let best = 0, len = -1;
    for (let i = 1; i < points.length; i++) {
      const l = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      if (l > len) { len = l; best = i; }
    }
    if (points.length > 4) {
      const m = points[Math.floor(points.length / 2)];
      return { x: m[0], y: m[1], room: Infinity };
    }
    const [p, q] = [points[best - 1], points[best]];
    return { x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2, room: len };
  }

  function segmentHitsBox(p0, p1, b) {
    if (b.width <= 0 || b.height <= 0) return false;
    const [dx, dy] = [p1[0] - p0[0], p1[1] - p0[1]];
    let [t0, t1] = [0, 1];
    for (const [p, q] of [[-dx, p0[0] - b.x], [dx, b.x + b.width - p0[0]], [-dy, p0[1] - b.y], [dy, b.y + b.height - p0[1]]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t0 <= t1;
  }

  const shrink = (b, m) => ({ x: b.x + m, y: b.y + m, width: Math.max(0, b.width - 2 * m), height: Math.max(0, b.height - 2 * m) });
  const textWidth = (s, font) => s.length * font * CHAR_EM;

  // Every problem a reader would see: a label that spills, an arrow through a box, a dangling edge.
  function check(spec) {
    const problems = [];
    const ids = new Set();
    for (const n of spec.nodes || []) {
      const where = `node ${n.id}`;
      if (ids.has(n.id)) problems.push(`${where}: duplicate id`);
      ids.add(n.id);
      if (!Array.isArray(n.at) || n.at.length !== 2) problems.push(`${where}: at must be [col, row]`);
      if (n.shape && !SHAPES.includes(n.shape)) problems.push(`${where}: unknown shape ${n.shape}`);
      if (n.tone && !TONES.includes(n.tone)) problems.push(`${where}: unknown tone ${n.tone}`);
      if (!n.label) problems.push(`${where}: no label`);
      else if (!wrapLabel(spec, n)) problems.push(`${where}: label "${n.label}" does not fit its ${n.shape || "box"}`);
      if (n.who && textWidth(n.who, WHO_FONT) > labelRoom(spec, n).width) problems.push(`${where}: who "${n.who}" is wider than the box`);
    }
    for (const [i, a] of (spec.nodes || []).entries()) {
      for (const b of spec.nodes.slice(i + 1)) {
        const [p, q] = [boxOf(spec, a), boxOf(spec, b)];
        if (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height) problems.push(`nodes ${a.id} and ${b.id} overlap`);
      }
    }
    for (const e of spec.edges || []) {
      const where = `edge ${e.from} -> ${e.to}`;
      if (!ids.has(e.from) || !ids.has(e.to)) { problems.push(`${where}: unknown node`); continue; }
      if (e.tone && !["pass", "fail", "wait"].includes(e.tone)) problems.push(`${where}: an arrow takes pass, fail or wait`);
      const pts = edgePoints(spec, e);
      if (e.label) {
        const at = labelAt(pts);
        const need = textWidth(e.label, EDGE_FONT) + 2 * LABEL_PAD;
        if (need > at.room) problems.push(`${where}: label "${e.label}" needs ${Math.round(need)} but the line is ${Math.round(at.room)} long`);
      }
      for (const n of spec.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        for (let i = 1; i < pts.length; i++) {
          if (segmentHitsBox(pts[i - 1], pts[i], shrink(boxOf(spec, n), 6))) { problems.push(`${where}: crosses node ${n.id}`); break; }
        }
      }
    }
    return problems;
  }

  function bounds(spec) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const n of spec.nodes) { const b = boxOf(spec, n); add(b.x, b.y); add(b.x + b.width, b.y + b.height); }
    for (const e of spec.edges) for (const p of edgePoints(spec, e)) add(p[0], p[1]);
    for (const g of spec.groups || []) { const f = frameOf(spec, g); add(f.x, f.y - 40); add(f.x + f.width, f.y + f.height); }
    if (spec.lanes && spec.lanes.length) {
      x0 = 0;
      for (const l of spec.lanes) { const b = laneOf(l); add(0, b.y); add(x1, b.y + b.height); }
    }
    return { x: x0 - MARGIN, y: y0 - MARGIN, width: x1 - x0 + 2 * MARGIN, height: y1 - y0 + 2 * MARGIN };
  }

  function frameOf(spec, g) {
    const byId = nodesById(spec);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const id of g.nodes) {
      const b = boxOf(spec, byId[id]);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    }
    return { x: x0 - FRAME_PAD, y: y0 - FRAME_PAD, width: x1 - x0 + 2 * FRAME_PAD, height: y1 - y0 + 2 * FRAME_PAD };
  }

  const laneOf = (l) => ({ y: l.rows[0] * CELL_H - 48, height: (l.rows[1] - l.rows[0]) * CELL_H + NODE_H + 96 });

  const core = { check, boxOf, wrapLabel, edgePoints, bounds };
  if (typeof module === "object" && module.exports) { module.exports = core; return; }

  const NS = "http://www.w3.org/2000/svg";
  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // A scene may spill past the text column, up to STAGE_MAX wide, so a four-column workflow reads at
  // full size on a laptop; print keeps the column.
  const STAGE_MAX = 1200;
  function draw(fig, printing) {
    const src = fig.querySelector("script.scene");
    if (!src) return;
    const spec = JSON.parse(src.textContent);
    const problems = check(spec);
    if (problems.length) console.error("scene", fig.id || "", problems);
    const bb = bounds(spec);
    const avail = printing ? fig.clientWidth : Math.max(fig.clientWidth, Math.min(STAGE_MAX, document.documentElement.clientWidth - 32));
    if (!avail) return;
    // Labels never drop under 15px: a wide scene on a phone scrolls inside its figure instead.
    const scale = Math.min(0.62, Math.max(avail / bb.width, 15 / NODE_FONT));
    const width = Math.round(bb.width * scale), height = Math.round(bb.height * scale);

    fig.querySelector(":scope > .stage")?.remove();
    const stage = document.createElement("div");
    stage.className = "stage";
    if (!printing && avail > fig.clientWidth) stage.style.cssText = `width:${avail}px;margin-left:${(fig.clientWidth - avail) / 2}px`;
    const cap = fig.querySelector("figcaption");
    const svg = el("svg", { viewBox: `${bb.x} ${bb.y} ${bb.width} ${bb.height}`, width, height, class: "drawn", role: "img", "aria-label": cap ? cap.textContent.trim() : "Workflow drawing" });
    stage.appendChild(svg);
    fig.insertBefore(stage, fig.firstChild);
    const rc = window.rough ? window.rough.svg(svg) : null;
    let seed = 11;
    const opt = (extra) => Object.assign({ roughness: 1, bowing: 1, stroke: PAINT.ink, strokeWidth: 3, seed: seed++ }, extra);
    const add = (node) => svg.appendChild(node);

    for (const l of spec.lanes || []) {
      const b = laneOf(l);
      el("rect", { x: 0, y: b.y, width: bb.x + bb.width, height: b.height, class: "lane" }, svg);
      const words = l.label.split(/\s+/);
      let line = "";
      const lines = [];
      for (const w of words) { if (line && (line + " " + w).length > 14) { lines.push(line); line = w; } else line = line ? line + " " + w : w; }
      lines.push(line);
      let ly = b.y + b.height / 2 - ((lines.length - 1) * LANE_FONT * LINE_H) / 2 + LANE_FONT * 0.35;
      for (const t of lines) { el("text", { x: 28, y: ly, class: "lane-t" }, svg).textContent = t; ly += LANE_FONT * LINE_H; }
    }

    for (const g of spec.groups || []) {
      const f = frameOf(spec, g);
      const o = opt({ stroke: "#8A8A8A", strokeWidth: 2, strokeLineDash: [14, 10], roughness: 0.6 });
      if (rc) add(rc.rectangle(f.x, f.y, f.width, f.height, o));
      el("text", { x: f.x + 6, y: f.y - 14, class: "grp" }, svg).textContent = g.label;
    }

    for (const e of spec.edges) {
      const pts = edgePoints(spec, e);
      const color = e.tone ? PAINT[e.tone][0] : PAINT.ink;
      const o = opt({ stroke: color, strokeWidth: e.strong ? 4 : 3, roughness: 0.8 });
      if (e.dashed) o.strokeLineDash = [16, 12];
      if (e.faint) o.stroke = "#B5B5B5";
      if (rc) add(pts.length > 4 ? rc.curve(pts, o) : rc.linearPath(pts, o));
      else el("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: o.stroke, "stroke-width": 3 }, svg);
      const heads = [[pts[pts.length - 2], pts[pts.length - 1]]];
      if (e.both) heads.push([pts[1], pts[0]]);
      for (const [p, q] of heads) {
        const ang = Math.atan2(q[1] - p[1], q[0] - p[0]), L = 24;
        const h = opt({ stroke: o.stroke, strokeWidth: o.strokeWidth, roughness: 0.6 });
        for (const d of [-0.42, 0.42]) {
          const a = [q[0] - L * Math.cos(ang + d), q[1] - L * Math.sin(ang + d)];
          if (rc) add(rc.line(q[0], q[1], a[0], a[1], h));
          else el("line", { x1: q[0], y1: q[1], x2: a[0], y2: a[1], stroke: h.stroke, "stroke-width": 3 }, svg);
        }
      }
    }

    for (const n of spec.nodes) {
      const b = boxOf(spec, n);
      const [line, fill] = n.tone ? PAINT[n.tone] : [PAINT.ink, PAINT.paper];
      const o = opt({ stroke: n.faint ? "#B5B5B5" : line, fill, fillStyle: "solid", strokeWidth: n.strong ? 5 : 3 });
      if (n.dashed) o.strokeLineDash = [16, 12];
      const { x, y, width: w, height: h } = b;
      if (n.shape === "text") { /* a bare label */ }
      else if (!rc) el("rect", { x, y, width: w, height: h, rx: 10, fill, stroke: line, "stroke-width": 3 }, svg);
      else if (n.shape === "ellipse") add(rc.ellipse(x + w / 2, y + h / 2, w, h, o));
      else if (n.shape === "diamond") add(rc.polygon([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], o));
      else if (n.shape === "doc") {
        const f = 34;
        add(rc.polygon([[x, y], [x + w - f, y], [x + w, y + f], [x + w, y + h], [x, y + h]], o));
        add(rc.linearPath([[x + w - f, y], [x + w - f, y + f], [x + w, y + f]], opt({ stroke: o.stroke, strokeWidth: 2, roughness: 0.6 })));
      } else if (n.shape === "store") {
        const r = STORE_CAP / 2;
        add(rc.path(`M${x} ${y + r} L${x} ${y + h - r} A${w / 2} ${r} 0 0 0 ${x + w} ${y + h - r} L${x + w} ${y + r} Z`, o));
        add(rc.ellipse(x + w / 2, y + r, w, 2 * r, opt({ stroke: o.stroke, fill, fillStyle: "solid", strokeWidth: o.strokeWidth })));
      } else add(rc.rectangle(x, y, w, h, o));

      const lines = wrapLabel(spec, n) || [n.label];
      const top = n.shape === "store" ? STORE_CAP : 0;
      const block = lines.length * NODE_FONT * LINE_H + (n.who ? WHO_FONT * 1.3 : 0);
      let ty = y + top + (h - top) / 2 - block / 2;
      if (n.who) { el("text", { x: x + w / 2, y: ty + WHO_FONT, class: "who" }, svg).textContent = n.who; ty += WHO_FONT * 1.3; }
      for (const t of lines) {
        el("text", { x: x + w / 2, y: ty + NODE_FONT * 0.95, class: n.faint ? "lbl faint" : "lbl" }, svg).textContent = t;
        ty += NODE_FONT * LINE_H;
      }
    }

    for (const e of spec.edges) {
      if (!e.label) continue;
      const at = labelAt(edgePoints(spec, e));
      const w = textWidth(e.label, EDGE_FONT) + 2 * LABEL_PAD;
      el("rect", { x: at.x - w / 2, y: at.y - EDGE_FONT * 0.75, width: w, height: EDGE_FONT * 1.5, rx: 6, class: "elbl-bg" }, svg);
      const t = el("text", { x: at.x, y: at.y + EDGE_FONT * 0.35, class: "elbl" }, svg);
      t.textContent = e.label;
      if (e.tone) t.setAttribute("fill", PAINT[e.tone][0]);
    }
  }

  const figs = [...document.querySelectorAll("figure.scene")];
  const all = (printing) => figs.forEach((f) => draw(f, printing === true));
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(all);
  let last = innerWidth, t;
  addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { if (Math.abs(innerWidth - last) > 8) { last = innerWidth; all(); } }, 120);
  });
  addEventListener("beforeprint", () => all(true));
  addEventListener("afterprint", () => all());
})();
