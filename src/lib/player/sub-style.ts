import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "@/lib/settings";

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function mpvColor(hex: string, opacity: number): string {
  const rgb = hex.startsWith("#") && hex.length === 7 ? hex.slice(1).toUpperCase() : "FFFFFF";
  const a = Math.round(clamp(opacity, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `#${a}${rgb}`;
}

function mpvFontFor(id: string, customName?: string): string {
  if (id.startsWith("custom:")) return customName || "Inter";
  switch (id) {
    case "arabic":
      return "Vazirmatn";
    case "system":
      return "Segoe UI";
    case "serif":
      return "Times New Roman";
    case "rounded":
      return "Fredoka";
    default:
      return "Inter";
  }
}

function customFontName(s: Settings): string | undefined {
  if (!s.subFontFamily?.startsWith("custom:")) return undefined;
  const id = s.subFontFamily.slice("custom:".length);
  const f = (s.customFonts ?? []).find((x) => x.id === id);
  return f?.family || f?.name;
}

let secondaryStyleRevision = 0;
let secondaryStyleQueue: Promise<void> = Promise.resolve();

/** HDR surfaces need mpv to draw the second subtitle instead of the HTML overlay. */
export function applySecondarySubNative(
  on: boolean,
  placement: Settings["subSecondaryPlacement"],
  marginY: number,
): Promise<void> {
  const revision = ++secondaryStyleRevision;
  // Serialize native writes so a delayed enable cannot overtake a later disable.
  secondaryStyleQueue = secondaryStyleQueue.then(async () => {
    if (revision !== secondaryStyleRevision) return;
    if (on) {
      const pos = placement === "top" ? 0 : clamp(100 - (Number(marginY) || 0) - 8, 0, 100);
      await invoke("mpv_set_property", { name: "secondary-sub-pos", value: pos }).catch(() => {});
      if (revision !== secondaryStyleRevision) return;
    }
    await invoke("mpv_set_property", {
      name: "secondary-sub-visibility",
      value: on,
    }).catch(() => {});
  });
  return secondaryStyleQueue;
}

export type SubRenderContext = {
  assNativeActive: boolean;
  imageNativeActive: boolean;
  assScale?: number;
  sdhFilterAllowed?: boolean;
};

/** ASS modes that keep each styled subtitle's own look, so the player's override switch is off. */
export type AssLookMode = "no" | "scale" | "font";

export function isAssLookMode(mode: Settings["subAssOverride"]): mode is AssLookMode {
  return mode === "no" || mode === "scale" || mode === "font";
}

/**
 * Flips the player's "Override embedded styles" switch. Switching it off goes back to the mode
 * the user had before, so "Change font only" or the size option isn't lost on the way.
 */
export function flipAssOverride(
  mode: Settings["subAssOverride"],
  before: AssLookMode,
): { mode: Settings["subAssOverride"]; before: AssLookMode } {
  return isAssLookMode(mode) ? { mode: "force", before: mode } : { mode: before, before };
}

/**
 * The sub-ass-style-overrides value from the user's own mpv options in Harbor. mpv gets those
 * lines when it starts (parse_extra_option_lines in mpv.rs), so a later line wins.
 */
function ownStyleOverrides(extra: string | undefined): string {
  let value = "";
  for (const raw of (extra ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const eq = line.indexOf("=");
    const cut = eq >= 0 ? eq : line.search(/\s/);
    const key = (cut >= 0 ? line.slice(0, cut) : line)
      .trim()
      .replace(/^(?:--)+/, "")
      .trim();
    if (key === "sub-ass-style-overrides") value = cut >= 0 ? line.slice(cut + 1).trim() : "yes";
  }
  return value;
}

// Harbor only touches mpv's style overrides while "Change font only" is on. It adds the font to
// the overrides from the user's own mpv options, and puts those back when the mode is left.
let fontOnlyApplied = false;

export async function applySubStyle(
  s: Settings,
  context: SubRenderContext = { assNativeActive: false, imageNativeActive: false },
): Promise<void> {
  const override = s.subAssOverride;
  // "Change font only" keeps the ASS look like "no". mpv's "yes" then lets the style override
  // below swap in the user's font.
  const fontOnly = override === "font";
  const keepAssLook = override === "no" || fontOnly;
  const normScale =
    typeof context.assScale === "number" && Number.isFinite(context.assScale)
      ? context.assScale
      : null;
  const effOverride = fontOnly ? "yes" : normScale != null ? "scale" : override;
  const assMargins = context.assNativeActive && !keepAssLook ? "yes" : "no";
  const marginY = clamp(Number(s.subMarginY) || 0, 0, 100);
  const opacity = clamp(Number(s.subOpacity ?? 1), 0.1, 1);
  const boxOpacity = clamp(Number(s.subBoxOpacity ?? 0.6), 0, 1);
  const isBox = s.subStyle === "box";
  const isShadow = s.subStyle === "shadow";
  const reposition = !context.assNativeActive || !keepAssLook;
  const hideSdh = s.subHideSdh === true && context.sdhFilterAllowed !== false;
  const font = mpvFontFor(s.subFontFamily, customFontName(s));
  const props: Array<[string, unknown]> = [
    ["sub-filter-sdh", hideSdh],
    ["sub-filter-sdh-harder", false],
    ["sub-font-size", 32],
    ["sub-font", font],
    [
      "sub-scale",
      normScale != null
        ? clamp(normScale, 0.2, 6)
        : Math.min(4, Math.max(0.4, (Number(s.subFontSize) || 32) / 32)),
    ],
    ["sub-color", mpvColor(s.subFontColor, opacity)],
    ["sub-border-color", mpvColor(s.subBorderColor, opacity)],
    ["sub-border-size", s.subBorderSize],
    ["sub-back-color", isBox ? mpvColor(s.subBoxColor, boxOpacity * opacity) : "#00000000"],
    ["sub-shadow-color", mpvColor("#000000", opacity)],
    ["sub-shadow-offset", isShadow ? 1.4 : 0],
    ["sub-margin-y", marginY],
    ["sub-align-x", s.subAlignX],
    ["sub-ass-override", effOverride],
    ["sub-ass-force-margins", assMargins],
    ["sub-use-margins", assMargins],
    ["sub-spacing", s.subLineSpacing],
    ["sub-bold", s.subBold ? "yes" : "no"],
    ["sub-pos", reposition ? clamp(100 - marginY, 0, 100) : 100],
  ];
  if (fontOnly || fontOnlyApplied) {
    const own = ownStyleOverrides(s.mpvExtraOptions);
    // mpv reads this as a comma-separated list, so a comma in the name would split it.
    const fontName = `FontName=${font.replace(/,/g, "")}`;
    props.push([
      "sub-ass-style-overrides",
      fontOnly ? [own, fontName].filter(Boolean).join(",") : own,
    ]);
    fontOnlyApplied = fontOnly;
  }
  await Promise.all(
    props.map(([name, value]) => invoke("mpv_set_property", { name, value }).catch(() => {})),
  );
}
