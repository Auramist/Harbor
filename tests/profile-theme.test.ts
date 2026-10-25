import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROFILE_THEME,
  PROFILE_PALETTES,
  PROFILE_PALETTE_ORDER,
  isDefaultProfileTheme,
  parseProfileTheme,
  profileThemeBackground,
  profileThemeScope,
  stripProfileTheme,
  withProfileTheme,
  type ProfileTheme,
} from "../src/lib/profile-theme";
import { resolveCustomization } from "../src/views/profile/customization/apply";
import type { ProfileSummary } from "../src/views/profile/profile-types";

const noir: ProfileTheme = { palette: "noir", glass: false, gradient: false };

test("a theme round-trips through the profile's custom CSS", () => {
  const css = withProfileTheme("", { palette: "forest", glass: true, gradient: true });
  assert.deepEqual(parseProfileTheme(css), { palette: "forest", glass: true, gradient: true });
});

test("the owner's css survives, with the marker kept out of it", () => {
  const userCss = ".card {\n  border-radius: 0;\n}";
  const stored = withProfileTheme(userCss, noir);
  assert.ok(stored.includes(".card {"));
  assert.equal(stripProfileTheme(stored), userCss);
  assert.ok(!stripProfileTheme(stored).includes("harbor-profile-theme"));
});

test("re-applying a theme replaces the marker instead of stacking markers", () => {
  const once = withProfileTheme("a{color:red}", noir);
  const twice = withProfileTheme(once, { palette: "paper", glass: false, gradient: false });
  assert.equal(twice.match(/harbor-profile-theme/g)?.length, 1);
  assert.equal(parseProfileTheme(twice).palette, "paper");
  assert.equal(stripProfileTheme(twice), "a{color:red}");
});

test("going back to automatic removes the marker entirely", () => {
  const themed = withProfileTheme("a{color:red}", { palette: "rose", glass: true, gradient: true });
  const cleared = withProfileTheme(themed, DEFAULT_PROFILE_THEME);
  assert.equal(cleared, "a{color:red}");
  assert.equal(isDefaultProfileTheme(parseProfileTheme(cleared)), true);
});

test("absent, broken or unknown markers fall back to automatic", () => {
  assert.deepEqual(parseProfileTheme(""), DEFAULT_PROFILE_THEME);
  assert.deepEqual(parseProfileTheme(null), DEFAULT_PROFILE_THEME);
  assert.deepEqual(parseProfileTheme("a{color:red}"), DEFAULT_PROFILE_THEME);
  assert.deepEqual(parseProfileTheme("/*harbor-profile-theme:{not json}*/"), DEFAULT_PROFILE_THEME);
  assert.deepEqual(parseProfileTheme('/*harbor-profile-theme:{"palette":"neon","glass":true}*/'), {
    palette: "auto",
    glass: true,
    gradient: false,
  });
});

test("boolean flags must be literal true", () => {
  const parsed = parseProfileTheme(
    '/*harbor-profile-theme:{"palette":"ocean","glass":"yes","gradient":1}*/',
  );
  assert.deepEqual(parsed, { palette: "ocean", glass: false, gradient: false });
});

test("each palette paints every token the profile styles read", () => {
  const required = [
    "--color-canvas",
    "--color-surface",
    "--color-elevated",
    "--color-raised",
    "--color-ink",
    "--color-ink-muted",
    "--color-ink-subtle",
    "--color-edge",
    "--color-edge-soft",
    "--color-accent",
    "--color-accent-soft",
  ];
  for (const id of PROFILE_PALETTE_ORDER) {
    if (id === "auto") continue;
    const palette = PROFILE_PALETTES[id];
    assert.equal(palette.id, id);
    for (const token of required) {
      assert.ok(palette.tokens[token], `${id} is missing ${token}`);
      assert.ok(!palette.tokens[token].includes("*/"), `${id}.${token} could break the marker`);
    }
  }
});

test("automatic follows the viewer and paints nothing", () => {
  const scope = profileThemeScope(DEFAULT_PROFILE_THEME);
  assert.deepEqual(scope.vars, {});
  assert.equal(scope.backgroundColor, "");
  assert.equal(scope.backgroundImage, "");
  assert.equal(scope.ui, "");
  assert.equal(scope.colorScheme, undefined);
});

test("a palette scopes its own tokens and paints the canvas", () => {
  const scope = profileThemeScope(noir);
  assert.equal(scope.vars["--color-canvas"], "#000000");
  assert.equal(scope.backgroundColor, "var(--color-canvas)");
  assert.equal(scope.colorScheme, "dark");
  assert.equal(scope.ui, "");
});

test("glass and gradient become stylesheet hooks", () => {
  const scope = profileThemeScope({ palette: "violet", glass: true, gradient: true });
  assert.equal(scope.ui, "glass gradient");
  assert.ok(scope.backgroundImage.includes("var(--color-accent)"));
});

test("a light palette switches the profile's colour scheme", () => {
  const scope = profileThemeScope({ palette: "paper", glass: false, gradient: false });
  assert.equal(scope.colorScheme, "light");
});

const summary = (over: Partial<ProfileSummary>): ProfileSummary => ({
  handle: "alice",
  alias: "Alice",
  verified: false,
  featured: false,
  level: 1,
  xp: 0,
  xpToNext: 100,
  online: false,
  memberSince: "2024-01-01",
  counts: { watched: 0, friends: 0, badges: 0, hoursWatched: 0 },
  isOwner: false,
  ...over,
});

test("a visitor sees the owner's theme even with custom profile switched off", () => {
  const stored = withProfileTheme(".x{color:red}", {
    palette: "ocean",
    glass: true,
    gradient: false,
  });
  const c = resolveCustomization(summary({ customEnabled: false, customCss: stored }));
  assert.equal(c.theme.palette, "ocean");
  assert.equal(c.theme.glass, true);
  assert.equal(c.themeScope.ui, "glass");
  // The canvas is still gated, and never renders the marker as CSS.
  assert.equal(c.hasCanvas, false);
  assert.equal(c.css, ".x{color:red}");
});

test("a marker-only custom css counts as no canvas", () => {
  const stored = withProfileTheme("", { palette: "paper", glass: false, gradient: true });
  const c = resolveCustomization(summary({ isOwner: true, customCss: stored }));
  assert.equal(c.theme.palette, "paper");
  assert.equal(c.themeScope.backgroundImage !== "", true);
  assert.equal(c.hasCanvas, false);
});

test("the owner's custom page background wins over the theme's", () => {
  const scope = profileThemeScope({ palette: "noir", glass: false, gradient: true });
  assert.deepEqual(profileThemeBackground(scope, "url(https://example.com/a.png)"), {
    background: "url(https://example.com/a.png)",
  });
  assert.deepEqual(profileThemeBackground(scope, ""), {
    backgroundColor: "var(--color-canvas)",
    backgroundImage: scope.backgroundImage,
  });
});
