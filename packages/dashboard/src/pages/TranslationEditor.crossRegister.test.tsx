/**
 * Cross-register save-race regression tests.
 *
 * THE BUG (external audit, high concern): per-cell dirty tracking keys on
 * `${id}:${lang}:${register}`, but the optimistic baseline (`originalValueRef`)
 * and the in-flight save guard (`inFlightSavesRef`) were keyed by only
 * `${id}:${lang}`. So when a PUT for register A was still in flight and the user
 * switched the editor to register B, the save-completion handler read the
 * CURRENTLY-SELECTED register (B) instead of the register it actually saved (A).
 * Consequences: it cleared/blocked the wrong register's cell — leaving a cell
 * permanently dirty, dropping an edit, or blocking a legit edit in register B.
 *
 * THE FIX: the saved register is captured ONCE at the start of saveTranslation
 * (`editedRegister`) and threaded through the whole lifecycle — the baseline
 * key, the in-flight guard, the dirty-set `markCellClean`/`markCellDirty` calls,
 * and the autosave-on-completion re-save. The completion handler NEVER re-reads
 * the currently-selected register.
 *
 * Strategy: render the REAL editor with `api` mocked (same harness as the
 * escape/save tests). Drive a Hindi edit in the DEFAULT register, gate its PUT
 * open, switch the register selector to FORMAL while the PUT is in flight, then
 * release the PUT and assert the right register's state changed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ─── Mocks (mirror TranslationEditor.escape.test.tsx) ───────────────────────
const { get, put, post } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
}));
vi.mock("../utils/api", () => ({
  default: { get, put, post },
  getErrorMessage: (e: any) => e?.response?.data?.message || "Something went wrong",
}));

vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({
    unreadCount: 0,
    notifications: [],
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ projectId: "p1" }),
  useNavigate: () => vi.fn(),
  Link: ({ children, ...rest }: any) => <a {...rest}>{children}</a>,
}));

import TranslationEditor from "./TranslationEditor";

// ─── Fixtures ────────────────────────────────────────────────────────────────
const PROJECT = {
  _id: "p1",
  name: "Demo",
  supportedLanguages: ["en", "hi"],
  defaultLanguage: "en",
  myRole: "owner",
};

// Hindi has distinct cells per register so a default-register edit is visibly
// independent of the formal-register cell (no default fallback masking it).
function freshTranslations() {
  return [
    {
      _id: "t1",
      key: "greeting",
      translations: {
        en: { default: "Hello" },
        hi: { default: "नमस्ते", formal: "सादर अभिवादन" },
      },
      source: "human",
      sources: { en: { default: "human" }, hi: { default: "human", formal: "human" } },
    },
  ];
}

function wireGets() {
  get.mockImplementation((url: string) => {
    if (url.startsWith("/translations/p1/stats")) {
      return Promise.resolve({ data: { data: { languages: {} } } });
    }
    if (url.includes("/memory/coverage")) {
      return Promise.resolve({ data: { data: { total: 0 } } });
    }
    if (url.startsWith("/translations/p1")) {
      return Promise.resolve({
        data: {
          data: {
            data: freshTranslations(),
            pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          },
        },
      });
    }
    if (url.includes("/glossary")) {
      return Promise.resolve({ data: { data: [] } });
    }
    if (url.includes("/usage")) {
      return Promise.resolve({ data: { data: {} } });
    }
    if (url.startsWith("/projects/p1")) {
      return Promise.resolve({ data: { data: PROJECT } });
    }
    return Promise.resolve({ data: { data: {} } });
  });
}

// The Hindi cell is grid col 1 (col 0 = en). Found by position, not value, so
// it stays valid after edits and register switches re-render the same input.
async function findHindiCell(): Promise<HTMLInputElement> {
  return await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      `input[data-row="0"][data-col="1"]`
    );
    if (!el) throw new Error("hindi cell not found");
    return el;
  });
}

// Click a register tab by its visible label ("Default" | "Formal" | "Casual").
async function switchRegister(user: ReturnType<typeof userEvent.setup>, label: string) {
  const tab = await screen.findByRole("tab", { name: label });
  await user.click(tab);
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  post.mockReset();
  wireGets();
  put.mockResolvedValue({
    data: { data: { ...freshTranslations()[0], source: "human" } },
  });
  // The register-switch guard calls window.confirm when there are unsaved
  // changes. Default to "yes, switch" so the test can drive the switch.
  vi.spyOn(window, "confirm").mockReturnValue(true);
  // Start every test in the default register (localStorage persists it).
  window.localStorage.clear();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TranslationEditor — cross-register save race", () => {
  it("clears the SAVED register's dirty state (not the currently-selected one) when the user switches register mid-flight", async () => {
    const user = userEvent.setup();

    // Gate the FIRST PUT so the Hindi-default save stays in flight while we
    // switch to the formal register.
    let releaseFirst!: () => void;
    const firstResolved = new Promise<void>((r) => (releaseFirst = r));
    let putCount = 0;
    put.mockImplementation((_url: string, body: any) => {
      putCount += 1;
      const response = {
        data: {
          data: { ...freshTranslations()[0], translations: body.translations, source: "human" },
        },
      };
      return putCount === 1 ? firstResolved.then(() => response) : Promise.resolve(response);
    });

    render(<TranslationEditor />);

    // Edit Hindi in the DEFAULT register and blur to kick off the save.
    const hi = await findHindiCell();
    await user.click(hi);
    await user.type(hi, "!");            // edits the default-register Hindi cell
    await user.tab();                    // blur → PUT for (hi, default), gated open

    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    // The in-flight PUT is for the DEFAULT register.
    expect(put.mock.calls[0][1].editedRegister).toBe("default");
    // The cell is dirty (save not yet resolved) → indicator present.
    await waitFor(() => {
      expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
    });

    // Switch to FORMAL while the default-register PUT is still in flight. This
    // is the trigger for the bug: the completion handler must NOT use "formal".
    await switchRegister(user, "Formal");

    // Release the gated PUT. The save completes for the register it ACTUALLY
    // saved (default) — so the default Hindi cell is marked clean. With the bug
    // it would have cleared "formal" and left "default" permanently dirty.
    releaseFirst();

    // No newer edit landed → exactly one PUT, no auto re-save.
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(put).toHaveBeenCalledTimes(1);

    // (a) + (c): the saved (default) cell's dirty state is cleared and nothing
    // leaked — no cell is permanently dirty, so the indicator is gone.
    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();
    });
  });

  it("keeps register B's state independent: an edit in the new register is still dirty and saveable after the register-A save completes", async () => {
    const user = userEvent.setup();

    // Gate the first PUT (the Hindi-default save) open.
    let releaseFirst!: () => void;
    const firstResolved = new Promise<void>((r) => (releaseFirst = r));
    let putCount = 0;
    put.mockImplementation((_url: string, body: any) => {
      putCount += 1;
      const response = {
        data: {
          data: { ...freshTranslations()[0], translations: body.translations, source: "human" },
        },
      };
      return putCount === 1 ? firstResolved.then(() => response) : Promise.resolve(response);
    });

    render(<TranslationEditor />);

    // Edit Hindi in DEFAULT and blur → gated PUT for (hi, default).
    const hiDefault = await findHindiCell();
    await user.click(hiDefault);
    await user.type(hiDefault, "!");
    await user.tab();
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });

    // Switch to FORMAL while the default PUT is in flight, then edit the Hindi
    // FORMAL cell. The in-flight guard for (hi, default) must NOT block this
    // edit/save in (hi, formal) — different register, different key.
    await switchRegister(user, "Formal");
    const hiFormal = await findHindiCell();
    await user.click(hiFormal);
    await user.type(hiFormal, "?");      // edits the FORMAL-register Hindi cell

    // Formal cell is now dirty → indicator present even though the default save
    // hasn't resolved.
    await waitFor(() => {
      expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
    });

    // Blur the formal cell → a SECOND PUT must fire for (hi, formal). It is NOT
    // blocked by the still-in-flight default-register save (the bug would have
    // shared one `${id}:hi` in-flight key and dropped this save).
    await user.tab();
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(2);
    });
    const formalBody = put.mock.calls[1][1];
    expect(formalBody.editedRegister).toBe("formal");
    expect(formalBody.translations.hi.formal).toBe("सादर अभिवादन?");

    // Now release the gated default-register save. It completes for "default" —
    // independent of the formal cell. No third PUT (no spurious re-save), and
    // once both saves are done the indicator clears (no permanent dirty leak).
    releaseFirst();
    await new Promise((r) => setTimeout(r, 50));
    expect(put).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();
    });
  });
});
