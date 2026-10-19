// Worksheets: every .f field is editable, saved in this browser as you type, and printed as written.
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
    if (el.dataset.ph) el.setAttribute("aria-label", el.dataset.ph);
  });

  function read() {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  }
  const saved = read();
  fields.forEach((el) => { if (saved[el.dataset.k]) el.textContent = saved[el.dataset.k]; });

  const status = document.querySelector("[data-saved]");
  let timer;
  function save() {
    const data = {};
    fields.forEach((el) => { const t = el.textContent.trim(); if (t) data[el.dataset.k] = el.textContent; });
    try {
      localStorage.setItem(key, JSON.stringify(data));
      if (status) status.textContent = "Saved in this browser";
    } catch {
      if (status) status.textContent = "Not saved: this browser blocks storage. Print to PDF before closing.";
    }
  }
  document.addEventListener("input", (e) => {
    if (!e.target.classList || !e.target.classList.contains("f")) return;
    if (!e.target.textContent.trim()) e.target.textContent = "";
    clearTimeout(timer);
    timer = setTimeout(save, 300);
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
      if (status) status.textContent = "Cleared";
    });
  }
})();
