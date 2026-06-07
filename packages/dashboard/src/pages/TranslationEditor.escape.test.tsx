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
