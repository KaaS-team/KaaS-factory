// Loads the runtime plugins that ship with the factory. FACTORY_DISABLE_PLUGINS (comma separated)
// skips one, and the core then runs with `local` and the machine's own runtimes only.
const off = new Set((process.env.FACTORY_DISABLE_PLUGINS ?? "").split(",").map((n) => n.trim()));
if (!off.has("lwpr")) await import("../contrib/runtimes/lwpr");
