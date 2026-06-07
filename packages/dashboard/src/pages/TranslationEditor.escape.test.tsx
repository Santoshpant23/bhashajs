/**
 * Editor keyboard/save regression tests.
 *
 * These cover the two save-safety guarantees that previously had ZERO
 * coverage (the "no editor keyboard/save tests" gap):
 *
 *   (a) Escape on an edited cell CANCELS — it must not fire a PUT that
 *       persists the cancelled value. This was the high-concern bug: the
 *       Escape revert is queued (async), then the cell blurs synchronously,
 *       and the blur's save closure still saw the edited value and saved it.
 *   (b) Blur with an UNCHANGED value must not save — a no-op blur must never
 *       fire a PUT (which would re-stamp provenance, e.g. flip an unreviewed
 *       AI cell to "human").
 *   (c) Ctrl+S on an unchanged cell must not save either (same provenance
 *       concern via a different path).
 *
 * Strategy: render the REAL TranslationEditor with the `api` axios instance
 * mocked, so we can assert on api.put calls directly. GET is stubbed per
 * endpoint to load one editable key for an owner.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock the axios instance. GET resolves per-endpoint; PUT/POST are spies we
// assert were (not) called. getErrorMessage is passed through unchanged.
// vi.hoisted lets the spies exist before the hoisted vi.mock factory runs.
const { get, put, post } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
}));
vi.mock("../utils/api", () => ({
  default: { get, put, post },
  getErrorMessage: (e: any) => e?.response?.data?.message || "Something went wrong",
}));

// useNotifications throws outside its provider; stub it for an isolated render.
vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({
    unreadCount: 0,
    notifications: [],
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// Router hooks the editor reads on mount.
vi.mock("react-router-dom", () => ({
  useParams: () => ({ projectId: "p1" }),
  useNavigate: () => vi.fn(),
  Link: ({ children, ...rest }: any) => <a {...rest}>{children}</a>,
}));

import TranslationEditor from "./TranslationEditor";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PROJECT = {
  _id: "p1",
  name: "Demo",
  supportedLanguages: ["en", "hi"],
  defaultLanguage: "en",
  myRole: "owner",
};

// One key, with a known English value so we can find its cell by value.
const ORIGINAL_EN = "Hello";
function freshTranslations() {
  return [
    {
      _id: "t1",
      key: "greeting",
      translations: { en: { default: ORIGINAL_EN }, hi: { default: "" } },
      source: "human",
      sources: { en: { default: "human" }, hi: {} },
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

// Find the English cell input (row 0, col 0) once the table has loaded.
async function findEnCell(): Promise<HTMLInputElement> {
  return (await screen.findByDisplayValue(ORIGINAL_EN)) as HTMLInputElement;
}

// Find a cell by its grid position once the table has rendered. Col 0 = en,
// col 1 = hi for the PROJECT fixture below. Does NOT key off a cell's value
// (values change as we edit), so it stays valid after edits.
async function findCell(col: number): Promise<HTMLInputElement> {
  return (await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      `input[data-row="0"][data-col="${col}"]`
    );
    if (!el) throw new Error(`cell col ${col} not found`);
    return el;
  }));
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  post.mockReset();
  wireGets();
  // A successful PUT (should it ever fire) returns a saved doc.
  put.mockResolvedValue({
    data: { data: { ...freshTranslations()[0], source: "human" } },
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("TranslationEditor — Escape cancels an edit", () => {
  it("does NOT save (no PUT) when Escape is pressed on an edited cell", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    const cell = await findEnCell();
    await user.click(cell);            // focus → captures baseline
    await user.type(cell, " world");   // edit
    expect(cell.value).toBe("Hello world");

    // Escape should revert AND cancel — the blur it triggers must not save.
    await user.keyboard("{Escape}");

    // Give any queued blur-save microtask a chance to (wrongly) fire.
    await waitFor(() => {
      expect(put).not.toHaveBeenCalled();
    });
    // Value reverted to the baseline.
    expect(cell.value).toBe(ORIGINAL_EN);
  });

  it("does NOT save the cancelled value even after the cell blurs", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    const cell = await findEnCell();
    await user.click(cell);
    await user.type(cell, "EDITED");
    await user.keyboard("{Escape}"); // sets skip flag + blurs

    // Explicitly move focus elsewhere to force another real blur event.
    await user.click(document.body);

    await waitFor(() => {
      expect(put).not.toHaveBeenCalled();
    });
  });
});

describe("TranslationEditor — unchanged value does not save", () => {
  it("does NOT fire a PUT on blur when the value is unchanged", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    const cell = await findEnCell();
    await user.click(cell);  // focus, no edit
    await user.tab();        // blur

    await waitFor(() => {
      expect(put).not.toHaveBeenCalled();
    });
  });

  it("does NOT fire a PUT on Ctrl+S when the value is unchanged", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    const cell = await findEnCell();
    await user.click(cell);
    await user.keyboard("{Control>}s{/Control}");

    await waitFor(() => {
      expect(put).not.toHaveBeenCalled();
    });
  });
});

describe("TranslationEditor — a real edit still saves", () => {
  it("fires exactly one PUT on blur after an actual change (guard does not over-block)", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    const cell = await findEnCell();
    await user.click(cell);
    await user.type(cell, "!");   // genuine edit → "Hello!"
    await user.tab();             // blur → should save

    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    const [url, body] = put.mock.calls[0];
    expect(url).toBe("/translations/t1");
    expect(body.editedLang).toBe("en");
  });
});

describe("TranslationEditor — Ctrl+S then blur fires exactly ONE PUT", () => {
  it("does not double-save the same cell when Ctrl+S is immediately followed by blur", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    const cell = await findEnCell();
    await user.click(cell);          // focus → captures baseline "Hello"
    await user.type(cell, "!");      // genuine edit → "Hello!"

    // Ctrl+S kicks off a save. The PUT is in flight (mock resolves async).
    await user.keyboard("{Control>}s{/Control}");
    // Blur immediately after — BEFORE the first PUT resolves. Previously the
    // change-guard's baseline was only refreshed after the response, so this
    // blur saw value≠baseline and saved AGAIN. With the optimistic baseline
    // refresh + in-flight guard, this second save is skipped.
    await user.tab();

    // Let every queued microtask/save settle, then assert exactly one PUT.
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    // And give a stray second PUT a chance to (wrongly) appear.
    await new Promise((r) => setTimeout(r, 50));
    expect(put).toHaveBeenCalledTimes(1);

    const [url, body] = put.mock.calls[0];
    expect(url).toBe("/translations/t1");
    expect(body.editedLang).toBe("en");
  });

  it("a no-op double-save (save, then save again with no new edit) issues only ONE PUT", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    const cell = await findEnCell();
    await user.click(cell);
    await user.type(cell, "!");      // genuine edit → "Hello!"

    // First Ctrl+S saves and (once resolved) re-baselines to "Hello!".
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });

    // A SECOND Ctrl+S with no new edit is a no-op — the baseline already equals
    // the current value, so the change-guard short-circuits before any PUT.
    await user.keyboard("{Control>}s{/Control}");
    await new Promise((r) => setTimeout(r, 50));
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("a GENUINE new edit after a save still saves (guard releases per cell)", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    const cell = await findEnCell();
    await user.click(cell);
    await user.type(cell, "!");      // "Hello!"
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });

    // Type more, then blur. The in-flight guard has released and the baseline
    // is now "Hello!", so this distinct value must save (no over-blocking).
    await user.type(cell, "?");      // "Hello!?"
    await user.tab();

    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(2);
    });
    // Second PUT carries the newer English value.
    const secondBody = put.mock.calls[1][1];
    expect(secondBody.translations.en.default).toBe("Hello!?");
  });
});

// ─── Per-cell dirty tracking (cross-cell data-loss fix) ──────────────────────
//
// The blocker: a SINGLE global `hasUnsaved` boolean meant that when one cell
// finished saving it cleared the flag even though ANOTHER cell was still dirty,
// so the leave/unload guard didn't warn and the other edit was lost. Dirty
// state must be tracked PER CELL; saving cell A must never clear cell B.
describe("TranslationEditor — per-cell dirty tracking", () => {
  it("keeps the unsaved indicator while another cell is still dirty after one cell saves", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    // Edit English (col 0) and let its save settle.
    const en = await findCell(0);
    await user.click(en);
    await user.type(en, "!");          // "Hello!"
    await user.tab();                  // blur → saves English
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });

    // Now edit Hindi (col 1) — it becomes dirty but is NOT saved yet.
    const hi = await findCell(1);
    await user.click(hi);
    await user.type(hi, "नमस्ते");

    // English's save already resolved and (with the OLD global-flag bug) would
    // have cleared `hasUnsaved`. With per-cell tracking, Hindi is still dirty,
    // so the unsaved indicator MUST be present.
    await waitFor(() => {
      expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
    });
  });

  it("clears the unsaved indicator only once the LAST dirty cell is saved", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    // Save English first — one PUT, then English is clean.
    const en = await findCell(0);
    await user.click(en);
    await user.type(en, "!");          // "Hello!"
    await user.tab();                  // blur → saves English
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    // English clean, nothing else dirty → indicator gone.
    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();
    });

    // Now dirty Hindi (the LAST cell) — indicator returns.
    const hi = await findCell(1);
    await user.click(hi);
    await user.type(hi, "नमस्ते");
    await waitFor(() => {
      expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
    });

    // Save Hindi — the last dirty cell. Now the indicator clears.
    await user.tab();                  // blur → saves Hindi (value changed)
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();
    });
  });
});

// ─── Autosave-on-completion (edits during an in-flight save) ─────────────────
//
// The in-flight guard drops a blur-save for a cell that already has a PUT in
// flight. The newer edit stays dirty; without autosave-on-completion it would
// need a manual second save. Fix: when the in-flight save completes and detects
// the cell changed since the save started, it AUTO RE-SAVES the newer value —
// a second PUT with the newer content fires without the user saving again.
describe("TranslationEditor — autosave on in-flight completion", () => {
  it("persists an edit typed while a save is in flight (second PUT with the newer value, no manual save)", async () => {
    const user = userEvent.setup();
    render(<TranslationEditor />);

    // Gate the FIRST PUT so it stays in flight until we release it. This lets
    // us type a newer value into the same cell during the in-flight window.
    let releaseFirst!: () => void;
    const firstResolved = new Promise<void>((r) => (releaseFirst = r));
    let putCount = 0;
    put.mockImplementation((url: string, body: any) => {
      putCount += 1;
      const savedDoc = {
        ...freshTranslations()[0],
        translations: body.translations,
        source: "human",
      };
      const response = { data: { data: savedDoc } };
      if (putCount === 1) {
        // Hold the first PUT open until releaseFirst() is called.
        return firstResolved.then(() => response);
      }
      return Promise.resolve(response);
    });

    const cell = await findEnCell();
    await user.click(cell);            // baseline "Hello"
    await user.type(cell, "!");        // "Hello!"

    // Ctrl+S starts the FIRST PUT; it is now in flight (gated).
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });

    // Type MORE while the first PUT is still in flight. A blur here is dropped
    // by the in-flight guard — the edit stays dirty and must be auto re-saved.
    await user.type(cell, "?");        // "Hello!?"
    await user.tab();                  // blur → dropped (in-flight), still dirty

    // Only one PUT so far (the gated one). The newer edit has NOT been saved yet.
    expect(put).toHaveBeenCalledTimes(1);

    // Release the first PUT. On completion the save detects the cell changed
    // since it started and AUTO RE-SAVES the newer value — a second PUT fires.
    releaseFirst();

    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(2);
    });
    // The second (auto) PUT carries the newer value — no manual save needed.
    const secondBody = put.mock.calls[1][1];
    expect(secondBody.translations.en.default).toBe("Hello!?");

    // And it settles: no THIRD PUT (loop guard — re-save is a no-op once the
    // value stops changing).
    await new Promise((r) => setTimeout(r, 50));
    expect(put).toHaveBeenCalledTimes(2);

    // Once the newer value is persisted, the cell is clean → indicator gone.
    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-indicator")).not.toBeInTheDocument();
    });
  });
});
