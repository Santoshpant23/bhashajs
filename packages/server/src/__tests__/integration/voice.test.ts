/**
 * Integration — voice persistence (Phase 3), no AI.
 *
 * Exercises the exact orphan bug: writeVoiceCell must mutate the LIVE Mongoose
 * cast Map (re-fetched after map.set), not a detached JS Map, so the nested
 * voice[lang][register] cell actually survives a save + re-fetch round-trip.
 *
 * This is a focused model+helper test — it talks to the real DB (provided by
 * the integration harness) but never calls Gemini/Vertex.
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import Translation from "../../models/Translation";
import { writeVoiceCell } from "../../utils/registers";
import { useIntegrationServer } from "./setup";

describe("voice persistence (writeVoiceCell)", () => {
  useIntegrationServer();

  it("persists voice[lang][register] across save + re-fetch", async () => {
    const projectId = new mongoose.Types.ObjectId();

    const doc = await Translation.create({
      projectId,
      key: "hero.title",
      translations: { hi: { default: "स्वागत" } },
      sources: { hi: { default: "human" } },
    });

    const ipa = "sʋaːɡət";
    const ssml = "<speak>स्वागत</speak>";
    writeVoiceCell(doc as any, "hi", "default", { ipa, ssml });
    await doc.save();

    // Re-fetch a FRESH document from the DB — if the inner write had landed on a
    // detached Map, this would come back empty.
    const fetched = await Translation.findById(doc._id);
    expect(fetched).not.toBeNull();

    const voice = fetched!.voice as any;
    const langMap = voice instanceof Map ? voice.get("hi") : voice?.hi;
    const cell = langMap instanceof Map ? langMap.get("default") : langMap?.default;

    expect(cell).toBeTruthy();
    expect(cell.ipa).toBe(ipa);
    expect(cell.ssml).toBe(ssml);
  });
});
