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
  const module = {
    exports: {} as {
      applySubStyle: (s: Settings, context: Record<string, unknown>) => Promise<void>;
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
