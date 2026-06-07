import { describe, it, expect } from "vitest";
import { resetLocaleForProjectSwitch } from "../components/I18nProvider";
import type { Register } from "../types";

// Regression for the v0.4 audit "high" concern: when <I18nProvider> recreates
// its TranslationClient on a PROJECT SWITCH (projectId/projectKey/apiUrl/
// apiToken change) it must atomically (a) reset the displayed
// currentLang/currentRegister/error and reload supportedLangs, and (b)
// invalidate any in-flight setLang/applyLocale/init from the OLD project so a
// slow fetch can't resolve and commit against the NEW client/state.
//
// The provider's render-phase reset is factored into the pure
// `resetLocaleForProjectSwitch` helper precisely so this race-fix is testable
// without a DOM render harness (the SDK's vitest setup is non-DOM: no
// jsdom/@testing-library, node environment, fetch-spy style — see
// store-hardening.test.ts). These tests drive that exact seam.

// A tiny stand-in for React's `useRef` cells.
function ref<T>(initial: T): { current: T } {
  return { current: initial };
}

// Capture every state setter call so we can assert the committed reset.
function makeSetterSpies() {
  const calls: Record<string, unknown[]> = {
    setCurrentLang: [],
    setCurrentRegister: [],
    setError: [],
    setIsLoading: [],
    setSupportedLangs: [],
  };
  return {
    calls,
    setters: {
      setCurrentLang: (v: string) => calls.setCurrentLang.push(v),
      setCurrentRegister: (v: Register) => calls.setCurrentRegister.push(v),
      setError: (v: string | null) => calls.setError.push(v),
      setIsLoading: (v: boolean) => calls.setIsLoading.push(v),
      setSupportedLangs: (v: string[]) => calls.setSupportedLangs.push(v),
    },
  };
}

describe("I18nProvider — project switch resets locale state", () => {
  it("resets pending refs and committed state to the NEW project's defaults", () => {
    // Simulate the OLD project having switched to hi/formal with langs loaded.
    const localeReqRef = ref(5);
    const initReqRef = ref(5);
    const pendingLangRef = ref("hi");
    const pendingRegisterRef = ref<Register>("formal");
    const { calls, setters } = makeSetterSpies();

    resetLocaleForProjectSwitch(
      { localeReqRef, initReqRef, pendingLangRef, pendingRegisterRef },
      { defaultLang: "en", register: "default" },
      setters
    );

    // Pending target rolled back to the new project's defaults.
    expect(pendingLangRef.current).toBe("en");
    expect(pendingRegisterRef.current).toBe("default");

    // Committed state reset: no carry-over of the old project's lang/register.
    expect(calls.setCurrentLang).toEqual(["en"]);
    expect(calls.setCurrentRegister).toEqual(["default"]);
    // Error cleared, loading on, supported languages emptied so they reload.
    expect(calls.setError).toEqual([null]);
    expect(calls.setIsLoading).toEqual([true]);
    expect(calls.setSupportedLangs).toEqual([[]]);
  });

  it("honors a non-default new-project register (e.g. segment-resolved 'casual')", () => {
    const localeReqRef = ref(0);
    const initReqRef = ref(0);
    const pendingLangRef = ref("ne");
    const pendingRegisterRef = ref<Register>("formal");
    const { calls, setters } = makeSetterSpies();

    resetLocaleForProjectSwitch(
      { localeReqRef, initReqRef, pendingLangRef, pendingRegisterRef },
      { defaultLang: "hi", register: "casual" },
      setters
    );

    expect(pendingLangRef.current).toBe("hi");
    expect(pendingRegisterRef.current).toBe("casual");
    expect(calls.setCurrentLang).toEqual(["hi"]);
    expect(calls.setCurrentRegister).toEqual(["casual"]);
  });
});

describe("I18nProvider — project switch invalidates in-flight requests", () => {
  it("bumps the shared locale counter so a previously-issued reqId is stale", () => {
    const localeReqRef = ref(3);

    // An in-flight applyLocale/setLang/init from the OLD project captured this
    // reqId at call time (it does `const reqId = ++localeReqRef.current`).
    const inFlightReqId = ++localeReqRef.current; // 4
    expect(inFlightReqId).toBe(localeReqRef.current); // still latest, pre-switch

    // The project switch happens. The render-phase reset bumps the counter.
    resetLocaleForProjectSwitch(
      { localeReqRef, initReqRef: ref(0), pendingLangRef: ref("x"), pendingRegisterRef: ref<Register>("default") },
      { defaultLang: "en", register: "default" },
      makeSetterSpies().setters
    );

    // The old request's guard `if (reqId !== localeReqRef.current) return` now
    // fires: its reqId no longer matches, so when its slow fetch resolves it
    // bails BEFORE committing lang/register/translations against the new client.
    expect(inFlightReqId).not.toBe(localeReqRef.current);
    expect(localeReqRef.current).toBeGreaterThan(inFlightReqId);
  });

  it("a slow OLD-project request that resolves AFTER the switch does not commit", () => {
    // End-to-end of the guard contract: model the exact bail check that
    // applyLocale and init perform, and prove the commit is skipped.
    const localeReqRef = ref(0);

    let committed: string | null = null;
    // OLD project kicks off a switch to "hi": captures reqId, then "awaits".
    const reqId = ++localeReqRef.current;
    const resolveOldRequest = () => {
      // This runs when the slow fetch finally resolves, AFTER the switch.
      if (reqId !== localeReqRef.current) return; // the real guard
      committed = "hi"; // would clobber the new project — must NOT happen
    };

    // Meanwhile the user switches projects.
    resetLocaleForProjectSwitch(
      { localeReqRef, initReqRef: ref(0), pendingLangRef: ref("hi"), pendingRegisterRef: ref<Register>("default") },
      { defaultLang: "en", register: "default" },
      makeSetterSpies().setters
    );

    // Now the slow old-project fetch resolves.
    resolveOldRequest();

    // The stale request bailed: it did NOT commit the old project's language.
    expect(committed).toBeNull();
  });

  it("the NEW project's init claims the latest reqId and is free to commit", () => {
    const localeReqRef = ref(0);

    // Old in-flight request.
    const oldReqId = ++localeReqRef.current;

    // Switch.
    resetLocaleForProjectSwitch(
      { localeReqRef, initReqRef: ref(0), pendingLangRef: ref("hi"), pendingRegisterRef: ref<Register>("default") },
      { defaultLang: "en", register: "default" },
      makeSetterSpies().setters
    );

    // The new project's init effect runs and claims the newest reqId.
    const newReqId = ++localeReqRef.current;

    // Old request is stale; new init is current and may commit.
    expect(oldReqId).not.toBe(localeReqRef.current);
    expect(newReqId).toBe(localeReqRef.current);
  });
});
