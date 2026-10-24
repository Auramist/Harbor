import assert from "node:assert/strict";
import test from "node:test";
import { saveNuvioState, loadNuvioState } from "../src/lib/nuvio/nuvio-client";
import {
  pullWatchProgressFromNuvio,
  pullWatchedItemsFromNuvio,
  reconcileNuvioWatched,
  pushWatchProgressToNuvio,
  pushWatchedItemToNuvio,
  deleteWatchedItemFromNuvio,
  deleteEpisodeWatchProgressFromNuvio,
  resolveNuvioProfileIndex,
  readCachedWatchProgress,
  writeCachedWatchProgress,
} from "../src/lib/nuvio/nuvio-sync";
import type { NuvioWatchProgress } from "../src/lib/nuvio/nuvio-types";
import { localCwEntry, saveLocalCw } from "../src/lib/local-cw";
import { buildNuvioPlaybackItems } from "../src/lib/nuvio/nuvio-playback";
import { getNuvioActiveSlot } from "../src/lib/active-profile-id";
import { readResumeEntry, saveResumeMs } from "../src/lib/resume";

const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
} as Storage;

if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as Record<string, unknown>).window = {
    dispatchEvent: () => true,
    addEventListener() {},
    removeEventListener() {},
  };
}

const NOW = 1_800_000_000_000;

function progress(contentId: string, episode: number, when: number): NuvioWatchProgress {
  return {
    profile_id: 1,
    content_id: contentId,
    progress_key: `${contentId}_s1e${episode}`,
    season: 1,
    episode,
    progress_seconds: 120,
    duration_seconds: 1200,
    last_watched: when,
    updated_at: new Date(when).toISOString(),
  };
}

async function withSnapshot(
  transport: "rpc" | "table",
  name: string,
  rows: NuvioWatchProgress[],
  run: (accountId: string) => Promise<void>,
  activeProfileIndex = 1,
  checkCalls = true,
) {
  storage.clear();
  storage.set("harbor.account-provider", "nuvio");
  const accountId = `progress-${transport}-${name}`;
  saveNuvioState({
    session: {
      access_token: "test-token",
      refresh_token: "test-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { id: accountId },
    },
    profiles: [1, 2].map((slot) => ({
      id: `profile-${slot}`,
      name: `Profile ${slot}`,
      profile_index: slot,
      user_id: accountId,
    })),
    activeProfileIndex,
    lastSyncedAt: null,
  });
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  let tableCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/rpc/sync_pull_watch_progress")) {
      rpcCalls++;
      return {
        ok: transport === "rpc",
        status: transport === "rpc" ? 200 : 404,
        json: async () => rows.slice(0, 50),
      } as Response;
    }
    assert.ok(String(url).includes("/rest/v1/watch_progress?"));
    tableCalls++;
    const offset = Number(/[?&]offset=(\d+)/.exec(String(url))?.[1] ?? 0);
    const page = rows.slice(offset, offset + 1000);
    return {
      ok: true,
      status: 200,
      json: async () => page,
      headers: new Headers({
        "Content-Range": page.length
          ? `${offset}-${offset + page.length - 1}/${rows.length}`
          : `*/${rows.length}`,
      }),
    } as Response;
  };
  try {
    await run(accountId);
    if (checkCalls) {
      assert.equal(rpcCalls, 1);
      assert.equal(tableCalls, Math.max(1, Math.ceil(rows.length / 1000)));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const transport of ["rpc", "table"] as const) {
  test(`${transport}: removing an episode preserves surviving coordinates and other profile resumes`, async () => {
    const older = progress("kitsu:12", 1, NOW - 2000);
    const previousLive = {
      ...progress("kitsu:12", 2, NOW - 1000),
      progress_key: "legacy-live-key",
    };
    const special = {
      ...progress("kitsu:12", 2, NOW - 3000),
      season: 0,
      progress_key: "special-key",
    };
    const removed = progress("kitsu:99", 9, NOW - 4000);
    const live = { ...progress("kitsu:12", 2, NOW), progress_seconds: 220 };
    await withSnapshot(
      transport,
      "prune",
      [live],
      async (accountId) => {
        writeCachedWatchProgress(1, [older, previousLive, special, removed], accountId);
        saveResumeMs("kitsu:12", 110000, 1, 1, undefined, undefined, undefined, "nuvio-1");
        saveResumeMs("kitsu:12", 220000, 1, 2, undefined, undefined, undefined, "nuvio-1");
        saveResumeMs("kitsu:12", 330000, 0, 2, undefined, undefined, undefined, "nuvio-1");
        saveResumeMs("kitsu:99", 440000, 1, 9, undefined, undefined, undefined, "nuvio-1");
        saveResumeMs("kitsu:99", 550000, 1, 9, undefined, undefined, undefined, "nuvio-2");
        const local = {
          id: "kitsu:99",
          name: "Removed show",
          type: "series" as const,
          season: 1,
          episode: 9,
          positionMs: 440000,
          durationMs: 1200000,
          t: NOW - 4000,
        };
        saveLocalCw(local, "nuvio-1");
        saveLocalCw(local, "nuvio-2");

        await pullWatchProgressFromNuvio(1);

        assert.equal(readResumeEntry("kitsu:12", 1, 1, "nuvio-1"), null);
        assert.equal(readResumeEntry("kitsu:12", 0, 2, "nuvio-1"), null);
        assert.equal(readResumeEntry("kitsu:12", 1, 2, "nuvio-1")?.ms, 220000);
        assert.equal(readResumeEntry("kitsu:99", 1, 9, "nuvio-1"), null);
        assert.equal(readResumeEntry("kitsu:99", 1, 9, "nuvio-2")?.ms, 550000);
        assert.equal(localCwEntry("kitsu:99", false, "nuvio-1"), null);
        assert.equal(localCwEntry("kitsu:99", false, "nuvio-2")?.episode, 9);
        assert.deepEqual(
          readCachedWatchProgress(1, accountId).map((row) => row.progress_key),
          [live.progress_key],
        );
      },
      2,
    );
  });

  for (const capped of [false, true]) {
    test(`${transport}: ${capped ? "capped history retains" : "complete history selects"} the latest local CW checkpoint`, async () => {
      // The newest record can be a rewatch of an earlier episode.
      const older = progress("kitsu:12", 2, NOW - 20000);
      const latest = progress("kitsu:12", 1, NOW);
      const limit = transport === "rpc" ? 50 : 1000;
      const rows = capped
        ? [
            latest,
            ...Array.from({ length: limit - 1 }, (_, i) => progress(`tt-${i}`, 1, NOW - 1000 - i)),
            older,
          ]
        : [older, latest];
      await withSnapshot(transport, `latest-${capped}`, rows, async (accountId) => {
        writeCachedWatchProgress(1, [older, latest], accountId);
        saveResumeMs("kitsu:12", 90000, 1, 2, undefined, undefined, undefined, "nuvio-1");

        const result = await pullWatchProgressFromNuvio(1);

        assert.equal(result.length, capped ? limit + 1 : 2);
        assert.ok(result.some((row) => row.progress_key === older.progress_key));
        assert.equal(readResumeEntry("kitsu:12", 1, 2, "nuvio-1")?.ms, 90000);
        const local = localCwEntry("kitsu:12", false, "nuvio-1");
        assert.equal(local?.episode, 1);
        assert.equal(local?.positionMs, 120000);
        assert.equal(local?.t, NOW);
      });
    });
  }
}

function response(rows: unknown[], status = 200, range?: string): Response {
  return new Response(JSON.stringify(rows), {
    status,
    headers: { "Content-Type": "application/json", ...(range ? { "Content-Range": range } : {}) },
  });
}

function customSnapshot(name: string, run: (accountId: string) => Promise<void>) {
  return withSnapshot("rpc", name, [], run, 1, false);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const switchTo of ["profile", "provider"] as const) {
  test(`a late empty progress fallback cannot clear a different ${switchTo}`, async () => {
    await customSnapshot(`scope-${switchTo}`, async () => {
      const profiles = [1, 2].map((slot) => ({ id: `nuvio-${slot}`, isPrimary: slot === 1 }));
      storage.set("harbor.profiles.v1", JSON.stringify({ activeId: "nuvio-1", profiles }));
      const entry = {
        id: "scope-survivor",
        type: "series" as const,
        name: "Survivor",
        season: 1,
        episode: 2,
        positionMs: 80000,
        durationMs: 1000000,
        t: NOW,
      };
      saveLocalCw(entry, "nuvio-2");
      let finish!: (value: Response) => void;
      const deferred = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      globalThis.fetch = async () => deferred;
      const work = pullWatchProgressFromNuvio(1);
      await tick();
      if (switchTo === "profile") {
        saveNuvioState({ ...loadNuvioState(), activeProfileIndex: 2 });
        storage.set("harbor.profiles.v1", JSON.stringify({ activeId: "nuvio-2", profiles }));
      } else storage.set("harbor.account-provider", "stremio");
      finish(response([], 503));
      assert.deepEqual(await work, []);
      assert.ok(localCwEntry(entry.id, false, "nuvio-2"));
    });
  });
}

test("concurrent progress pulls share the same request and verified snapshot", async () => {
  await withSnapshot("rpc", "single-progress", [progress("shared", 1, NOW)], async () => {
    const first = pullWatchProgressFromNuvio(1);
    const second = pullWatchProgressFromNuvio(1);
    assert.strictEqual(first, second);
    await first;
  });
});

test("an older cloud response cannot overwrite a newer native checkpoint", async () => {
  await withSnapshot(
    "rpc",
    "newer-local",
    [progress("newer", 1, NOW - 60000)],
    async (accountId) => {
      const newer = { ...progress("newer", 1, NOW), progress_seconds: 900 };
      writeCachedWatchProgress(1, [newer], accountId);
      saveLocalCw(
        {
          id: newer.content_id,
          type: "series",
          name: "Newer",
          season: 1,
          episode: 1,
          positionMs: 900000,
          durationMs: 1200000,
          t: NOW,
        },
        "nuvio-1",
      );
      const result = await pullWatchProgressFromNuvio(1);
      assert.equal(result[0].progress_seconds, 900);
      assert.equal(localCwEntry("newer", false, "nuvio-1")?.positionMs, 900000);
    },
  );
});

test("an unknown empty fallback preserves history, while counted zero removes acknowledged history", async () => {
  await customSnapshot("empty-proof", async (accountId) => {
    const previous = progress("acknowledged", 1, NOW - 1000);
    writeCachedWatchProgress(1, [previous], accountId);
    saveLocalCw(
      {
        id: previous.content_id,
        type: "series",
        name: "Old",
        season: 1,
        episode: 1,
        positionMs: 120000,
        durationMs: 1200000,
        t: NOW - 1000,
      },
      "nuvio-1",
    );
    globalThis.fetch = async (url) => response([], String(url).includes("/rpc/") ? 503 : 200);
    assert.equal((await pullWatchProgressFromNuvio(1)).length, 1);
    assert.ok(localCwEntry(previous.content_id, false, "nuvio-1"));
    globalThis.fetch = async (url) =>
      response([], String(url).includes("/rpc/") ? 503 : 200, "*/0");
    assert.deepEqual(await pullWatchProgressFromNuvio(1), []);
    assert.equal(localCwEntry(previous.content_id, false, "nuvio-1"), null);
  });
});

test("watched snapshots collect capped pages and reject repeated or contradictory ranges", async () => {
  await customSnapshot("watched-cap", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      content_id: `cap-${i}`,
      content_type: "movie",
    }));
    storage.set("harbor.watchedFlag.nuvio.v1.1", JSON.stringify(rows.map((row) => row.content_id)));
    let pages = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/rpc/")) return response(rows.slice(0, 100));
      const offset = Number(/[?&]offset=(\d+)/.exec(String(url))?.[1] ?? 0);
      pages++;
      return response(rows.slice(offset, offset + 100), 200, `${offset}-${offset + 99}/500`);
    };
    await reconcileNuvioWatched(1);
    assert.equal(pages, 5);
    assert.equal(JSON.parse(storage.get("harbor.watchedFlag.nuvio.v1.1")!).length, 500);
    globalThis.fetch = async (url) =>
      String(url).includes("/rpc/")
        ? response([], 503)
        : response(rows.slice(0, 100), 200, "0-99/500");
    assert.equal(await pullWatchedItemsFromNuvio(1), null);
    assert.equal(JSON.parse(storage.get("harbor.watchedFlag.nuvio.v1.1")!).length, 500);
  });
});

test("failed local progress pushes remain protected across complete empty pulls", async () => {
  await customSnapshot("pending-progress", async () => {
    globalThis.fetch = async () => response([], 503);
    assert.equal(await pushWatchProgressToNuvio(1, "offline-progress", 600, 1200, 1, 3), false);
    const journal = [...storage.keys()].find((key) =>
      key.startsWith("harbor.nuvio.pending-sync.v1."),
    );
    assert.ok(journal && Object.keys(JSON.parse(storage.get(journal)!)).length > 0);
    globalThis.fetch = async () => response([], 200, "*/0");
    const result = await pullWatchProgressFromNuvio(1);
    assert.equal(
      result.find((row) => row.content_id === "offline-progress")?.progress_seconds,
      600,
    );
    assert.equal(localCwEntry("offline-progress", false, "nuvio-1")?.episode, 3);
  });
});

test("failed watched marks and unmarks survive pulls until cloud confirmation", async () => {
  await customSnapshot("pending-watched", async () => {
    globalThis.fetch = async () => response([], 503);
    assert.equal(
      await pushWatchedItemToNuvio(1, [{ contentId: "pending-mark", contentType: "movie" }]),
      false,
    );
    assert.equal(await deleteWatchedItemFromNuvio(1, [{ contentId: "pending-unmark" }]), false);
    globalThis.fetch = async () =>
      response([{ content_id: "pending-unmark", content_type: "movie" }], 200, "0-0/1");
    await reconcileNuvioWatched(1);
    assert.deepEqual(JSON.parse(storage.get("harbor.watchedFlag.nuvio.v1.1")!), ["pending-mark"]);
  });
});

test("uncounted capped pages advance by the actual rows and require an empty terminal page", async () => {
  await customSnapshot("uncounted-cap", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ content_id: `uncounted-${i}` }));
    const offsets: number[] = [];
    globalThis.fetch = async (url) => {
      if (String(url).includes("/rpc/")) return response(rows.slice(0, 10));
      const offset = Number(/[?&]offset=(\d+)/.exec(String(url))?.[1] ?? 0);
      offsets.push(offset);
      return response(rows.slice(offset, offset + 10));
    };
    assert.equal((await pullWatchedItemsFromNuvio(1))?.length, 25);
    assert.deepEqual(offsets, [0, 10, 20, 25]);
  });
});

test("a pull started before a successful push cannot acknowledge that newer mutation", async () => {
  await customSnapshot("late-confirmation", async (accountId) => {
    let finish!: (value: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    globalThis.fetch = async (url) =>
      String(url).includes("sync_pull_watch_progress") ? deferred : response([], 200, "*/0");
    const pulling = pullWatchProgressFromNuvio(1);
    await tick();
    assert.equal(await pushWatchProgressToNuvio(1, "during-pull", 600, 1200, 1, 4), true);
    finish(response([]));
    const result = await pulling;
    assert.equal(result.find((row) => row.content_id === "during-pull")?.progress_seconds, 600);
    const key = `harbor.nuvio.pending-sync.v1.${accountId}.slot.1`;
    assert.equal(Object.keys(JSON.parse(storage.get(key)!)).length, 1);
    const cloud = readCachedWatchProgress(1, accountId);
    globalThis.fetch = async () => response(cloud, 200, "0-0/1");
    await pullWatchProgressFromNuvio(1);
    assert.equal(Object.keys(JSON.parse(storage.get(key)!)).length, 0);
  });
});

test("watched storage changed during a pull is preserved before its push starts", async () => {
  await customSnapshot("local-watched-race", async () => {
    let finish!: (value: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    globalThis.fetch = async (url) =>
      String(url).includes("/rpc/") ? deferred : response([], 200, "*/0");
    const work = reconcileNuvioWatched(1);
    await tick();
    const key = "harbor.watchedFlag.nuvio.v1.1";
    storage.set(key, JSON.stringify(["new-local-mark"]));
    finish(response([]));
    await work;
    assert.deepEqual(JSON.parse(storage.get(key)!), ["new-local-mark"]);
  });
});

test("an old mark acknowledgement cannot erase a replacement unmark", async () => {
  await customSnapshot("replacement-unmark", async () => {
    let finish!: (value: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    globalThis.fetch = async (url) =>
      String(url).includes("sync_push_watched_items") ? deferred : response([], 503);
    const oldPush = pushWatchedItemToNuvio(1, [{ contentId: "replacement" }]);
    await tick();
    await deleteWatchedItemFromNuvio(1, [{ contentId: "replacement" }]);
    finish(response([]));
    await oldPush;
    globalThis.fetch = async () => response([{ content_id: "replacement" }], 200, "0-0/1");
    await reconcileNuvioWatched(1);
    assert.deepEqual(JSON.parse(storage.get("harbor.watchedFlag.nuvio.v1.1") ?? "[]"), []);
  });
});

test("background slot hydration never borrows another slot's resume", async () => {
  await withSnapshot(
    "rpc",
    "hydrate-owner",
    [],
    async () => {
      saveResumeMs("hydrate", 900000, 1, 1, undefined, undefined, undefined, "nuvio-2");
      const row = progress("hydrate", 1, Date.now() - 60000);
      const items = buildNuvioPlaybackItems([row], 1);
      assert.equal(items[0].state?.timeOffset, 120000);
      assert.equal(readResumeEntry("hydrate", 1, 1, "nuvio-1")?.ms, 120000);
      assert.equal(readResumeEntry("hydrate", 1, 1, "nuvio-2")?.ms, 900000);
    },
    2,
    false,
  );
});

test("resume and sync normalize invalid legacy slots consistently", async () => {
  await customSnapshot("normalized-slot", async () => {
    for (const invalid of [0, 7, -1, 1.5]) {
      saveNuvioState({ ...loadNuvioState(), activeProfileIndex: invalid });
      assert.equal(getNuvioActiveSlot(), 1);
      assert.equal(resolveNuvioProfileIndex(), 1);
      saveResumeMs("normalized", 123000, 1, 1);
      assert.equal(readResumeEntry("normalized", 1, 1, "nuvio-1")?.ms, 123000);
    }
  });
});

test("failed episode deletion cannot reappear through old history or local CW hydration", async () => {
  await customSnapshot("pending-episode-delete", async (accountId) => {
    const old = progress("deleted-episode", 4, NOW);
    writeCachedWatchProgress(1, [old], accountId);
    saveLocalCw(
      {
        id: old.content_id,
        type: "series",
        name: "Deleted",
        season: 1,
        episode: 4,
        positionMs: 120000,
        durationMs: 1200000,
        t: NOW,
      },
      "nuvio-1",
    );
    globalThis.fetch = async () => response([], 503);
    assert.equal(await deleteEpisodeWatchProgressFromNuvio(1, old.content_id, 1, 4), false);
    assert.equal(localCwEntry(old.content_id, false, "nuvio-1"), null);
    globalThis.fetch = async () => response([old], 200, "0-0/1");
    assert.deepEqual(await pullWatchProgressFromNuvio(1), []);
    assert.equal(localCwEntry(old.content_id, false, "nuvio-1"), null);
    assert.deepEqual(buildNuvioPlaybackItems(readCachedWatchProgress(1, accountId), 1), []);
  });
});

test("confirmed cloud resumes can still be removed by an authoritative empty snapshot", async () => {
  await customSnapshot("acknowledged-empty", async (accountId) => {
    const old = progress("cloud-ack", 2, Date.now() - 10000);
    writeCachedWatchProgress(1, [old], accountId);
    saveResumeMs(old.content_id, 120000, 1, 2, undefined, undefined, "nuvio", "nuvio-1");
    globalThis.fetch = async () => response([], 200, "*/0");
    assert.deepEqual(await pullWatchProgressFromNuvio(1), []);
    assert.equal(readResumeEntry(old.content_id, 1, 2, "nuvio-1"), null);
  });
});

test("a capped RPC batch cannot leave a successful deletion permanently unconfirmed", async () => {
  await customSnapshot("capped-delete-confirmation", async (accountId) => {
    globalThis.fetch = async () => response([]);
    assert.equal(await deleteEpisodeWatchProgressFromNuvio(1, "old-deleted", 1, 1), true);
    const rows = Array.from({ length: 50 }, (_, i) => progress(`kept-${i}`, 1, NOW));
    let tableCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/rpc/")) return response(rows);
      tableCalls++;
      return response(rows, 200, "0-49/50");
    };
    await pullWatchProgressFromNuvio(1);
    assert.equal(tableCalls, 1);
    const key = `harbor.nuvio.pending-sync.v1.${accountId}.slot.1`;
    assert.equal(Object.keys(JSON.parse(storage.get(key)!)).length, 0);
  });
});
