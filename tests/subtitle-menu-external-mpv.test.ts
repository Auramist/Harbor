import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const body = readFileSync(
  new URL("../src/components/player/subtitle-menu/menu-body.tsx", import.meta.url),
  "utf8",
);

test("with your own mpv, the subtitle panel says where Harbor's subtitles went", () => {
  assert.match(body, /const externalMpv = externalMpvEnabled\(/);
  assert.match(
    body,
    /Harbor sends its subtitles to your mpv\. Pick one in mpv's own subtitle menu\./,
  );
  // Harbor's own list is always empty then, so "No subtitles found yet" would be wrong.
  assert.match(body, /!externalMpv &&\s*\(?\s*<EmptyState/);
});
