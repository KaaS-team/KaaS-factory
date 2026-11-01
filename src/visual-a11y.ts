// Accessibility rules for the visual step, on plain element facts so they test without a browser.
// The browser driver collects `A11yElement`s from a changed route; these rules judge them.

export interface A11yElement {
  readonly tag: string;
  readonly type?: string;
  readonly alt?: string | null;
  readonly role?: string;
  readonly label?: string; // aria-label, aria-labelledby text, or a <label for> text
  readonly foreground?: string; // #rgb or #rrggbb
  readonly background?: string;
  readonly largeText?: boolean;
  readonly selector: string;
}

export type A11yImpact = "serious" | "critical";
export interface A11yViolation {
  readonly rule: "image-alt" | "label" | "color-contrast";
  readonly impact: A11yImpact;
  readonly selector: string;
  readonly detail: string;
}

type Rgb = [number, number, number];

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function parseHex(color: string): Rgb | undefined {
  const raw = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!raw) return undefined;
  const h = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

// WCAG contrast ratio, 1 to 21. Undefined when either color is not a hex value.
export function contrastRatio(fg: string, bg: string): number | undefined {
  const a = parseHex(fg);
  const b = parseHex(bg);
  if (!a || !b) return undefined;
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const UNLABELLED_EXEMPT = new Set(["hidden", "submit", "button", "reset", "image"]);

export function a11yViolations(elements: readonly A11yElement[]): A11yViolation[] {
  const out: A11yViolation[] = [];
  for (const e of elements) {
    if (e.tag === "img" && e.role !== "presentation" && (e.alt === undefined || e.alt === null)) {
      out.push({ rule: "image-alt", impact: "critical", selector: e.selector, detail: "image has no alt text" });
    }
    if (["input", "select", "textarea"].includes(e.tag) && !UNLABELLED_EXEMPT.has(e.type ?? "") && !e.label?.trim()) {
      out.push({ rule: "label", impact: "critical", selector: e.selector, detail: "form field has no label" });
    }
    if (e.foreground && e.background) {
      const ratio = contrastRatio(e.foreground, e.background);
      const min = e.largeText ? 3 : 4.5;
      if (ratio !== undefined && ratio < min) {
        out.push({
          rule: "color-contrast",
          impact: "serious",
          selector: e.selector,
          detail: `contrast ${ratio.toFixed(2)}:1 is below ${min}:1`,
        });
      }
    }
  }
  return out;
}

export const a11yReport = (v: readonly A11yViolation[]) =>
  v.length === 0
    ? "No accessibility violations."
    : v.map((x) => `- ${x.impact} ${x.rule} ${x.selector}: ${x.detail}`).join("\n");
