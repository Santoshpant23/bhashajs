/**
 * Compliance Audit Routes
 *
 * GET /api/projects/:projectId/compliance/audit   — Full auditable trail for
 *     every regulated key in the project (owner-only). JSON by default;
 *     `?format=csv` returns a flat CSV (one row per history event) with an
 *     attachment Content-Disposition header.
 * GET /api/projects/:projectId/compliance/summary — Roll-up counts of regulated
 *     keys (total / fully-approved / with-pending) for a dashboard banner.
 *
 * This is the sellable artifact of the compliance lock (see utils/compliance.ts
 * and the moat strategy): a regulated-fintech buyer can prove, per key, who
 * approved which copy, when, and against which regulator citation.
 *
 * Both routes are owner-only — the audit trail names individual approvers and
 * is the evidence a buyer hands to their regulator, so it stays scoped to the
 * project owner rather than every member.
 *
 * All routes are protected by authMiddleware + requireProjectRole("owner").
 */

import { Router, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireProjectRole, ProjectAuthRequest } from "../middleware/projectAuth";
import Translation from "../models/Translation";
import TranslationHistory from "../models/TranslationHistory";
import Project from "../models/Project";
import User from "../models/User";
import { sendSuccess, sendError } from "../utils/response";
import { validateObjectId } from "../utils/validate";
import { iterateCells, DEFAULT_REGISTER, Register } from "../utils/registers";

// mergeParams so :projectId from the mount path is visible here.
const router = Router({ mergeParams: true });
router.use(authMiddleware);

// Per-(lang, register) compliance status, read straight off the sources map.
// "approved" = AI draft a human owner reviewed; "human" = human-authored;
// "ai" = unreviewed AI draft; "pending" = a non-owner's edit held for approval.
// Anything else (incl. a missing source) is reported as "pending" so an
// unaccounted-for cell never reads as cleared.
type CellStatus = "approved" | "human" | "ai" | "pending";

function normalizeStatus(source: string | undefined): CellStatus {
  if (source === "approved" || source === "human" || source === "ai") return source;
  return "pending";
}

// A regulated cell is "cleared" for compliance when its copy is something the
// SDK will actually serve — human-authored or human-approved (mirrors
// canServe() in utils/compliance.ts). "ai" and "pending" are NOT cleared.
function isCleared(status: CellStatus): boolean {
  return status === "human" || status === "approved";
}

// Compliance has TWO distinct states (conflating them is what the audits kept
// catching):
//   reviewClean — every (lang, register) cell that EXISTS is cleared (human/
//     approved), and at least one cell exists. This is exactly the SDK's serving
//     guarantee: no regulated cell serves unreviewed copy. A formal-only pack
//     key (e.g. hi/formal approved) is review-clean — NOT "stuck in review".
//   complete — every SUPPORTED language has a cleared cell in the default
//     register. This is translation completeness/coverage. An English-only key
//     in an en/hi/bn project is review-clean but NOT complete.
// "fullyApproved" is the strict headline: reviewClean AND complete.
function complianceState(
  sourcesMap: unknown,
  supportedLanguages: string[]
): { reviewClean: boolean; complete: boolean; missingLanguages: string[]; fullyApproved: boolean } {
  let anyCell = false;
  let reviewClean = true;
  const clearedDefaultLangs = new Set<string>();
  for (const { lang, register, value } of iterateCells(sourcesMap as any)) {
    anyCell = true;
    const status = normalizeStatus(value);
    if (!isCleared(status)) reviewClean = false;
    if (register === DEFAULT_REGISTER && isCleared(status)) clearedDefaultLangs.add(lang);
  }
  reviewClean = anyCell && reviewClean;

  const supported = supportedLanguages || [];
  const missingLanguages = supported.filter((l) => !clearedDefaultLangs.has(l));
  const complete = supported.length > 0 && missingLanguages.length === 0;

  return { reviewClean, complete, missingLanguages, fullyApproved: reviewClean && complete };
}

// Escape one CSV field per RFC 4180: wrap in double quotes if it contains a
// comma, quote, or newline, and double any embedded quotes. A leading
// =/+/-/@ (and tab/CR, per OWASP) is prefixed with a single quote to defuse
// spreadsheet formula injection (a `mandatedBy` citation or value is
// attacker-influenced text).
function csvField(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ─── COMPLIANCE AUDIT (per-key trail) ───────────────────────
// For every regulated:true key in the project, return its citation, the
// current per-(lang, register) approval status, and the full history (each
// event with the approver resolved to { name, email }), newest-first.
router.get(
  "/audit",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { format } = req.query;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const project = await Project.findById(projectId)
        .select("supportedLanguages")
        .lean<{ supportedLanguages: string[] }>();
      const supportedLanguages = project?.supportedLanguages || [];

      // Include EVER-regulated keys, not just currently-regulated ones: an owner
      // can unlock a key (regulated → false), but the compliance evidence must
      // NOT vanish from the audit. `everRegulated` is an append-only marker.
      const translations = await Translation.find({
        projectId,
        $or: [{ regulated: true }, { everRegulated: true }],
      }).sort({ key: 1 });

      const liveIds = new Set(translations.map((t) => String(t._id)));

      // Pull ALL of the project's history (newest-first) — we need it both to
      // bucket history for the live keys AND to reconstruct DELETED ever-regulated
      // keys, whose Translation doc is gone but whose history tombstone survives
      // (a "deleted" key delete retains its history; see translations.ts DELETE).
      const historyDocs = await TranslationHistory.find({ projectId }).sort({
        createdAt: -1,
      });

      // Batched approver resolution: collect every distinct changedBy id across
      // ALL history events, resolve them in a single User.find, then look up by
      // id. This is the no-N+1 requirement — one query regardless of key count.
      const approverIds = Array.from(
        new Set(historyDocs.map((h) => String(h.changedBy)).filter(Boolean))
      );
      const approvers = approverIds.length
        ? await User.find({ _id: { $in: approverIds } })
            .select("name email")
            .lean<{ _id: any; name: string; email: string }[]>()
        : [];
      const approverById = new Map(
        approvers.map((u) => [String(u._id), { name: u.name, email: u.email }])
      );
      const resolveApprover = (id: any) =>
        approverById.get(String(id)) || { name: "Unknown", email: "" };

      // Bucket history by translationId (already sorted newest-first globally,
      // which preserves newest-first within each bucket).
      const historyByTranslation = new Map<string, typeof historyDocs>();
      for (const h of historyDocs) {
        const k = String(h.translationId);
        if (!historyByTranslation.has(k)) historyByTranslation.set(k, []);
        historyByTranslation.get(k)!.push(h);
      }

      const keys = translations.map((t) => {
        // Current per-(lang, register) status from the sources map.
        const statuses: {
          lang: string;
          register: Register;
          status: CellStatus;
        }[] = [];
        for (const { lang, register, value } of iterateCells(t.sources as any)) {
          statuses.push({ lang, register, status: normalizeStatus(value) });
        }

        const history = (historyByTranslation.get(String(t._id)) || []).map((h) => ({
          lang: h.lang,
          register: (h.register || DEFAULT_REGISTER) as Register,
          oldValue: h.oldValue || "",
          newValue: h.newValue || "",
          source: h.source || "",
          changedBy: resolveApprover(h.changedBy),
          createdAt: h.createdAt,
        }));

        return {
          key: t.key,
          mandatedBy: (t as any).mandatedBy || "",
          ...complianceState(t.sources, supportedLanguages),
          deleted: false,
          statuses,
          history,
        };
      }) as any[];

      // Reconstruct DELETED ever-regulated keys from their retained history
      // tombstones: a history bucket with no live Translation but a regulated-era
      // marker ("locked"/"deleted") in its trail. So unlocking-then-deleting a
      // regulated key can't hide it from the audit.
      for (const [tid, hist] of historyByTranslation) {
        if (liveIds.has(tid)) continue;
        if (!hist.some((h) => h.source === "locked" || h.source === "deleted")) continue;
        keys.push({
          key: hist[0]?.key || "(deleted key)",
          mandatedBy: "",
          reviewClean: false,
          complete: false,
          missingLanguages: [] as string[],
          fullyApproved: false,
          deleted: true,
          statuses: [],
          history: hist.map((h) => ({
            lang: h.lang,
            register: (h.register || DEFAULT_REGISTER) as Register,
            oldValue: h.oldValue || "",
            newValue: h.newValue || "",
            source: h.source || "",
            changedBy: resolveApprover(h.changedBy),
            createdAt: h.createdAt,
          })),
        });
      }
      keys.sort((a, b) => String(a.key).localeCompare(String(b.key)));

      // ─── CSV export ───────────────────────────────────────────
      // Every regulated KEY appears (with its current review/complete state),
      // followed by its history events. A key with NO history (e.g. a
      // pack-imported one) still gets a state row, so it can't vanish from the
      // audit. Keys A→Z, events newest-first within each key.
      if (typeof format === "string" && format.toLowerCase() === "csv") {
        const header = [
          "key",
          "citation",
          "reviewClean",
          "complete",
          "missingLanguages",
          "deleted",
          "lang",
          "register",
          "oldValue",
          "newValue",
          "source",
          "approverName",
          "approverEmail",
          "timestamp",
        ];
        const rows: string[] = [header.map(csvField).join(",")];
        for (const k of keys) {
          const stateCols = [
            k.key,
            k.mandatedBy,
            String(k.reviewClean),
            String(k.complete),
            k.missingLanguages.join(" "),
            String(k.deleted),
          ];
          if (k.history.length === 0) {
            // No audit events yet — still record the key + its current state.
            rows.push([...stateCols, "", "", "", "", "", "", "", ""].map(csvField).join(","));
            continue;
          }
          for (const e of k.history) {
            rows.push(
              [
                ...stateCols,
                e.lang,
                e.register,
                e.oldValue,
                e.newValue,
                e.source,
                e.changedBy.name,
                e.changedBy.email,
                e.createdAt instanceof Date
                  ? e.createdAt.toISOString()
                  : new Date(e.createdAt).toISOString(),
              ]
                .map(csvField)
                .join(",")
            );
          }
        }
        // CRLF line endings per RFC 4180 (Excel-friendly).
        const csv = rows.join("\r\n") + "\r\n";
        const filename = `compliance-audit-${projectId}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.status(200).send(csv);
      }

      return sendSuccess(res, 200, {
        projectId,
        generatedAt: new Date().toISOString(),
        totalRegulatedKeys: keys.length,
        keys,
      });
    } catch (e) {
      return sendError(res, 500, "Failed to build compliance audit");
    }
  }
);

// ─── COMPLIANCE SUMMARY (roll-up counts) ────────────────────
// Lightweight counts for the dashboard banner: how many regulated keys exist,
// how many are fully cleared, and how many still have a not-yet-cleared cell.
router.get(
  "/summary",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const project = await Project.findById(projectId)
        .select("supportedLanguages")
        .lean<{ supportedLanguages: string[] }>();
      const supportedLanguages = project?.supportedLanguages || [];

      // Ever-regulated keys count too (an unlocked key still needs its evidence
      // surfaced) — consistent with the /audit export.
      const translations = await Translation.find({
        projectId,
        $or: [{ regulated: true }, { everRegulated: true }],
      });

      let reviewClean = 0;
      let complete = 0;
      let fullyApproved = 0;
      let withUnreviewed = 0;
      for (const t of translations) {
        const s = complianceState(t.sources, supportedLanguages);
        if (s.reviewClean) reviewClean++;
        else withUnreviewed++;
        if (s.complete) complete++;
        if (s.fullyApproved) fullyApproved++;
      }

      return sendSuccess(res, 200, {
        total: translations.length,
        reviewClean, // no unreviewed copy serves (the lock guarantee)
        complete, // every supported language approved (coverage)
        fullyApproved, // reviewClean AND complete
        withUnreviewed, // has an ai/pending cell (or none)
      });
    } catch (e) {
      return sendError(res, 500, "Failed to build compliance summary");
    }
  }
);

export default router;
