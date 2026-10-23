import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { Settings } from "../src/lib/settings";

const BASE = {
  subAssOverride: "no",
  subFontFamily: "serif",
  subFontSize: 32,
  subFontColor: "#FFFFFF",
  subBorderColor: "#000000",
  subBorderSize: 0,
  subMarginY: 10,
  subAlignX: "center",
  subStyle: "shadow",
  subOpacity: 1,
  subBoxOpacity: 0.6,
  subBoxColor: "#000000",
  subLineSpacing: 0,
  subBold: false,
  subHideSdh: false,
  customFonts: [],
};

/** Loads a fresh copy of sub-style.ts and records the mpv properties each apply sets. */
function styleHarness() {
  const source = readFileSync(new URL("../src/lib/player/sub-style.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let calls: Array<[string, unknown]> = [];
  type Mode = Settings["subAssOverride"];
  const module = {
    exports: {} as {
      applySubStyle: (s: Settings, context: Record<string, unknown>) => Promise<void>;
      isAssLookMode: (mode: Mode) => boolean;
      flipAssOverride: (mode: Mode, before: Mode) => { mode: Mode; before: Mode };
    },
  };
  new Function("require", "module", "exports", compiled)(
    (id: string) => {
      if (id !== "@tauri-apps/api/core") throw new Error(`Unexpected dependency: ${id}`);
      return {
        invoke: async (command: string, args: { name: string; value: unknown }) => {
          if (command === "mpv_set_property") calls.push([args.name, args.value]);
        },
      };
    },
    module,
    module.exports,
  );
  return {
    exports: module.exports,
    async apply(overrides: Record<string, unknown>) {
      calls = [];
      await module.exports.applySubStyle({ ...BASE, ...overrides } as unknown as Settings, {
        assNativeActive: true,
        imageNativeActive: false,
      });
      return new Map(calls);
    },
  };
}

test("Change font only keeps the ASS look and swaps in the user's font", async () => {
  const props = await styleHarness().apply({ subAssOverride: "font" });
  assert.equal(props.get("sub-ass-override"), "yes");
  assert.equal(props.get("sub-ass-style-overrides"), "FontName=Times New Roman");
  assert.equal(props.get("sub-ass-force-margins"), "no");
  assert.equal(props.get("sub-pos"), 100);
});

test("leaving Change font only clears Harbor's font override", async () => {
  const h = styleHarness();
  await h.apply({ subAssOverride: "font" });
  const props = await h.apply({ subAssOverride: "force" });
  assert.equal(props.get("sub-ass-override"), "force");
  assert.equal(props.get("sub-ass-style-overrides"), "");
});

test("other modes leave a style override from the user's own mpv options alone", async () => {
  const h = styleHarness();
  for (const mode of ["no", "scale", "force"]) {
    const props = await h.apply({ subAssOverride: mode });
    assert.equal(props.has("sub-ass-style-overrides"), false, mode);
  }
});

test("a comma in a custom font name cannot split mpv's override list", async () => {
  const props = await styleHarness().apply({
    subAssOverride: "font",
    subFontFamily: "custom:mine",
    customFonts: [{ id: "mine", name: "Mine", family: "Comic, Neue" }],
  });
  assert.equal(props.get("sub-ass-style-overrides"), "FontName=Comic Neue");
});

test("Change font only adds the font to overrides from the user's own mpv options", async () => {
  const props = await styleHarness().apply({
    subAssOverride: "font",
    mpvExtraOptions: "# my options\r\n--sub-ass-style-overrides=ScaledBorderAndShadow=yes\r\n",
  });
  assert.equal(
    props.get("sub-ass-style-overrides"),
    "ScaledBorderAndShadow=yes,FontName=Times New Roman",
  );
});

test("leaving Change font only puts the user's own overrides back", async () => {
  const h = styleHarness();
  const mpvExtraOptions = "sub-ass-style-overrides=ScaledBorderAndShadow=yes";
  await h.apply({ subAssOverride: "font", mpvExtraOptions });
  const props = await h.apply({ subAssOverride: "no", mpvExtraOptions });
  assert.equal(props.get("sub-ass-style-overrides"), "ScaledBorderAndShadow=yes");
});

test("the player's override switch goes back to the mode from before", () => {
  const { isAssLookMode, flipAssOverride } = styleHarness().exports;
  // "Change font only" keeps each subtitle's look, so the switch shows off.
  assert.equal(isAssLookMode("font"), true);
  assert.equal(isAssLookMode("force"), false);
  const on = flipAssOverride("font", "no");
  assert.deepEqual(on, { mode: "force", before: "font" });
  assert.deepEqual(flipAssOverride(on.mode, on.before), { mode: "font", before: "font" });
  assert.deepEqual(flipAssOverride("scale", "no"), { mode: "force", before: "scale" });
  assert.deepEqual(flipAssOverride("yes", "no"), { mode: "no", before: "no" });
});

test("the player's override switch uses these mode rules", () => {
  const menu = readFileSync(
    new URL("../src/components/player/sub-style-bar/advanced-menu.tsx", import.meta.url),
    "utf8",
  );
  assert.match(menu, /const overrideOn = !isAssLookMode\(settings\.subAssOverride\);/);
  assert.match(menu, /flipAssOverride\(settings\.subAssOverride, assModeBeforeOverride\)/);
  assert.match(menu, /assModeBeforeOverride = next\.before;/);
});
