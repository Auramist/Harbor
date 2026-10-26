import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function deferred() {
  let resolve!: (page: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const page = (ids: string[], nextCursor?: string) => ({
  items: ids.map((itemKey) => ({
    itemKey,
    mediaType: "movie",
    score: 8,
    title: itemKey,
    at: "2026-01-01",
  })),
  nextCursor,
});

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

/**
 * The loader behind the "#" picker and the resolver behind every quoted card are the same
 * module, so the harness drives that module directly: the ratings API answers page by page and
 * the hook runs on a minimal React that re-renders whenever it sets state. Each harness
 * re-evaluates the module, so the loader's cache never leaks between tests.
 */
function quotedHarness() {
  const states: any[] = [];
  const refs: any[] = [];
  const effects: Array<{ deps: any[]; cleanup?: () => void }> = [];
  let si = 0;
  let ri = 0;
  let ei = 0;
  let dirty = false;
  let pending: Array<{ i: number; deps: any[]; run: () => any }> = [];
  const same = (a: any[], b: any[]) =>
    a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial: any) {
      const i = si++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (next: any) => {
          const value = typeof next === "function" ? next(states[i]) : next;
          if (!Object.is(value, states[i])) {
            states[i] = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial: any) {
      return refs[ri++] ?? (refs[ri - 1] = { current: initial });
    },
    useEffect(run: () => any, deps: any[]) {
      const i = ei++;
      if (!effects[i] || !same(effects[i].deps, deps)) pending.push({ i, deps, run });
    },
  };
  const requests: Array<{ handle: string; opts: any; job: ReturnType<typeof deferred> }> = [];
  const mocks: Record<string, any> = {
    react,
    "@/lib/social/ratings-api": {
      fetchUserRatings(handle: string, opts: any) {
        const job = deferred();
        requests.push({ handle, opts, job });
        return job.promise;
      },
    },
  };
  const source = readFileSync(
    new URL("../src/views/profile/use-quoted-rating.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function("require", "exports", output)((id: string) => {
    assert.ok(id in mocks, `unexpected import ${id}`);
    return mocks[id];
  }, exports);

  let quote: any = null;
  let value: any = null;

  function render() {
    let loops = 0;
    do {
      assert.ok(++loops < 10, "render should settle");
      dirty = false;
      si = ri = ei = 0;
      pending = [];
      value = exports.useQuotedRating(quote);
      for (const effect of pending) effects[effect.i]?.cleanup?.();
      for (const effect of pending)
        effects[effect.i] = { deps: effect.deps, cleanup: effect.run() };
    } while (dirty);
  }

  async function settle() {
    await flush();
    render();
  }

  async function resolveNext(next: any) {
    const at = requests.length - 1;
    assert.ok(at >= 0, "no ratings request is in flight");
    requests[at].job.resolve(next);
    await flush();
  }

  return {
    requests,
    /** The picker's path: quote anyone's list and look a rating up in it. */
    load: (handle: string) => exports.loadRatings(handle) as Promise<any[]>,
    /** The quoted card's path: resolve one rating for a posted comment. */
    async open(next: any) {
      quote = next;
      render();
      await settle();
    },
    resolveNext,
    async rejectNext(error: Error) {
      const at = requests.length - 1;
      assert.ok(at >= 0, "no ratings request is in flight");
      requests[at].job.reject(error);
      await settle();
    },
    settle,
    state: () => value,
  };
}

const quote = (authorHandle: string, itemKey: string) => ({
  authorHandle,
  itemKey,
  mediaType: "movie",
  score: 9,
});

test("the # picker reaches a rating on page four, past the old three-page cap", async () => {
  const h = quotedHarness();
  const list = h.load("alice-walk");
  await h.resolveNext(page(["r1"], "cursor-1"));
  await h.resolveNext(page(["r2"], "cursor-2"));
  await h.resolveNext(page(["r3"], "cursor-3"));
  await h.resolveNext(page(["Blue Heron"], "cursor-4"));
  await h.resolveNext(page(["r5"]));
  const ratings = await list;
  assert.deepEqual(
    ratings.map((r) => r.itemKey),
    ["r1", "r2", "r3", "Blue Heron", "r5"],
    "pages four and five must be walked like the first three",
  );
  assert.ok(
    ratings.some((r) => r.title.toLowerCase().includes("blue heron")),
    "a rating deep in someone's history stays selectable",
  );
  assert.equal(h.requests.length, 5, "exactly one request per page, none after the last");
});

test("the walk stops at the last page instead of asking for another", async () => {
  const h = quotedHarness();
  const list = h.load("alice-stop");
  await h.resolveNext(page(["only"]));
  assert.equal((await list).length, 1);
  assert.equal(h.requests.length, 1, "no request after a page without nextCursor");
});

test("a quote pointing at a page-four rating resolves instead of showing as missing", async () => {
  const h = quotedHarness();
  await h.open(quote("alice-resolve", "r4"));
  await h.resolveNext(page(["r1"], "cursor-1"));
  await h.resolveNext(page(["r2"], "cursor-2"));
  await h.resolveNext(page(["r3"], "cursor-3"));
  await h.resolveNext(page(["r4"], "cursor-4"));
  await h.resolveNext(page(["r5"]));
  await h.settle();
  assert.equal(h.state().state, "ready", "a rating that still exists must not read as missing");
  assert.equal(h.state().rating.itemKey, "r4");
  assert.equal(h.state().rating.title, "r4");
});

test("a rating deleted after it was quoted reports missing rather than breaking", async () => {
  const h = quotedHarness();
  await h.open(quote("alice-deleted", "gone"));
  await h.resolveNext(page(["kept"]));
  await h.settle();
  assert.equal(h.state().state, "missing");
  assert.equal(h.state().rating, undefined);
});

test("a refused ratings list reports missing instead of hanging on the spinner", async () => {
  const h = quotedHarness();
  await h.open(quote("alice-private", "r1"));
  await h.rejectNext(new Error("403 forbidden"));
  await h.settle();
  assert.equal(h.state().state, "missing");
});
