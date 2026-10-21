// Draws each <figure class="flow"> from its own <ol>, so the list is the one source: screen readers and
// print read the list, the screen gets an lwp-deck style drawing (rough.js, roughness 1, Excalifont).
// A step is <li data-k="human|tool|gate|gap|wait|stop" data-who="..."><b>title</b> detail</li>.
// data-back="N" on a step draws a dashed red arrow back to step N (1-based): a revert or a reject.
(function () {
  const FILL = { human: "#FAFF69", tool: "#FFFFFF", gate: "#DFF9E9", gap: "#FCF0F0", wait: "#FDF6D3", stop: "#FCF0F0" };
  const STROKE = { gap: "#B4233A", stop: "#B4233A" };
  const NS = "http://www.w3.org/2000/svg";
  const GAP_X = 44, GAP_Y = 52, PAD = 14, TITLE = 17, BODY = 13;

  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function wrap(text, width, px, k = 0.52) {
    const max = Math.max(8, Math.floor(width / (px * k)));
    const lines = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (line && (line + " " + word).length > max) { lines.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    if (line) lines.push(line);
    return lines;
  }

  function steps(fig) {
    return [...fig.querySelectorAll(":scope > ol > li")].map((li) => {
      const b = li.querySelector("b");
      const title = b ? b.textContent.trim() : li.textContent.trim();
      const body = b ? li.textContent.replace(b.textContent, "").trim() : "";
      return { k: li.dataset.k || "tool", who: li.dataset.who || "", back: +li.dataset.back || 0, title, body };
    });
  }

  function draw(fig) {
    const list = steps(fig);
    const width = fig.clientWidth;
    if (!width || !list.length) return;
    const most = +fig.dataset.cols || 4;
    const cols = width < 520 ? 1 : width < 760 ? Math.min(3, most) : most;
    const w = (width - 4 - (cols - 1) * GAP_X) / cols;
    for (const s of list) {
      s.tl = wrap(s.title, w - 2 * PAD, TITLE);
      s.bl = s.body ? wrap(s.body, w - 2 * PAD, BODY, 0.5) : [];
      s.h = PAD * 2 + (s.who ? 18 : 0) + s.tl.length * (TITLE + 5) + (s.bl.length ? 6 + s.bl.length * (BODY + 5) : 0);
    }
    const rows = [];
    list.forEach((s, i) => { (rows[Math.floor(i / cols)] ||= []).push(s); });
    let y = 2;
    rows.forEach((row, r) => {
      const h = Math.max(...row.map((s) => s.h));
      row.forEach((s, c) => {
        const col = r % 2 === 0 || cols === 1 ? c : cols - 1 - c;
        s.x = 2 + col * (w + GAP_X); s.y = y; s.w = w; s.hh = h;
      });
      y += h + GAP_Y;
    });
    const height = y - GAP_Y + 4;

    fig.querySelector(":scope > svg")?.remove();
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "drawn", "aria-hidden": "true" });
    fig.insertBefore(svg, fig.firstChild);
    const rc = window.rough ? window.rough.svg(svg) : null;
    let seed = 7;
    const opt = (extra) => Object.assign({ roughness: 1, bowing: 1, stroke: "#1e1e1e", strokeWidth: 2, seed: seed++ }, extra);

    function box(s) {
      const o = opt({ fill: FILL[s.k], fillStyle: "solid", stroke: STROKE[s.k] || "#1e1e1e" });
      if (s.k === "gap" || s.k === "wait") o.strokeLineDash = [8, 6];
      if (rc) svg.appendChild(rc.rectangle(s.x, s.y, s.w, s.hh, o));
      else el("rect", { x: s.x, y: s.y, width: s.w, height: s.hh, rx: 6, fill: o.fill, stroke: o.stroke, "stroke-width": 2 }, svg);
      let ty = s.y + PAD;
      if (s.who) {
        el("text", { x: s.x + PAD, y: ty + 11, class: "who" }, svg).textContent = s.who;
        ty += 18;
      }
      s.tl.forEach((t) => { ty += TITLE + 2; el("text", { x: s.x + PAD, y: ty, class: "ttl" }, svg).textContent = t; ty += 3; });
      if (s.bl.length) ty += 6;
      s.bl.forEach((t) => { ty += BODY + 1; el("text", { x: s.x + PAD, y: ty, class: "bdy" }, svg).textContent = t; ty += 4; });
    }

    function arrow(x1, y1, x2, y2, back) {
      const o = opt(back ? { stroke: "#B4233A", strokeLineDash: [6, 5] } : {});
      const line = (a, b, c, d) => rc ? svg.appendChild(rc.line(a, b, c, d, o))
        : el("line", { x1: a, y1: b, x2: c, y2: d, stroke: o.stroke, "stroke-width": 2 }, svg);
      line(x1, y1, x2, y2);
      const ang = Math.atan2(y2 - y1, x2 - x1), L = 11;
      const head = Object.assign({}, o, { strokeLineDash: undefined });
      for (const d of [-0.45, 0.45]) {
        const a = x2 - L * Math.cos(ang + d), b = y2 - L * Math.sin(ang + d);
        if (rc) svg.appendChild(rc.line(x2, y2, a, b, head));
        else el("line", { x1: x2, y1: y2, x2: a, y2: b, stroke: o.stroke, "stroke-width": 2 }, svg);
      }
    }

    list.forEach(box);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (Math.abs(a.y - b.y) < 1) {
        const mid = a.y + Math.min(a.hh, b.hh) / 2;
        if (b.x > a.x) arrow(a.x + a.w + 4, mid, b.x - 4, mid);
        else arrow(a.x - 4, mid, b.x + b.w + 4, mid);
      } else {
        const x = a.x + a.w / 2;
        arrow(x, a.y + a.hh + 4, x, b.y - 4);
      }
    }
    list.forEach((s) => {
      if (!s.back) return;
      const t = list[s.back - 1];
      if (!t) return;
      if (Math.abs(t.y - s.y) < 1) {
        const yb = s.y + s.hh - 6;
        const x1 = s.x + s.w * 0.3, x2 = t.x + t.w * 0.7;
        if (rc) svg.appendChild(rc.path(`M${x1} ${yb} Q ${(x1 + x2) / 2} ${yb + GAP_Y * 0.9} ${x2} ${yb + 4}`,
          opt({ stroke: "#B4233A", strokeLineDash: [6, 5] })));
        arrow(x2 + 6, yb + 14, x2, yb + 4, true);
      } else {
        arrow(s.x + s.w * 0.25, s.y - 4, t.x + t.w * 0.25, t.y + t.hh + 4, true);
      }
    });
  }

  const figs = [...document.querySelectorAll("figure.flow")];
  const all = () => figs.forEach(draw);
  const ready = document.fonts ? document.fonts.ready : Promise.resolve();
  ready.then(all);
  let last = 0, t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { if (Math.abs(innerWidth - last) > 8) { last = innerWidth; all(); } }, 120);
  });
  window.addEventListener("beforeprint", all);
})();
