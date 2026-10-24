import { useCallback, useEffect, useRef, useState } from "react";
import { useRatingPoster } from "@/lib/ratings/poster";
import { createPortal } from "react-dom";
import { Eye, Loader2, X } from "lucide-react";
import { Search } from "@/components/icons/search-icon";
import { Poster } from "@/components/poster";
import { RatingStars } from "@/components/ratings/rating-stars";
import { rate } from "@/lib/ratings/actions";
import { useT } from "@/lib/i18n";
import { fetchUserRatings } from "@/lib/social/ratings-api";
import type { PublicRating, RatingCounts } from "@/lib/ratings/types";
import { timeAgo } from "@/views/profile/profile-bits";
import { useProfileTitle } from "@/views/profile/use-profile-title";
import { profileMediaMeta } from "@/lib/social/profile-media-meta";
import { useTitleContext } from "@/components/context-menu/use-title-context";

const TABS: Array<{ id: string; label: string; countKey: keyof RatingCounts }> = [
  { id: "all", label: "All", countKey: "total" },
  { id: "movie", label: "Movies", countKey: "movie" },
  { id: "series", label: "TV", countKey: "series" },
  { id: "anime", label: "Anime", countKey: "anime" },
  { id: "manga", label: "Manga", countKey: "manga" },
];

const EMPTY_COUNTS: RatingCounts = { movie: 0, series: 0, anime: 0, manga: 0, total: 0 };

/** Ordering reads the whole list, so it needs every page loaded first. */
type SortMode = "default" | "high" | "low";

type RatingsRequest = {
  handle: string;
  type: string;
  controller: AbortController;
  loading: boolean;
  more: boolean;
};

export function UserRatings({
  handle,
  alias,
  isOwner = false,
  onOpenMeta,
  onClose,
}: {
  handle: string;
  alias: string;
  isOwner?: boolean;
  onOpenMeta?: (metaId: string, kind?: string, hint?: { name?: string; poster?: string }) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [type, setType] = useState("all");
  const [items, setItems] = useState<PublicRating[]>([]);
  const [counts, setCounts] = useState<RatingCounts>(EMPTY_COUNTS);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortMode>("default");
  const [loadingAll, setLoadingAll] = useState(false);
  const cursorRef = useRef<string | undefined>(undefined);
  const seen = useRef<string | null>(null);
  const request = useRef<RatingsRequest | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  useEffect(() => {
    const ac = new AbortController();
    const current = { handle, type, controller: ac, loading: true, more: false };
    request.current = current;
    setLoading(true);
    setMore(false);
    setCursor(undefined);
    cursorRef.current = undefined;
    setItems([]);
    if (seen.current !== handle) setCounts(EMPTY_COUNTS);
    fetchUserRatings(handle, { type }, ac.signal)
      .then((page) => {
        if (ac.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        cursorRef.current = page.nextCursor;
        if (seen.current !== handle || type === "all") setCounts(page.counts);
        seen.current = handle;
        current.loading = false;
        setLoading(false);
      })
      .catch(() => {
        if (!ac.signal.aborted) {
          current.loading = false;
          setLoading(false);
        }
      });
    return () => {
      ac.abort();
      if (request.current === current) request.current = null;
    };
  }, [handle, type]);

  const loadMore = useCallback(async () => {
    const current = request.current;
    if (
      !cursor ||
      !current ||
      current.loading ||
      current.more ||
      current.handle !== handle ||
      current.type !== type ||
      current.controller.signal.aborted
    )
      return;
    current.more = true;
    setMore(true);
    try {
      const page = await fetchUserRatings(handle, { type, cursor }, current.controller.signal);
      if (request.current !== current || current.controller.signal.aborted) return;
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      cursorRef.current = page.nextCursor;
    } catch {
      // Keep the current page and cursor available for a retry.
    } finally {
      if (request.current === current && !current.controller.signal.aborted) {
        current.more = false;
        setMore(false);
      }
    }
  }, [cursor, handle, type]);

  const needle = q.trim().toLowerCase();
  // Searching and ordering both read the whole list rather than one page of it,
  // so either one finishes the pagination before the list is presented.
  const walkAll = needle.length > 0 || sort !== "default";

  // Walking the remaining cursor chain covers the whole ratings list instead of
  // the pages already on screen. It shares the tab's request identity, so a tab
  // switch, profile change or close cancels it exactly like manual pagination.
  // Turning the query or the ordering back off keeps everything it loaded.
  useEffect(() => {
    if (!walkAll || loading) {
      setLoadingAll(false);
      return;
    }
    const current = request.current;
    if (!current || current.handle !== handle || current.type !== type) return;
    let cancelled = false;
    setLoadingAll(true);
    void (async () => {
      let next = cursorRef.current;
      while (!cancelled && next) {
        const page = await fetchUserRatings(
          handle,
          { type, cursor: next },
          current.controller.signal,
        ).catch(() => null);
        if (cancelled || request.current !== current || current.controller.signal.aborted) return;
        if (!page) break;
        next = page.nextCursor;
        cursorRef.current = next;
        setItems((prev) => [...prev, ...page.items]);
        setCursor(next);
      }
      if (!cancelled) setLoadingAll(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [walkAll, loading, handle, type]);

  // Ordering a partly loaded list would visibly reshuffle as pages stream in, so
  // the list is held until the walk finishes. Searching still streams: matches
  // appearing as they are found is the point of it.
  const holdForOrder = loadingAll && sort !== "default";

  const filtered = needle ? items.filter((r) => r.title.toLowerCase().includes(needle)) : items;
  const visible =
    sort === "default"
      ? filtered
      : [...filtered].sort((a, b) => (sort === "high" ? b.score - a.score : a.score - b.score));

  const changeScore = useCallback(async (r: PublicRating, score: number) => {
    if (score === r.score) return;
    const previous = r.score;
    setItems((list) => list.map((x) => (x.itemKey === r.itemKey ? { ...x, score } : x)));
    try {
      await rate(
        { itemKey: r.itemKey, mediaType: r.mediaType, title: r.title, poster: r.posterUrl },
        score,
        { review: r.review, spoiler: r.spoiler },
      );
    } catch {
      // A rejected edit must not leave the row claiming a score the server never took.
      if (!request.current?.controller.signal.aborted) {
        setItems((list) =>
          list.map((x) => (x.itemKey === r.itemKey ? { ...x, score: previous } : x)),
        );
      }
    }
  }, []);

  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-[175] flex items-stretch justify-center bg-canvas/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("Ratings")}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-modal-in relative m-6 flex max-h-[calc(100vh-3rem)] w-full max-w-[900px] flex-col overflow-hidden rounded-3xl border border-edge-soft bg-surface shadow-[0_30px_120px_-30px_rgba(0,0,0,0.85)]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-edge-soft px-7 py-5">
          <h2 className="min-w-0 truncate font-display text-[24px] font-medium leading-tight tracking-tight text-ink">
            {t("{name}'s ratings", { name: alias })}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle"
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("Search ratings")}
                aria-label={t("Search ratings")}
                className="h-10 w-44 rounded-full border border-edge bg-canvas ps-9 pe-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink-subtle focus:bg-elevated sm:w-56"
              />
            </div>
            <button
              onClick={onClose}
              aria-label={t("Close")}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-edge text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </header>

        <div className="flex flex-wrap gap-1.5 border-b border-edge-soft px-7 py-3">
          {TABS.map((tab) => {
            const n = counts[tab.countKey];
            if (tab.id !== "all" && n === 0) return null;
            const active = type === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setType(tab.id)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                  active ? "bg-ink text-canvas" : "text-ink-muted hover:bg-elevated hover:text-ink"
                }`}
              >
                {t(tab.label)}
                <span className={`tabular-nums ${active ? "text-canvas/70" : "text-ink-subtle"}`}>
                  {n}
                </span>
              </button>
            );
          })}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            aria-label={t("Sort ratings")}
            className="ms-auto h-8 rounded-full border border-edge bg-canvas ps-3 pe-2 text-[12.5px] font-medium text-ink-muted outline-none transition-colors hover:bg-elevated hover:text-ink focus:border-ink-subtle"
          >
            <option value="default">{t("Default order")}</option>
            <option value="high">{t("Highest rated")}</option>
            <option value="low">{t("Lowest rated")}</option>
          </select>
        </div>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          {loading || holdForOrder ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-[13.5px] text-ink-muted">
              <Loader2 size={22} className="animate-spin text-ink-subtle" />
              {holdForOrder && <span>{t("Loading all ratings")}</span>}
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-[13.5px] text-ink-muted">
              {loadingAll && <Loader2 size={18} className="animate-spin text-ink-subtle" />}
              {loadingAll
                ? t("Loading all ratings")
                : needle
                  ? t("No ratings match your search")
                  : t("No ratings yet")}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {visible.map((r) => (
                <RatingRow
                  key={r.itemKey}
                  r={r}
                  onOpenMeta={onOpenMeta}
                  onRate={isOwner ? changeScore : undefined}
                />
              ))}
              {loadingAll ? (
                <div className="mx-auto mt-2 inline-flex items-center gap-2 text-[12.5px] text-ink-subtle">
                  <Loader2 size={14} className="animate-spin" />
                  {t("Loading all ratings")}
                </div>
              ) : (
                cursor && (
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={more}
                    className="mx-auto mt-2 inline-flex items-center gap-2 rounded-full border border-edge px-5 py-2 text-[13px] font-medium text-ink-muted transition-colors hover:bg-elevated hover:text-ink disabled:opacity-50"
                  >
                    {more && <Loader2 size={14} className="animate-spin" />}
                    {t("Load more")}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RatingRow({
  r,
  onOpenMeta,
  onRate,
}: {
  r: PublicRating;
  onOpenMeta?: (metaId: string, kind?: string, hint?: { name?: string; poster?: string }) => void;
  onRate?: (r: PublicRating, score: number) => void;
}) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const poster = useRatingPoster(r.itemKey, r.mediaType, r.title, r.posterUrl);
  const media = useProfileTitle(r.itemKey, r.title, poster, r.mediaType);
  const open = onOpenMeta
    ? () => onOpenMeta(r.itemKey, r.mediaType, { name: media.title, poster: media.poster })
    : undefined;

  const onContextMenu = useTitleContext(
    profileMediaMeta(r.itemKey, r.mediaType, { name: media.title, poster: media.poster }),
    media.poster,
  );
  return (
    <div
      ref={media.ref}
      className="flex gap-4 rounded-2xl border border-edge-soft bg-canvas/40 p-3.5"
    >
      <button
        type="button"
        onClick={open}
        onContextMenu={onContextMenu}
        disabled={!open}
        className="w-16 shrink-0 disabled:cursor-default"
      >
        <Poster
          src={media.poster}
          seed={r.title}
          ratio="portrait"
          lazy
          className="rounded-[8px] ring-1 ring-edge-soft"
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={open}
            onContextMenu={onContextMenu}
            disabled={!open}
            className="truncate text-start text-[15px] font-semibold text-ink hover:underline disabled:cursor-default disabled:no-underline"
          >
            {media.title}
          </button>
          <span className="shrink-0 text-[12px] tabular-nums text-ink-subtle">{timeAgo(r.at)}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          {editing ? (
            // Revealed deliberately: RatingStars commits on pointer-down, so an
            // always-live row would let a stray click rewrite a real rating.
            <RatingStars
              value={r.score}
              size={16}
              ariaLabel={t("Change rating")}
              onChange={(n) => {
                setEditing(false);
                onRate?.(r, n);
              }}
            />
          ) : (
            <>
              <RatingStars value={r.score} readOnly size={14} />
              <span className="text-[12px] font-bold tabular-nums text-ink">{r.score}/10</span>
              {onRate && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded-full border border-edge px-2.5 py-0.5 text-[11.5px] font-medium text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
                >
                  {t("Edit")}
                </button>
              )}
            </>
          )}
        </div>
        {r.review && (
          <div className="relative mt-2">
            <p
              className={`whitespace-pre-line text-[13.5px] leading-relaxed text-ink-muted ${
                r.spoiler && !revealed ? "select-none blur-sm" : ""
              }`}
            >
              {r.review}
            </p>
            {r.spoiler && !revealed && (
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-lg bg-canvas/30 text-[12px] font-semibold text-ink transition-colors hover:bg-canvas/10"
              >
                <Eye size={14} />
                {t("Show spoiler")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
