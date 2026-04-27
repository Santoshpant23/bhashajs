/**
 * VerticalPack Model
 *
 * A curated translation pack for a regulated vertical. The defensibility
 * pillar: pre-loaded translation packs with the legal phraseology that
 * regulators (RBI, SEBI, IRDAI, Bangladesh Bank, SBP, etc.) effectively
 * mandate for fintech / insurance / health / gov UI.
 *
 * A generic i18n competitor cannot replicate this without lawyers on
 * staff per regulator per country.
 *
 * Items shape:
 *   items: [
 *     {
 *       key: "kyc.aadhaar.consent",
 *       context: "User consent screen for Aadhaar verification",
 *       mandatedBy: "RBI Master Directions on KYC, 2023",
 *       translations: {
 *         hi: { formal: "आधार सत्यापन के लिए मेरी सहमति है।" }
 *       }
 *     }
 *   ]
 *
 * Sample packs (the ones we seed at startup) are marked `official: false`
 * and named "starter" / "sample" — production use requires legal review by
 * the customer's compliance team.
 */

import mongoose, { Schema } from "mongoose";

const packItemSchema = new Schema(
  {
    key: { type: String, required: true },
    context: { type: String },
    mandatedBy: { type: String }, // citation, e.g. "RBI Master Directions on KYC, 2023"
    // lang → register → string
    translations: {
      type: Map,
      of: { type: Map, of: String },
      default: {},
    },
  },
  { _id: false }
);

const verticalPackSchema = new Schema({
  // Stable code used as a slug in URLs and import calls.
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String, default: "" },
  // High-level category — fintech, insurance, health, gov, ecommerce
  vertical: { type: String, required: true, index: true },
  // Specific regulator if any — RBI, SEBI, IRDAI, BB (Bangladesh Bank), SBP, FBR
  regulator: { type: String },
  // ISO country code where this pack applies — IN, BD, PK, NP, LK
  jurisdiction: { type: String },
  // Languages and registers this pack provides content for
  languages: { type: [String], default: [] },
  registers: { type: [String], default: ["default"] },
  items: { type: [packItemSchema], default: [] },
  // True for packs we ship and stand behind. False for community-contributed
  // or starter samples — UI flags these as "needs legal review".
  official: { type: Boolean, default: false },
  // True for the seed packs. We use this flag to detect & refresh sample
  // content on every boot without clobbering customer-edited copies.
  isSample: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const VerticalPack = mongoose.model("VerticalPack", verticalPackSchema);

export default VerticalPack;
