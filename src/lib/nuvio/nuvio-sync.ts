/**
 * Nuvio Cloud Synchronization Service
 * Handles strictly profile-isolated Watch Progress, Watched Items, and Addons sync.
 */

import {
  getNuvioProfileIndexForHarborProfile,
  getNuvioAccountId,
  getOrCreateSyncClientId,
  isNuvioSignedIn,
  loadNuvioState,
  nuvioFetch,
  saveNuvioState,
} from "./nuvio-client";
import type {
  NuvioAddonItem,
  NuvioWatchProgress,
  NuvioWatchedItem,
} from "./nuvio-types";
import { reconcileNuvioWatchedFlags } from "@/lib/watched-flag";
import { reconcileNuvioMovieWatched } from "@/lib/movie-watched";
import { reconcileNuvioWatchedEpisodes } from "@/lib/manual-watched";
import {
  clearLocalCw,
  clearLocalCwBatch,
  listLocalCw,
  localCwEntry,
  saveLocalCw,
  saveLocalCwBatch,
  type LocalCwEntry,
} from "@/lib/local-cw";
import { clearResume, clearResumeBatch, createResumeReader } from "@/lib/resume";
import { persistCritical } from "@/lib/storage-recovery";
import { isNuvioProviderActive, getNuvioActiveSlot } from "@/lib/active-profile-id";
import { readCachedNuvioPlaybackItems, writeCachedNuvioPlaybackItems } from "./nuvio-playback";

export { isNuvioProviderActive } from "@/lib/active-profile-id";

/**
 * Resolves the effective Nuvio profile index (1..6) considering active provider setting.
 */
export function resolveNuvioProfileIndex(harborProfileId?: string | number): number {
  if (typeof harborProfileId === "number") {
    if (Number.isInteger(harborProfileId) && harborProfileId >= 1 && harborProfileId <= 6)
      return harborProfileId;
    if (harborProfileId === 0) return 1;
  }
  if (typeof harborProfileId === "string") {
    const num = parseInt(harborProfileId, 10);
    if (!isNaN(num) && num >= 1 && num <= 6 && String(num) === harborProfileId) {
      return num;
    }
    if (harborProfileId === "0") {
      return 1;
    }
    if (harborProfileId.startsWith("nuvio-")) {
      const idx = parseInt(harborProfileId.replace("nuvio-", ""), 10);
      if (idx >= 1 && idx <= 6) return idx;
    }
  }
  if (isNuvioProviderActive()) {
    return getNuvioActiveSlot();
  }
  if (typeof harborProfileId === "string" && harborProfileId) {
    return getNuvioProfileIndexForHarborProfile(harborProfileId);
  }
  return getNuvioActiveSlot();
}

const WATCH_PROGRESS_CACHE_PREFIX = "harbor.nuvio.watch_progress.";
// Full-table snapshots are the only way to confirm remote deletions, but they
// are also the most expensive path. Routine pulls use the RPC batch; a full
// snapshot is forced by a pending mutation or by this interval.
const FULL_SYNC_INTERVAL_MS = 2 * 60_000;
const lastFullSyncAt = new Map<string, number>();

type NuvioCoordinate = { content_id: string; season?: number | null; episode?: number | null };
type PendingChange = {
  token: string;
  kind: "progress" | "watched";
  row: NuvioWatchProgress | NuvioWatchedItem;
  deleted: boolean;
  except?: string[];
};
type PendingChanges = Record<string, PendingChange>;

function coordinate(row: NuvioCoordinate): string {
  return JSON.stringify([row.content_id, row.season ?? null, row.episode ?? null]);
}

function pendingKey(slot: number, accountId: string): string {
  return `harbor.nuvio.pending-sync.v1.${accountId}.slot.${slot}`;
}

function readPending(slot: number, accountId: string): PendingChanges {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey(slot, accountId)) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function recordPending(
  slot: number,
  accountId: string,
  kind: PendingChange["kind"],
  rows: Array<NuvioWatchProgress | NuvioWatchedItem>,
  deleted = false,
): void {
  const changes = readPending(slot, accountId);
  const token = crypto.randomUUID();
  for (const row of rows) {
    // A title-wide deletion supersedes older per-episode actions for that title.
    if (deleted && row.season == null && row.episode == null) {
      for (const [key, held] of Object.entries(changes)) {
        if (held.kind === kind && held.row.content_id === row.content_id) delete changes[key];
      }
    }
    if (!deleted && row.season != null && row.episode != null) {
      for (const held of Object.values(changes)) {
        if (
          held.kind === kind &&
          held.deleted &&
          held.row.content_id === row.content_id &&
          held.row.season == null &&
          held.row.episode == null
        ) {
          held.except = [...new Set([...(held.except ?? []), coordinate(row)])];
        }
      }
    }
    changes[`${kind}:${coordinate(row)}`] = { token, kind, row, deleted };
  }
  persistCritical(pendingKey(slot, accountId), JSON.stringify(changes));
}

function matchesChange(row: NuvioCoordinate, change: PendingChange): boolean {
  return (
    row.content_id === change.row.content_id &&
    !change.except?.includes(coordinate(row)) &&
    ((change.deleted && change.row.season == null && change.row.episode == null) ||
      coordinate(row) === coordinate(change.row))
  );
}

function applyPending<T extends NuvioCoordinate>(
  rows: T[],
  slot: number,
  accountId: string,
  kind: PendingChange["kind"],
  complete: boolean,
  atStart: PendingChanges,
): { items: T[]; deleted: PendingChange[] } {
  const current = readPending(slot, accountId);
  const deleted: PendingChange[] = [];
  const exact = new Map(rows.map((row) => [coordinate(row), row]));
  const byContent = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = byContent.get(row.content_id) ?? [];
    bucket.push(row);
    byContent.set(row.content_id, bucket);
  }
  const removed = new Set<string>();
  const added = new Map<string, T>();
  let changed = false;
  for (const [key, change] of Object.entries(current)) {
    if (!change?.row?.content_id || change.kind !== kind) continue;
    const exactHit = exact.get(coordinate(change.row));
    const candidates =
      change.deleted && change.row.season == null && change.row.episode == null
        ? (byContent.get(change.row.content_id) ?? [])
        : exactHit
          ? [exactHit]
          : [];
    const blocked = candidates.filter((row) => matchesChange(row, change));
    const hit = blocked[0];
    const confirmed = change.deleted
      ? complete && !hit
      : hit &&
        (kind !== "progress" ||
          progressTime(hit as unknown as NuvioWatchProgress) >=
            progressTime(change.row as NuvioWatchProgress));
    // Only a later read may acknowledge this exact mutation. An older request
    // cannot erase a replacement recorded while awaiting its response.
    if (atStart[key]?.token === change.token && confirmed) {
      delete current[key];
      changed = true;
      continue;
    }
    for (const row of blocked) removed.add(coordinate(row));
    if (change.deleted) deleted.push(change);
    else added.set(coordinate(change.row), change.row as T);
  }
  if (changed) persistCritical(pendingKey(slot, accountId), JSON.stringify(current));
  const items =
    removed.size || added.size
      ? [
          ...rows.filter((row) => !removed.has(coordinate(row)) && !added.has(coordinate(row))),
          ...added.values(),
        ]
      : rows;
  return { items, deleted };
}

function progressTime(row: NuvioWatchProgress): number {
  const raw = row.last_watched;
  const value = typeof raw === "number" ? raw : raw ? Date.parse(String(raw)) : 0;
  if (Number.isFinite(value) && value > 0 && value <= 8.64e15) return value;
  const updated = Date.parse(row.updated_at ?? "");
  return Number.isFinite(updated) && updated > 0 ? updated : 0;
}

function validRow(value: unknown, slot: number, accountId: string): value is NuvioCoordinate {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.content_id === "string" &&
    row.content_id.trim().length > 0 &&
    (row.profile_id == null || row.profile_id === slot) &&
    (row.user_id == null || row.user_id === accountId) &&
    ((row.season == null && row.episode == null) ||
      (Number.isInteger(row.season) &&
        Number(row.season) >= 0 &&
        Number.isInteger(row.episode) &&
        Number(row.episode) > 0))
  );
}

// Offsets advance by the actual response size, so a server-side max-rows cap
// cannot skip records. Unknown totals require an empty terminal page.
async function readTableSnapshot<T extends NuvioCoordinate>(
  table: "watched_items" | "watch_progress",
  slot: number,
  accountId: string,
  stillCurrent: () => boolean,
  allowUncountedEmpty: boolean,
): Promise<T[] | null> {
  const items: T[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 0; page < 100; page++) {
    if (!stillCurrent()) return null;
    const offset = items.length;
    const res = await nuvioFetch(
      `/rest/v1/${table}?profile_id=eq.${slot}&select=*&order=content_id.asc,season.asc.nullsfirst,episode.asc.nullsfirst&limit=1000&offset=${offset}`,
      { headers: { Prefer: "count=exact" } },
    );
    if (!res.ok || !stillCurrent()) return null;
    const rows: unknown = await res.json();
    if (!stillCurrent() || !Array.isArray(rows) || rows.length > 1000) return null;
    const range = res.headers?.get("content-range");
    if (range) {
      const match = /^(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(range);
      if (!match) return null;
      if (
        rows.length > 0 &&
        (Number(match[1]) !== offset || Number(match[2]) + 1 !== offset + rows.length)
      )
        return null;
      if (match[3] !== "*") {
        const count = Number(match[3]);
        if ((total != null && count !== total) || count < offset + rows.length) return null;
        total = count;
      }
    }
    for (const row of rows) {
      if (!validRow(row, slot, accountId)) return null;
      const key = coordinate(row);
      if (seen.has(key)) return null;
      seen.add(key);
      items.push(row as T);
    }
    if (total != null && items.length === total) return items;
    if (rows.length === 0) {
      if (total != null || (offset === 0 && !allowUncountedEmpty)) return null;
      return items;
    }
  }
  return null;
}


function getWatchProgressKey(slot: number, accountId?: string): string {
  const acc = accountId || getNuvioAccountId() || "anon";
  return `${WATCH_PROGRESS_CACHE_PREFIX}${acc}.slot.${slot}`;
}

/**
 * Loads cached watch progress records for a specific profile slot from localStorage.
 */
export function readCachedWatchProgress(slot: number, accountId?: string): NuvioWatchProgress[] {
  try {
    const raw = localStorage.getItem(getWatchProgressKey(slot, accountId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NuvioWatchProgress[]) : [];
  } catch {
    return [];
  }
}

/**
 * Saves watch progress records for a specific profile slot into localStorage.
 */
export function writeCachedWatchProgress(
  slot: number,
  items: NuvioWatchProgress[],
  accountId?: string,
): void {
  try {
    localStorage.setItem(
      getWatchProgressKey(slot, accountId),
      JSON.stringify(items),
    );
  } catch {}
}

export function clearCachedWatchProgress(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith("harbor.nuvio.watch_progress.") ||
          key.startsWith("harbor.nuvio.watch_progress.slot."))
      ) {
        toRemove.push(key);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {}
}

/**
 * Pushes watch progress to Nuvio for the active Harbor profile.
 * Progress is saved in integer seconds.
 */
export async function pushWatchProgressToNuvio(
  harborProfileId: string | number | undefined,
  contentId: string,
  progressSeconds: number,
  durationSeconds: number,
  season?: number | null,
  episode?: number | null,
  meta?: { title?: string; name?: string; poster?: string; background?: string },
): Promise<boolean> {
  if (!isNuvioSignedIn()) return false;

  const accountId = getNuvioAccountId();
  if (!accountId) return false;
  const sameAccount = () => isNuvioSignedIn() && getNuvioAccountId() === accountId;
  const profileIndex = resolveNuvioProfileIndex(harborProfileId);
  const progSec = Math.max(0, Math.round(progressSeconds));
  const durSec = Math.max(0, Math.round(durationSeconds));

  const progressKey =
    season != null && episode != null
      ? `${contentId}_s${season}e${episode}`
      : contentId;

  const nowEpoch = Date.now();
  const title = meta?.name || meta?.title || undefined;
  const poster = meta?.poster || undefined;
  const background = meta?.background || undefined;

  const payload: NuvioWatchProgress = {
    profile_id: profileIndex,
    content_id: contentId,
    progress_key: progressKey,
    progress_seconds: progSec,
    duration_seconds: durSec,
    season: season ?? null,
    episode: episode ?? null,
    updated_at: new Date(nowEpoch).toISOString(),
    last_watched: nowEpoch,
    title,
    name: title,
    poster,
    background,
  };

  recordPending(profileIndex, accountId, "progress", [payload]);

  // Update local slot cache immediately for instant snappy responsiveness
  try {
    const cached = readCachedWatchProgress(profileIndex);
    const existingIndex = cached.findIndex((p) => p.progress_key === progressKey);
    const existing = existingIndex >= 0 ? cached[existingIndex] : null;
    const mergedPayload: NuvioWatchProgress = {
      ...payload,
      title: title || existing?.title || existing?.name,
      name: title || existing?.name || existing?.title,
      poster: poster || existing?.poster,
      background: background || existing?.background,
    };
    const filtered = cached.filter((p) => p.progress_key !== progressKey);
    filtered.unshift(mergedPayload);
    writeCachedWatchProgress(profileIndex, filtered);

    // Save to local continue watching immediately
    saveLocalCw(
      {
        id: contentId,
        type: season != null && episode != null ? "series" : "movie",
        name: title || existing?.name || existing?.title || contentId,
        poster: (poster || existing?.poster) || undefined,
        background: (background || existing?.background) || undefined,
        season: season ?? undefined,
        episode: episode ?? undefined,
        positionMs: progSec * 1000,
        durationMs: durSec * 1000,
        t: nowEpoch,
      },
      `nuvio-${profileIndex}`,
    );

    window.dispatchEvent(
      new CustomEvent("harbor:nuvio-progress-pushed", { detail: { profileIndex, progressKey } }),
    );
  } catch {}

  // Try official sync_push_watch_progress RPC first (matches NuvioMobile)
  try {
    const clientId = getOrCreateSyncClientId();
    const rpcRes = await nuvioFetch("/rest/v1/rpc/sync_push_watch_progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_profile_id: profileIndex,
        p_entries: [
          {
            content_id: contentId,
            content_type: season != null && episode != null ? "series" : "movie",
            video_id:
              season != null && episode != null
                ? `${contentId}:${season}:${episode}`
                : contentId,
            season: season ?? null,
            episode: episode ?? null,
            position: progSec * 1000,
            duration: durSec * 1000,
            last_watched: nowEpoch,
            progress_key: progressKey,
          },
        ],
        p_origin_client_id: clientId,
      }),
    });
    if (rpcRes.ok) {
      console.info(`[nuvio-sync] watch progress pushed via RPC for profile ${profileIndex}: ${progressKey} (${progSec}s / ${durSec}s)`);
      return true;
    }
  } catch {
    // Fall back to table upsert
  }

  if (!sameAccount()) return false;
  try {
    const res = await nuvioFetch("/rest/v1/watch_progress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        profile_id: profileIndex,
        content_id: contentId,
        content_type: season != null && episode != null ? "series" : "movie",
        video_id:
          season != null && episode != null
            ? `${contentId}:${season}:${episode}`
            : contentId,
        progress_key: progressKey,
        position: progSec * 1000,
        duration: durSec * 1000,
        season: season ?? null,
        episode: episode ?? null,
        last_watched: nowEpoch,
      }),
    });

    if (res.ok) {
      console.info(`[nuvio-sync] watch progress pushed via table upsert for profile ${profileIndex}: ${progressKey}`);
      return true;
    }
    return res.ok;
  } catch (err) {
    console.warn("[nuvio] failed to push watch progress", err);
    return false;
  }
}

/**
 * Pushes watched items to Nuvio cloud via RPC or table fallback
 */
export async function pushWatchedItemToNuvio(
  harborProfileId: string | number | undefined,
  items: Array<{
    contentId: string;
    contentType?: string;
    title?: string;
    season?: number | null;
    episode?: number | null;
    watchedAt?: number;
  }>,
): Promise<boolean> {
  if (!isNuvioSignedIn() || items.length === 0) return false;
  const accountId = getNuvioAccountId();
  if (!accountId) return false;
  const sameAccount = () => isNuvioSignedIn() && getNuvioAccountId() === accountId;
  const profileIndex = resolveNuvioProfileIndex(harborProfileId);

  recordPending(
    profileIndex,
    accountId,
    "watched",
    items.map((item) => ({
      content_id: item.contentId,
      content_type: item.contentType,
      title: item.title,
      profile_id: profileIndex,
      season: item.season ?? null,
      episode: item.episode ?? null,
      watched_at: item.watchedAt || Date.now(),
    })),
  );

  let rpcSuccess = false;
  // 1. Try official sync_push_watched_items RPC (matching Nuvio Mobile)
  try {
    const clientId = getOrCreateSyncClientId();
    const syncItems = items.map((item) => ({
      content_id: item.contentId,
      content_type: item.contentType || (item.season != null && item.episode != null ? "series" : "movie"),
      title: item.title || "",
      season: item.season ?? null,
      episode: item.episode ?? null,
      watched_at: item.watchedAt || Date.now(),
    }));
    const rpcRes = await nuvioFetch("/rest/v1/rpc/sync_push_watched_items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_profile_id: profileIndex,
        p_items: syncItems,
        p_origin_client_id: clientId,
      }),
    });
    if (rpcRes.ok) {
      rpcSuccess = true;
      console.info(`[nuvio-sync] watched items pushed via RPC for profile ${profileIndex} (${syncItems.length} items)`);
    } else {
      console.warn(`[nuvio-sync] RPC push watched items response not ok: ${rpcRes.status}`);
    }
  } catch (err) {
    console.warn("[nuvio-sync] RPC push watched items error:", err);
  }

  if (!sameAccount()) return false;
  // 2. ALSO execute direct table upsert to guarantee clean state and persistence
  try {
    const payloads = items.map((item) => ({
      profile_id: profileIndex,
      content_id: item.contentId,
      content_type: item.contentType || (item.season != null && item.episode != null ? "series" : "movie"),
      title: item.title || "",
      season: item.season ?? null,
      episode: item.episode ?? null,
      watched_at: item.watchedAt || Date.now(),
    }));
    const res = await nuvioFetch("/rest/v1/watched_items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(payloads.length === 1 ? payloads[0] : payloads),
    });
    if (res.ok) return true;
  } catch (err) {
    console.warn("[nuvio] failed to mark watched item via table upsert", err);
  }

  return rpcSuccess;
}

/**
 * Deletes watched items from Nuvio cloud via RPC or table fallback
 */
export async function deleteWatchedItemFromNuvio(
  harborProfileId: string | number | undefined,
  keys: Array<{
    contentId: string;
    season?: number | null;
    episode?: number | null;
  }>,
): Promise<boolean> {
  if (!isNuvioSignedIn() || keys.length === 0) return false;
  const accountId = getNuvioAccountId();
  if (!accountId) return false;
  const sameAccount = () => isNuvioSignedIn() && getNuvioAccountId() === accountId;
  const profileIndex = resolveNuvioProfileIndex(harborProfileId);

  recordPending(
    profileIndex,
    accountId,
    "watched",
    keys.map((key) => ({
      content_id: key.contentId,
      profile_id: profileIndex,
      season: key.season ?? null,
      episode: key.episode ?? null,
    })),
    true,
  );

  // 1. Try official sync_delete_watched_items RPC (matching Nuvio Mobile)
  let rpcSuccess = false;
  try {
    const clientId = getOrCreateSyncClientId();
    const rpcRes = await nuvioFetch("/rest/v1/rpc/sync_delete_watched_items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_profile_id: profileIndex,
        p_keys: keys.map((k) => ({
          content_id: k.contentId,
          season: k.season ?? null,
          episode: k.episode ?? null,
        })),
        p_origin_client_id: clientId,
      }),
    });
    if (rpcRes.ok) {
      rpcSuccess = true;
      console.info(`[nuvio-sync] watched items deleted via RPC for profile ${profileIndex} (${keys.length} keys)`);
    }
  } catch {}

  // 2. ALSO execute direct table delete to guarantee clean state
  try {
    let tableSuccess = true;
    for (const k of keys) {
      if (!sameAccount()) return false;
      let url = `/rest/v1/watched_items?profile_id=eq.${profileIndex}&content_id=eq.${encodeURIComponent(k.contentId)}`;
      if (k.season != null) url += `&season=eq.${k.season}`;
      if (k.episode != null) url += `&episode=eq.${k.episode}`;
      const res = await nuvioFetch(url, { method: "DELETE" });
      tableSuccess = tableSuccess && res.ok;
    }
    return tableSuccess || rpcSuccess;
  } catch (err) {
    console.warn("[nuvio] failed to delete watched item", err);
    return rpcSuccess;
  }
}

/**
 * Dismisses an Up-Next series in Nuvio Cloud's mobile profile settings blob
 * so that Nuvio Mobile's Next-Up engine never resurrects the card.
 */
export async function dismissNextUpInNuvioCloud(
  harborProfileId: string | number | undefined,
  contentId: string,
  season?: number | null,
  episode?: number | null,
): Promise<boolean> {
  if (!isNuvioSignedIn()) return false;
  const accountId = getNuvioAccountId();
  if (!accountId) return false;
  const sameAccount = () => isNuvioSignedIn() && getNuvioAccountId() === accountId;
  const profileIndex = resolveNuvioProfileIndex(harborProfileId);
  const normalizedContentId = contentId.trim();
  if (!normalizedContentId) return false;

  try {
    const pullRes = await nuvioFetch("/rest/v1/rpc/sync_pull_profile_settings_blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_profile_id: profileIndex,
        p_platform: "mobile",
      }),
    });
    if (!pullRes.ok || !sameAccount()) return false;
    const blobList = await pullRes.json();
    if (!sameAccount()) return false;
    const first = Array.isArray(blobList) ? blobList[0] : null;
    const settingsJson = first?.settings_json ?? { version: 4, features: {} };
    if (!settingsJson.features) settingsJson.features = {};
    const features = settingsJson.features;
    let cwPayload: any = {};
    if (
      typeof features.continue_watching_settings_payload === "string" &&
      features.continue_watching_settings_payload.trim()
    ) {
      try {
        cwPayload = JSON.parse(features.continue_watching_settings_payload);
      } catch {}
    }
    const dismissed: string[] = Array.isArray(cwPayload.dismissedNextUpKeys)
      ? [...cwPayload.dismissedNextUpKeys]
      : [];

    const key1 = `${normalizedContentId}|${season ?? -1}|${episode ?? -1}`;
    const key2 = `${normalizedContentId}|-1|-1`;
    let changed = false;
    if (!dismissed.includes(key1)) {
      dismissed.push(key1);
      changed = true;
    }
    if (!dismissed.includes(key2)) {
      dismissed.push(key2);
      changed = true;
    }

    if (changed) {
      cwPayload.dismissedNextUpKeys = dismissed;
      features.continue_watching_settings_payload = JSON.stringify(cwPayload);
      settingsJson.features = features;

      const clientId = getOrCreateSyncClientId();
      if (!sameAccount()) return false;
      const pushRes = await nuvioFetch("/rest/v1/rpc/sync_push_profile_settings_blob", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          p_profile_id: profileIndex,
          p_platform: "mobile",
          p_settings_json: settingsJson,
          p_origin_client_id: clientId,
        }),
      });
      return pushRes.ok;
    }
    return true;
  } catch (err) {
    console.warn("[nuvio-sync] failed to dismiss next up in cloud:", err);
    return false;
  }
}

/**
 * Marks an episode or movie as fully watched in Nuvio
 */
export async function markWatchedInNuvio(
  harborProfileId: string | number | undefined,
  contentId: string,
  season?: number | null,
  episode?: number | null,
  title?: string,
): Promise<boolean> {
  return pushWatchedItemToNuvio(harborProfileId, [
    {
      contentId,
      contentType: season != null && episode != null ? "series" : "movie",
      title,
      season,
      episode,
      watchedAt: Date.now(),
    },
  ]);
}

/**
 * Pulls watched items for a specific profile slot from Nuvio
 */
export async function pullWatchedItemsFromNuvio(
  harborProfileId?: string | number,
  options?: { force?: boolean },
): Promise<NuvioWatchedItem[] | null> {
  if (!isNuvioSignedIn() || !isNuvioProviderActive()) return null;
  const accountId = getNuvioAccountId();
  if (!accountId) return null;
  const slot = resolveNuvioProfileIndex(harborProfileId);
  const stillCurrent = () =>
    isNuvioSignedIn() &&
    isNuvioProviderActive() &&
    getNuvioAccountId() === accountId &&
    resolveNuvioProfileIndex() === slot;
  const fullSyncKey = `watched:${accountId}:${slot}`;
  const lastFullSync = lastFullSyncAt.get(fullSyncKey) ?? 0;
  if (!options?.force && lastFullSync && Date.now() - lastFullSync < FULL_SYNC_INTERVAL_MS)
    return null;
  let rpcRows: NuvioWatchedItem[] | null = null;
  let confirmedEmpty = false;
  try {
    const res = await nuvioFetch("/rest/v1/rpc/sync_pull_watched_items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_profile_id: slot, p_page: 1, p_page_size: 1000 }),
    });
    if (!stillCurrent()) return null;
    if (res.ok) {
      const rows: unknown = await res.json();
      if (Array.isArray(rows) && rows.every((row) => validRow(row, slot, accountId))) {
        rpcRows = rows as NuvioWatchedItem[];
        confirmedEmpty = rows.length === 0;
      }
    }
  } catch {
    // A fallback may prove completeness through its count or terminal page.
  }
  try {
    const table = await readTableSnapshot<NuvioWatchedItem>(
      "watched_items",
      slot,
      accountId,
      stillCurrent,
      confirmedEmpty,
    );
    if (!table) return null;
    if (table.length === 0 && !confirmedEmpty && !rpcRows) return null;
    if (rpcRows && rpcRows.length > 0) {
      // The table and the official RPC must agree on the latest rows before a
      // snapshot is allowed to remove local watched state.
      const tableCoordinates = new Set(table.map((row) => coordinate(row)));
      if (!rpcRows.every((row) => tableCoordinates.has(coordinate(row)))) {
        console.warn(
          "[nuvio-sync] watched table does not match the RPC batch; keeping local state",
        );
        return null;
      }
    }
    lastFullSyncAt.set(fullSyncKey, Date.now());
    return table;
  } catch {
    return null;
  }
}

/**
 * Reconciles remote watched items into local watched-flag, movie-watched, and manual-watched storage
 * for the active Nuvio profile slot.
 */
const watchedReconcileInflight = new Map<string, Promise<void>>();

export function reconcileNuvioWatched(harborProfileId?: string | number): Promise<void> {
  if (!isNuvioSignedIn() || !isNuvioProviderActive()) return Promise.resolve();
  const accountId = getNuvioAccountId();
  if (!accountId) return Promise.resolve();
  const slot = resolveNuvioProfileIndex(harborProfileId);
  const key = `${accountId}:${slot}`;
  const existing = watchedReconcileInflight.get(key);
  if (existing) return existing;
  const work = reconcileNuvioWatchedOnce(slot);
  watchedReconcileInflight.set(key, work);
  void work.finally(() => {
    if (watchedReconcileInflight.get(key) === work) watchedReconcileInflight.delete(key);
  }).catch(() => {});
  return work;
}

async function reconcileNuvioWatchedOnce(harborProfileId?: string | number): Promise<void> {
  if (!isNuvioSignedIn() || !isNuvioProviderActive()) return;
  const profileIndex = resolveNuvioProfileIndex(harborProfileId);
  const accountId = getNuvioAccountId();
  if (!accountId) return;
  const pending = readPending(profileIndex, accountId);
  const keys = [
    `harbor.watchedFlag.nuvio.v1.${profileIndex}`,
    `harbor.moviewatched.nuvio.v1.${profileIndex}`,
    `harbor.manualwatched.v1.nuvio.${profileIndex}`,
    `harbor.manualunwatched.v1.nuvio.${profileIndex}`,
  ];
  const before = keys.map((key) => localStorage.getItem(key));
  const pulled = await pullWatchedItemsFromNuvio(profileIndex, {
    force: Object.values(pending).some((change) => change.kind === "watched"),
  });
  const items =
    pulled &&
    isNuvioProviderActive() &&
    getNuvioAccountId() === accountId &&
    resolveNuvioProfileIndex() === profileIndex &&
    keys.every((key, i) => localStorage.getItem(key) === before[i])
      ? applyPending(pulled, profileIndex, accountId, "watched", true, pending).items
      : null;
  if (
    !items ||
    !accountId ||
    getNuvioAccountId() !== accountId ||
    !isNuvioProviderActive() ||
    resolveNuvioProfileIndex() !== profileIndex
  )
    return;

  const serverWatchedIds = new Set<string>();
  const serverMovieIds = new Set<string>();
  const serverEpisodeKeys = new Set<string>();

  for (const it of items) {
    if (!it.content_id) continue;
    if (it.season == null && it.episode == null) {
      serverWatchedIds.add(it.content_id);
      if (it.content_type === "movie" || !it.content_type) {
        serverMovieIds.add(it.content_id);
      }
    } else if (typeof it.season === "number" && typeof it.episode === "number") {
      serverEpisodeKeys.add(`${it.content_id}|${it.season}|${it.episode}`);
    }
  }

  // 1. Reconcile episodes with local storage: adds server episodes and removes
  // unflagged episodes (handling single unmarks, up-to unmarks, and whole-season unmarks from Nuvio mobile)
  reconcileNuvioWatchedEpisodes(profileIndex, serverEpisodeKeys);

  // A complete snapshot is authoritative. Commit once, not once per item:
  // repeated writes were O(n^2) on shows with thousands of watched episodes.
  reconcileNuvioWatchedFlags(profileIndex, serverWatchedIds);
  reconcileNuvioMovieWatched(profileIndex, serverMovieIds);

  window.dispatchEvent(
    new CustomEvent("harbor:nuvio-watched-reconciled", { detail: { profileIndex } }),
  );
}

/**
 * Deletes watch progress for a single specific episode from Nuvio Cloud and local cache.
 * Does NOT touch other episodes or dismiss the series from Up Next.
 */
export async function deleteEpisodeWatchProgressFromNuvio(
  harborProfileId: string | number | undefined,
  contentId: string,
  season: number,
  episode: number,
): Promise<boolean> {
  if (!isNuvioSignedIn()) return false;
  const accountId = getNuvioAccountId();
  if (!accountId) return false;
  const sameAccount = () => isNuvioSignedIn() && getNuvioAccountId() === accountId;
  const profileIndex = resolveNuvioProfileIndex(harborProfileId);
  const normalizedContentId = contentId.trim();
  if (!normalizedContentId) return false;
  recordPending(
    profileIndex,
    accountId,
    "progress",
    [
      {
        content_id: normalizedContentId,
        profile_id: profileIndex,
        season: season,
        episode: episode,
      },
    ],
    true,
  );

  const episodeKey1 = `${normalizedContentId}_s${season}e${episode}`;
  const episodeKey2 = `${normalizedContentId}:${season}:${episode}`;
  const keysToDelete = [episodeKey1, episodeKey2];

  // 1. Prune from local cached watch progress
  try {
    const cached = readCachedWatchProgress(profileIndex);
    const filtered = cached.filter(
      (p) =>
        !(
          p.content_id === normalizedContentId &&
          ((p.season === season && p.episode === episode) ||
            p.progress_key === episodeKey1 ||
            p.progress_key === episodeKey2)
        ),
    );
    writeCachedWatchProgress(profileIndex, filtered);
  } catch {}

  // 2. Clear local resume for this specific episode
  clearResume(normalizedContentId, season, episode, `nuvio-${profileIndex}`);
  const local = localCwEntry(normalizedContentId, false, `nuvio-${profileIndex}`);
  if (local?.season === season && local.episode === episode) {
    clearLocalCw(normalizedContentId, `nuvio-${profileIndex}`);
  }

  // 3. Dispatch local event
  window.dispatchEvent(
    new CustomEvent("harbor:nuvio-progress-deleted", {
      detail: { profileIndex, contentId: normalizedContentId, keys: keysToDelete },
    }),
  );

  // 4. Call sync_delete_watch_progress RPC
  if (!sameAccount()) return false;
  let rpcSuccess = false;
  try {
    const clientId = getOrCreateSyncClientId();
    const rpcRes = await nuvioFetch("/rest/v1/rpc/sync_delete_watch_progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_profile_id: profileIndex,
        p_keys: keysToDelete,
        p_origin_client_id: clientId,
      }),
    });
    if (rpcRes.ok) rpcSuccess = true;
  } catch {}

  if (!sameAccount()) return false;
  // 5. Also execute table delete for this specific episode
  try {
    const res = await nuvioFetch(
      `/rest/v1/watch_progress?profile_id=eq.${profileIndex}&content_id=eq.${encodeURIComponent(normalizedContentId)}&season=eq.${season}&episode=eq.${episode}`,
      { method: "DELETE" },
    );
    if (res.ok) return true;
  } catch {}

  return rpcSuccess;
}

/**
 * Deletes watch progress for a title or specific episode in Nuvio
 */
export async function deleteWatchProgressFromNuvio(
  harborProfileId: string | number | undefined,
  contentId: string,
  progressKey?: string,
  season?: number | null,
  episode?: number | null,
): Promise<boolean> {
  if (!isNuvioSignedIn()) return false;

  const accountId = getNuvioAccountId();
  if (!accountId) return false;
  const sameAccount = () => isNuvioSignedIn() && getNuvioAccountId() === accountId;
  const profileIndex = resolveNuvioProfileIndex(harborProfileId);
  const normalizedContentId = contentId.trim();
  if (!normalizedContentId) return false;
  recordPending(
    profileIndex,
    accountId,
    "progress",
    [
      {
        content_id: normalizedContentId,
        profile_id: profileIndex,
        season: null,
        episode: null,
      },
    ],
    true,
  );

  // 1. Immediately harvest known keys and prune local caches for 0ms snappy UI
  const keysToDelete = new Set<string>();
  if (progressKey) keysToDelete.add(progressKey);
  keysToDelete.add(normalizedContentId);
  if (season != null && episode != null) {
    keysToDelete.add(`${normalizedContentId}_s${season}e${episode}`);
    keysToDelete.add(`${normalizedContentId}:${season}:${episode}`);
  }

  // Also harvest all other episode keys for this content from local cache
  try {
    const cached = readCachedWatchProgress(profileIndex);
    for (const entry of cached) {
      if (entry.content_id === normalizedContentId && entry.progress_key) {
        keysToDelete.add(entry.progress_key);
      }
    }
    const filtered = cached.filter(
      (p) => !keysToDelete.has(p.progress_key) && p.content_id !== normalizedContentId,
    );
    writeCachedWatchProgress(profileIndex, filtered);
  } catch {}

  // Prune local CW, resume states, and playback items for this content across all scopes
  clearLocalCw(normalizedContentId, `nuvio-${profileIndex}`);
  clearResume(normalizedContentId, undefined, undefined, `nuvio-${profileIndex}`);

  try {
    const existing = readCachedNuvioPlaybackItems(profileIndex);
    if (existing.length > 0) {
      const filteredItems = existing.filter((i: any) => i._id !== normalizedContentId);
      writeCachedNuvioPlaybackItems(profileIndex, filteredItems);
    }
    localStorage.removeItem(`harbor.nuvio.playback_items.slot.${profileIndex}`);
  } catch {}

  // Dispatch events to notify all UI stores immediately
  window.dispatchEvent(
    new CustomEvent("harbor:nuvio-progress-deleted", {
      detail: { profileIndex, contentId: normalizedContentId, keys: Array.from(keysToDelete) },
    }),
  );

  // 2. Query Supabase for ALL progress keys currently on the server for this content
  try {
    const serverKeysRes = await nuvioFetch(
      `/rest/v1/watch_progress?profile_id=eq.${profileIndex}&content_id=eq.${encodeURIComponent(normalizedContentId)}&select=progress_key,season,episode`,
    );
    if (serverKeysRes.ok) {
      const serverRows = (await serverKeysRes.json()) as any[];
      if (Array.isArray(serverRows)) {
        for (const row of serverRows) {
          if (row.progress_key) keysToDelete.add(row.progress_key);
          if (row.season != null && row.episode != null) {
            keysToDelete.add(`${normalizedContentId}_s${row.season}e${row.episode}`);
            keysToDelete.add(`${normalizedContentId}:${row.season}:${row.episode}`);
          }
        }
      }
    }
  } catch (err) {
    console.warn("[nuvio-sync] failed to query server keys before delete", err);
  }

  if (!sameAccount()) return false;
  const keysArray = Array.from(keysToDelete);
  const clientId = getOrCreateSyncClientId();

  // 3. Call official sync_delete_watch_progress RPC (emits delta delete events for Nuvio Mobile)
  if (!sameAccount()) return false;
  let rpcSuccess = false;
  try {
    const rpcRes = await nuvioFetch("/rest/v1/rpc/sync_delete_watch_progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_profile_id: profileIndex,
        p_keys: keysArray,
        p_origin_client_id: clientId,
      }),
    });
    if (rpcRes.ok) {
      rpcSuccess = true;
      console.info(`[nuvio-sync] watch progress deleted via RPC for profile ${profileIndex}:`, keysArray);
    }
  } catch (rpcErr) {
    console.warn("[nuvio-sync] RPC delete error:", rpcErr);
  }

  if (!sameAccount()) return false;
  // 4. ALWAYS ALSO execute direct table delete to guarantee ZERO lingering zombie rows
  try {
    const res = await nuvioFetch(
      `/rest/v1/watch_progress?profile_id=eq.${profileIndex}&content_id=eq.${encodeURIComponent(normalizedContentId)}`,
      { method: "DELETE" },
    );
    rpcSuccess = rpcSuccess || res.ok;
  } catch (err) {
    console.warn("[nuvio-sync] table delete error:", err);
  }

  if (!sameAccount()) return false;
  // 5. Dismiss Next-Up in mobile profile settings blob so mobile Up-Next engine never resurrects it
  void dismissNextUpInNuvioCloud(profileIndex, normalizedContentId, season, episode);

  return rpcSuccess;
}

function reconcileNuvioProgressHistory(
  previous: NuvioWatchProgress[],
  items: NuvioWatchProgress[],
  profileIndex: number,
  completeSnapshot: boolean,
): Set<string> {
  const byCoordinate = new Map(items.map((item, i) => [coordinate(item), i]));
  const ownerId = `nuvio-${profileIndex}`;
  const resume = createResumeReader(ownerId);
  const staleResume: Array<{ id: string; season?: number | null; episode?: number | null }> = [];
  for (const prev of previous) {
    const index = byCoordinate.get(coordinate(prev));
    const local = resume(prev.content_id, prev.season ?? undefined, prev.episode ?? undefined);
    const newerResume =
      local &&
      local.source !== "nuvio" &&
      local.t > Math.max(progressTime(prev), index != null ? progressTime(items[index]) : 0);
    if (newerResume) {
      const row = {
        ...prev,
        progress_seconds: local.ms / 1000,
        last_watched: local.t,
        updated_at: new Date(local.t).toISOString(),
      };
      if (index != null) items[index] = row;
      else items.push(row);
    } else if (index != null) {
      if (progressTime(prev) > progressTime(items[index])) items[index] = prev;
    } else if (!completeSnapshot) {
      items.push(prev);
    } else {
      staleResume.push({
        id: prev.content_id,
        season: prev.season ?? null,
        episode: prev.episode ?? null,
      });
    }
  }
  // One map rewrite per storage key instead of one per removed episode/content.
  clearResumeBatch(staleResume, ownerId);
  const contentIds = new Set(items.map((item) => item.content_id));
  const removedIds = new Set(previous.map((row) => row.content_id));
  const staleContent: string[] = [];
  for (const id of removedIds) {
    if (!contentIds.has(id)) staleContent.push(id);
  }
  clearLocalCwBatch(staleContent, ownerId);
  return contentIds;
}

function saveLatestNuvioLocalProgress(items: NuvioWatchProgress[], profileIndex: number): void {
  // Callers sort newest first. Local CW stores one checkpoint per content ID.
  const ownerId = `nuvio-${profileIndex}`;
  const current = new Map(listLocalCw(false, ownerId).map((entry) => [entry.id, entry]));
  const saved = new Set<string>();
  const batch: LocalCwEntry[] = [];
  for (const item of items) {
    if (!item.content_id || saved.has(item.content_id)) continue;
    saved.add(item.content_id);
    const local = current.get(item.content_id);
    if (local && local.t > progressTime(item)) continue;
    batch.push({
      id: item.content_id,
      type: item.season != null && item.episode != null ? "series" : "movie",
      name: item.name || item.title || item.content_id,
      poster: item.poster || undefined,
      background: item.background || undefined,
      season: item.season ?? undefined,
      episode: item.episode ?? undefined,
      positionMs: (item.progress_seconds || 0) * 1000,
      durationMs: (item.duration_seconds || 0) * 1000,
      t: item.last_watched || (item.updated_at ? Date.parse(item.updated_at) : Date.now()),
    });
  }
  saveLocalCwBatch(batch, ownerId);
}

/**
 * Pulls watch progress for the specified profile from Nuvio.
 * Caches records per profile slot and safely falls back to local cache if network drops.
 */
const progressPullInflight = new Map<string, Promise<NuvioWatchProgress[]>>();

export function pullWatchProgressFromNuvio(
  harborProfileId?: string | number,
): Promise<NuvioWatchProgress[]> {
  if (!isNuvioSignedIn() || !isNuvioProviderActive()) return Promise.resolve([]);
  const accountId = getNuvioAccountId();
  if (!accountId) return Promise.resolve([]);
  const slot = resolveNuvioProfileIndex(harborProfileId);
  const activeSlot = resolveNuvioProfileIndex();
  const key = `${accountId}:${slot}:${activeSlot}`;
  const existing = progressPullInflight.get(key);
  if (existing) return existing;
  const stillCurrent = () =>
    isNuvioSignedIn() &&
    isNuvioProviderActive() &&
    getNuvioAccountId() === accountId &&
    resolveNuvioProfileIndex() === activeSlot;
  const work = pullWatchProgressOnce(slot, accountId, stillCurrent);
  progressPullInflight.set(key, work);
  void work
    .finally(() => {
      if (progressPullInflight.get(key) === work) progressPullInflight.delete(key);
    })
    .catch(() => {});
  return work;
}

async function pullWatchProgressOnce(
  slot: number,
  accountId: string,
  stillCurrent: () => boolean,
): Promise<NuvioWatchProgress[]> {
  const startedAt = Date.now();
  const pending = readPending(slot, accountId);
  let raw: unknown[] | null = null;
  let complete = false;
  try {
    const res = await nuvioFetch("/rest/v1/rpc/sync_pull_watch_progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_profile_id: slot, p_limit: 50 }),
    });
    if (!stillCurrent()) return [];
    if (res.ok) {
      const rows: unknown = await res.json();
      if (Array.isArray(rows) && rows.every((row) => validRow(row, slot, accountId))) raw = rows;
    }
  } catch {
    // The table snapshot can still provide an authoritative response.
  }
  if (!stillCurrent()) return [];
  const rpcRows = raw;
  const rpcCoordinates = new Set((rpcRows ?? []).map((row) => coordinate(row as NuvioCoordinate)));
  const needsConfirmation = Object.values(readPending(slot, accountId)).some(
    (change) =>
      change.kind === "progress" &&
      (change.deleted || !rpcCoordinates.has(coordinate(change.row))),
  );
  const fullSyncKey = `${accountId}:${slot}`;
  const lastFullSync = lastFullSyncAt.get(fullSyncKey) ?? 0;
  const fullSyncDue = !lastFullSync || Date.now() - lastFullSync >= FULL_SYNC_INTERVAL_MS;
  // Routine pulls only merge the latest RPC batch. A full snapshot is needed to
  // prune remote deletions, so it is throttled and forced by pending mutations.
  if (!rpcRows || needsConfirmation || fullSyncDue) {
    try {
      const table = await readTableSnapshot<NuvioWatchProgress>(
        "watch_progress",
        slot,
        accountId,
        stillCurrent,
        rpcRows?.length === 0,
      );
      if (table) {
        // A table that contradicts the RPC batch is not an authoritative
        // snapshot. Keep the RPC/cached history instead of pruning it.
        const tableCoordinates = new Set(table.map((row) => coordinate(row)));
        const consistent =
          !rpcRows ||
          rpcRows.every((row) => tableCoordinates.has(coordinate(row as NuvioCoordinate)));
        if (consistent) {
          raw = table;
          complete = true;
          lastFullSyncAt.set(fullSyncKey, Date.now());
        } else {
          console.warn(
            "[nuvio-sync] table snapshot does not match the RPC batch; keeping cached history",
          );
        }
      }
    } catch {
      // Keep a usable RPC batch, but never prune using it.
    }
  }
  if (!stillCurrent()) return [];
  if (!raw || (raw.length === 0 && !complete)) return readCachedWatchProgress(slot, accountId);

  const previous = readCachedWatchProgress(slot, accountId);
  const byCoordinate = new Map(previous.map((row) => [coordinate(row), row]));
  const rows: NuvioWatchProgress[] = [];
  for (const value of raw) {
    const item = value as NuvioWatchProgress & { position?: number; duration?: number };
    const prev = byCoordinate.get(coordinate(item));
    const time = progressTime(item);
    const progress = Math.max(
      0,
      Math.round(
        item.position != null ? Number(item.position) / 1000 : Number(item.progress_seconds) || 0,
      ),
    );
    const duration = Math.max(
      0,
      Math.round(
        item.duration != null ? Number(item.duration) / 1000 : Number(item.duration_seconds) || 0,
      ),
    );
    if (!Number.isFinite(progress) || !Number.isFinite(duration)) return previous;
    rows.push({
      ...item,
      profile_id: slot,
      progress_key: item.progress_key || item.content_id,
      progress_seconds: progress,
      duration_seconds: duration,
      last_watched: time,
      updated_at: time ? new Date(time).toISOString() : prev?.updated_at,
      title: item.title || item.name || prev?.title || prev?.name,
      name: item.name || item.title || prev?.name || prev?.title,
      poster: item.poster || prev?.poster,
      background: item.background || prev?.background,
    });
  }
  const merged = applyPending(rows, slot, accountId, "progress", complete, pending);
  const allowedPrevious = previous.filter(
    (row) => !merged.deleted.some((change) => matchesChange(row, change)),
  );
  const items = merged.items;
  const ownerId = `nuvio-${slot}`;
  const newestByContent = new Map<string, number>();
  for (const row of [...items, ...allowedPrevious]) {
    newestByContent.set(
      row.content_id,
      Math.max(newestByContent.get(row.content_id) ?? 0, progressTime(row)),
    );
  }
  // Native playback may have saved a newer checkpoint before its throttled push.
  for (const local of listLocalCw(false, ownerId)) {
    if (
      merged.deleted.some((change) =>
        matchesChange(
          {
            content_id: local.id,
            season: local.season,
            episode: local.episode,
            last_watched: local.t,
          } as NuvioWatchProgress,
          change,
        ),
      )
    )
      continue;
    const newest = newestByContent.get(local.id) ?? 0;
    if (local.t <= newest || (!newestByContent.has(local.id) && local.t <= startedAt)) continue;
    const localRow: NuvioWatchProgress = {
      profile_id: slot,
      content_id: local.id,
      progress_key:
        local.season != null && local.episode != null
          ? `${local.id}_s${local.season}e${local.episode}`
          : local.id,
      season: local.season,
      episode: local.episode,
      progress_seconds: local.positionMs / 1000,
      duration_seconds: local.durationMs / 1000,
      last_watched: local.t,
      updated_at: new Date(local.t).toISOString(),
      name: local.name,
      poster: local.poster,
      background: local.background,
    };
    const index = items.findIndex((row) => coordinate(row) === coordinate(localRow));
    if (index >= 0) items[index] = localRow;
    else items.push(localRow);
  }
  const ids = reconcileNuvioProgressHistory(allowedPrevious, items, slot, complete);
  if (!stillCurrent()) return [];
  items.sort((a, b) => progressTime(b) - progressTime(a));
  writeCachedWatchProgress(slot, items, accountId);
  try {
    const playback = readCachedNuvioPlaybackItems(slot, accountId);
    writeCachedNuvioPlaybackItems(
      slot,
      playback.filter((row) => ids.has(row._id)),
      accountId,
    );
    localStorage.removeItem(`harbor.nuvio.playback_items.slot.${slot}`);
  } catch {
    // A disposable playback cache cannot reject a verified progress snapshot.
  }
  saveLatestNuvioLocalProgress(items, slot);
  const state = loadNuvioState();
  if (state.session?.user?.id === accountId) saveNuvioState({ ...state, lastSyncedAt: Date.now() });
  window.dispatchEvent(
    new CustomEvent("harbor:nuvio-progress-reconciled", {
      detail: { profileIndex: slot, count: items.length },
    }),
  );
  return items;
}

/**
 * Pulls addons for the specified profile from Nuvio.
 * If uses_primary_addons is enabled on this profile, pulls profile 1's addons.
 */
export async function pullAddonsFromNuvio(
  harborProfileId: string,
): Promise<NuvioAddonItem[]> {
  if (!isNuvioSignedIn()) return [];

  let profileIndex = resolveNuvioProfileIndex(harborProfileId);
  const state = loadNuvioState();
  const profile = state.profiles.find((p) => p.profile_index === profileIndex);
  if (profile?.uses_primary_addons) {
    profileIndex = 1;
  }

  try {
    const res = await nuvioFetch(
      `/rest/v1/addons?profile_id=eq.${profileIndex}&order=sort_order.asc`,
    );

    if (!res.ok) return [];

    const list = (await res.json()) as NuvioAddonItem[];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn("[nuvio] failed to pull addons", err);
    return [];
  }
}

/**
 * Pushes installed addons to Nuvio using the `sync_push_addons` RPC
 */
export async function pushAddonsToNuvio(
  harborProfileId: string,
  addons: NuvioAddonItem[],
): Promise<boolean> {
  if (!isNuvioSignedIn()) return false;

  const profileIndex = resolveNuvioProfileIndex(harborProfileId);

  try {
    const clientId = getOrCreateSyncClientId();
    const res = await nuvioFetch("/rest/v1/rpc/sync_push_addons", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_profile_id: profileIndex,
        p_addons: addons,
        p_origin_client_id: clientId,
      }),
    });

    if (res.ok) {
      console.info(`[nuvio-sync] addons pushed via RPC for profile ${profileIndex} (${addons.length} addons)`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[nuvio] failed to push addons", err);
    return false;
  }
}
