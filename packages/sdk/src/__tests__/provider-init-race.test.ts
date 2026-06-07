import { describe, it, expect, vi } from "vitest";
import { runProjectInit } from "../components/I18nProvider";
import type { Register } from "../types";

// Regression for the v0.4 audit BLOCKER: the <I18nProvider> init effect used to
// claim its reqId from the SHARED `localeReqRef` and bail with
// `if (reqId !== localeReqRef.current) return` AFTER `client.fetchProjectInfo()`.
// If a user (or a LanguageSwitcher) called `setLang()` WHILE init's project-
// metadata fetch was in flight, `setLang` bumped `localeReqRef` → init's reqId
// went stale → init `return`ed and `setSupportedLangs` was NEVER called. The
// LanguageSwitcher then stayed empty forever (supportedLangs=[], isLoading=false,
// no error) and never retried.
//
// THE FIX: init guards its PROJECT-METADATA commits (setSupportedLangs /
// setError / the finally setIsLoading(false)) on a DEDICATED `initReqRef` that a
// plain setLang does NOT bump. Only a genuine project switch (new init / reset)
// bumps it. The init's VISIBLE-LOCALE commit still cooperates with the shared
// `localeReqRef`, so a concurrent setLang wins the visible language — but
// supportedLangs always loads.
//
// These tests drive the extracted `runProjectInit` seam directly (the SDK's
// vitest setup is node-environment, no jsdom/@testing-library — see
// provider-project-switch.test.ts), so they fail on the single-counter code and
// pass on the two-counter fix.

// A tiny stand-in for React's `useRef` cells.
function ref<T>(initial: T): { current: T } {
  return { current: initial };
}

// Capture every setter call so we can assert what init committed.
function makeSetterSpies() {
  const calls = {
    setIsLoading: [] as boolean[],
    setError: [] as (string | null)[],
    setSupportedLangs: [] as string[][],
    bumpRenderTrigger: 0,
  };
  return {
    calls,
    setters: {
      setIsLoading: (v: boolean) => calls.setIsLoading.push(v),
      setError: (v: string | null) => calls.setError.push(v),
      setSupportedLangs: (v: string[]) => calls.setSupportedLangs.push(v),
      bumpRenderTrigger: () => {
        calls.bumpRenderTrigger++;
      },
    },
  };
}

// A fake client whose fetchProjectInfo() is a manually-resolved deferred, so a
// test can interleave a `setLang`-style counter bump WHILE project metadata is
// "in flight". All other fetches resolve immediately.
function makeDeferredClient(langs: string[]) {
  let resolveProjectInfo!: (langs: string[]) => void;
  const projectInfo = new Promise<string[]>((res) => {
    resolveProjectInfo = res;
  });
  const fetchTranslations = vi.fn(() => Promise.resolve());
  const fetchVoice = vi.fn(() => Promise.resolve());
  let supported = [...langs];
  return {
    resolveProjectInfo: () => resolveProjectInfo(langs),
    fetchTranslations,
    fetchVoice,
    client: {
      setSupportedLangs: (l: string[]) => {
        supported = l;
      },
      getSupportedLangs: () => supported,
      fetchProjectInfo: () => projectInfo,
      fetchTranslations,
      fetchVoice,
    },
  };
}

describe("I18nProvider — setLang during init must NOT cancel supportedLangs loading", () => {
  it("a concurrent localeReqRef bump (setLang) does not strand the LanguageSwitcher empty", async () => {
    const localeReqRef = ref(0);
    const initReqRef = ref(0);
    const pendingRegisterRef = ref<Register>("default");
    const { calls, setters } = makeSetterSpies();
    const { resolveProjectInfo, client } = makeDeferredClient(["en", "hi", "ne"]);

    // Kick off init. It claims initReqId AND localeReqId, then awaits
    // fetchProjectInfo (deferred — does NOT resolve yet).
    const initPromise = runProjectInit(
      { localeReqRef, initReqRef, pendingRegisterRef },
      { defaultLang: "hi", voiceEnabled: false },
      client,
      setters
    );

    // While project metadata is in flight, the user clicks a LanguageSwitcher
    // option → setLang bumps ONLY the shared locale counter (exactly what
    // applyLocale/setLang do). It must NOT bump initReqRef.
    localeReqRef.current++;

    // Now project metadata arrives and init continues.
    resolveProjectInfo();
    await initPromise;

    // THE BUG (single counter): init's reqId went stale on the localeReqRef
    // bump, so it bailed and never called setSupportedLangs. THE FIX: the
    // metadata commit is guarded on initReqRef (untouched by the bump), so
    // supportedLangs IS populated — the LanguageSwitcher is no longer empty.
    expect(calls.setSupportedLangs).toEqual([["en", "hi", "ne"]]);

    // And isLoading settles to false from init (no stuck spinner), with no error.
    expect(calls.setIsLoading.at(-1)).toBe(false);
    expect(calls.setError).toEqual([null]); // only the init's reset-to-null
  });

  it("a genuine project switch (initReqRef bump) DOES supersede the in-flight init", async () => {
    const localeReqRef = ref(0);
    const initReqRef = ref(0);
    const pendingRegisterRef = ref<Register>("default");
    const { calls, setters } = makeSetterSpies();
    const { resolveProjectInfo, client } = makeDeferredClient(["en", "hi"]);

    const initPromise = runProjectInit(
      { localeReqRef, initReqRef, pendingRegisterRef },
      { defaultLang: "hi", voiceEnabled: false },
      client,
      setters
    );

    // A REAL project switch happens mid-fetch — resetLocaleForProjectSwitch
    // bumps BOTH counters. Model that here.
    localeReqRef.current++;
    initReqRef.current++;

    resolveProjectInfo();
    await initPromise;

    // The old init is now stale on the init counter: it must NOT commit the old
    // project's supportedLangs over the new project, and must NOT flip the
    // spinner off (the new project is still loading).
    expect(calls.setSupportedLangs).toEqual([]);
    expect(calls.setIsLoading).toEqual([true]); // only the initial setIsLoading(true)
  });

  it("with no concurrent switch, init commits supportedLangs and settles cleanly", async () => {
    const localeReqRef = ref(0);
    const initReqRef = ref(0);
    const pendingRegisterRef = ref<Register>("default");
    const { calls, setters } = makeSetterSpies();
    const { resolveProjectInfo, client } = makeDeferredClient(["en", "bn"]);

    const initPromise = runProjectInit(
      { localeReqRef, initReqRef, pendingRegisterRef },
      { defaultLang: "en", voiceEnabled: false },
      client,
      setters
    );
    resolveProjectInfo();
    await initPromise;

    expect(calls.setSupportedLangs).toEqual([["en", "bn"]]);
    expect(calls.setIsLoading.at(-1)).toBe(false);
    expect(calls.bumpRenderTrigger).toBe(1); // visible-locale commit ran
  });
});
