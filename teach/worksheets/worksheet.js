// Worksheets: every .f box is editable, saved in this browser as you type, printed as written,
// and exported as one Markdown file (each part a heading, each table a Markdown table).
(function () {
  const page = location.pathname.split("/").pop() || "index.html";
  const key = "sf-worksheet:" + page;
  const fields = Array.from(document.querySelectorAll(".f"));
  fields.forEach((el, i) => {
    el.setAttribute("contenteditable", "plaintext-only");
    if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
    el.dataset.k = el.dataset.k || "f" + i;
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "true");
    const label = el.closest("label");
    const th = el.matches("td") && el.closest("table").querySelectorAll("thead th")[el.cellIndex];
    const name = label ? label.firstChild.textContent : th ? (el.parentElement.cells[0].textContent + ": " + th.textContent) : el.dataset.ph;
    el.setAttribute("aria-label", (name || "Answer").trim());
  });

  // Pasted text arrives as plain text, so Markdown copied from anywhere keeps its shape.
  document.addEventListener("paste", (e) => {
    if (!e.target.classList || !e.target.classList.contains("f")) return;
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });

  function read() {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  }
  const saved = read();
  fields.forEach((el) => { if (saved[el.dataset.k]) el.textContent = saved[el.dataset.k]; });

  const status = document.querySelector("[data-saved]");
  const say = (t) => { if (status) status.textContent = t; };
  let timer;
  function save() {
    const data = {};
    fields.forEach((el) => { if (el.textContent.trim()) data[el.dataset.k] = el.textContent; });
    try {
      localStorage.setItem(key, JSON.stringify(data));
      say("Saved in this browser");
    } catch {
      say("Not saved: this browser blocks storage. Download before closing.");
    }
  }
  document.addEventListener("input", (e) => {
    if (!e.target.classList || !e.target.classList.contains("f")) return;
    if (!e.target.textContent.trim()) e.target.textContent = "";
    clearTimeout(timer);
    timer = setTimeout(save, 300);
  });

  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const cell = (el) => text(el).replace(/\|/g, "\\|") || " ";
  // A label's own words, without the answer box inside it.
  function labelText(label) {
    const copy = label.cloneNode(true);
    copy.querySelectorAll(".f").forEach((f) => f.remove());
    return text(copy);
  }
  function answer(el) {
    const t = el.textContent.trim();
    return t ? (t.includes("\n") ? "\n\n" + t : " " + t) : " _blank_";
  }
  function table(tw) {
    const head = Array.from(tw.querySelectorAll("thead th")).map(cell);
    const out = ["", "| " + head.join(" | ") + " |", "|" + head.map(() => " --- ").join("|") + "|"];
    tw.querySelectorAll("tbody tr").forEach((tr) => {
      out.push("| " + Array.from(tr.cells).map((c) => text(c) ? cell(c) : " ").join(" | ") + " |");
    });
    return out.concat("");
  }

  // Every part becomes a heading; labelled boxes become "**Label**: answer"; tables stay tables.
  function markdown() {
    const out = ["# " + text(document.querySelector("h1"))];
    document.querySelectorAll("header .row > label").forEach((l) => out.push("", "**" + labelText(l) + "**:" + answer(l.querySelector(".f"))));
    document.querySelectorAll("section").forEach((s) => {
      const h = s.querySelector("h2");
      const parts = Array.from(s.querySelectorAll(".row > label, label.stack, .tw"));
      if (!h || !parts.length) return;
      out.push("", "## " + text(h).replace(/^(\d+)\s*/, "$1. "));
      parts.forEach((el) => {
        if (el.classList.contains("tw")) out.push(...table(el));
        else out.push("", "**" + labelText(el) + "**:" + answer(el.querySelector(".f")));
      });
    });
    return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  }

  function fileName() {
    const name = text(document.querySelector('[data-k="name"]')).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return page.replace(/\.html$/, "") + (name ? "-" + name : "") + ".md";
  }

  const copy = document.querySelector("[data-copy]");
  if (copy) copy.addEventListener("click", () => {
    navigator.clipboard.writeText(markdown()).then(
      () => say("Copied as Markdown"),
      () => say("Copy is blocked here. Use Download .md instead."),
    );
  });

  const download = document.querySelector("[data-download]");
  if (download) download.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown" }));
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    say("Downloaded " + a.download);
  });

  const print = document.querySelector("[data-print]");
  if (print) print.addEventListener("click", () => window.print());

  const clear = document.querySelector("[data-clear]");
  if (clear) {
    let armed = false;
    clear.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        clear.textContent = "Click again to erase";
        setTimeout(() => { armed = false; clear.textContent = "Clear"; }, 4000);
        return;
      }
      fields.forEach((el) => { el.textContent = ""; });
      try { localStorage.removeItem(key); } catch {}
      clear.textContent = "Clear";
      armed = false;
      say("Cleared");
    });
  }
})();
