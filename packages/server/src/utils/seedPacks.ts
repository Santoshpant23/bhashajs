/**
 * Seed: Sample Vertical Packs
 *
 * Idempotent — runs on every server start, refreshes the content of any pack
 * marked `isSample: true`. Customer-modified packs (isSample: false) are never
 * overwritten.
 *
 * The seeded packs are STARTER samples to make the import flow demonstrable.
 * Customers using these in production must run their own legal review — the
 * `description` field on every sample says so explicitly.
 */

import VerticalPack from "../models/VerticalPack";

interface SamplePackItem {
  key: string;
  context?: string;
  mandatedBy?: string;
  translations: Record<string, Record<string, string>>;
}

interface SamplePack {
  code: string;
  name: string;
  description: string;
  vertical: string;
  regulator?: string;
  jurisdiction?: string;
  languages: string[];
  registers: string[];
  items: SamplePackItem[];
}

const SAMPLE_PACKS: SamplePack[] = [
  {
    code: "fintech-kyc-starter-hi",
    name: "Fintech KYC Starter — Hindi (formal)",
    description:
      "Starter set of common KYC flow strings for Indian fintech apps, " +
      "translated into formal Hindi suitable for RBI-supervised entities. " +
      "This is starter content — not legal advice. Have your compliance team " +
      "review every string before deploying to a regulated production flow.",
    vertical: "fintech",
    regulator: "RBI",
    jurisdiction: "IN",
    languages: ["hi"],
    registers: ["formal"],
    items: [
      {
        key: "kyc.aadhaar.consent_title",
        context: "Heading on the screen where user consents to Aadhaar verification",
        mandatedBy: "RBI Master Directions on KYC, 2023 — Aadhaar consent",
        translations: {
          hi: { formal: "आधार सत्यापन हेतु सहमति" },
        },
      },
      {
        key: "kyc.aadhaar.consent_body",
        context: "Body text explaining what Aadhaar verification entails",
        mandatedBy: "RBI Master Directions on KYC, 2023",
        translations: {
          hi: {
            formal:
              "मैं अपनी पहचान सत्यापित करने के लिए आधार आधारित e-KYC के माध्यम से अपनी जनसांख्यिकीय जानकारी और तस्वीर साझा करने हेतु सहमति प्रदान करता/करती हूँ।",
          },
        },
      },
      {
        key: "kyc.pan.label",
        context: "Label for PAN (Permanent Account Number) input field",
        translations: {
          hi: { formal: "स्थायी खाता संख्या (PAN)" },
        },
      },
      {
        key: "kyc.pan.placeholder",
        context: "Placeholder text inside the PAN input",
        translations: {
          hi: { formal: "जैसे: ABCDE1234F" },
        },
      },
      {
        key: "kyc.otp.sent_message",
        context: "Confirmation that an OTP was sent to the user's registered mobile number",
        translations: {
          hi: { formal: "आपके पंजीकृत मोबाइल नंबर पर एक OTP भेज दिया गया है।" },
        },
      },
      {
        key: "kyc.otp.expired",
        context: "Error shown when an OTP entered by the user has expired",
        translations: {
          hi: { formal: "OTP की वैधता समाप्त हो चुकी है। कृपया पुनः प्रयास करें।" },
        },
      },
      {
        key: "kyc.bank_account.label",
        context: "Label for bank account number input",
        translations: {
          hi: { formal: "बैंक खाता संख्या" },
        },
      },
      {
        key: "kyc.ifsc.label",
        context: "Label for IFSC code input",
        translations: {
          hi: { formal: "IFSC कोड" },
        },
      },
      {
        key: "kyc.video_kyc.intro",
        context: "Intro shown before a video-KYC session begins",
        mandatedBy: "RBI V-CIP guidelines, 2020",
        translations: {
          hi: {
            formal:
              "आपकी पहचान सत्यापित करने के लिए हम एक वीडियो कॉल आरंभ करेंगे। कृपया सुनिश्चित करें कि आप एक शांत स्थान पर हैं और आपके पास आपका मूल पहचान दस्तावेज़ उपलब्ध है।",
          },
        },
      },
      {
        key: "kyc.terms.accept",
        context: "Label on the button the user clicks to accept terms & privacy policy",
        translations: {
          hi: { formal: "मैं नियम और शर्तें स्वीकार करता/करती हूँ" },
        },
      },
      {
        key: "kyc.declaration.fatca",
        context: "FATCA declaration shown to all customers (mandatory disclosure)",
        mandatedBy: "Income Tax Rules, 1962, Rule 114F-114H (FATCA / CRS)",
        translations: {
          hi: {
            formal:
              "मैं घोषणा करता/करती हूँ कि मैं भारत का कर निवासी हूँ और किसी अन्य देश का कर निवासी नहीं हूँ।",
          },
        },
      },
      {
        key: "kyc.success.title",
        context: "Title shown when KYC has been successfully submitted",
        translations: {
          hi: { formal: "KYC सफलतापूर्वक प्रस्तुत किया गया" },
        },
      },
      {
        key: "kyc.failed.title",
        context: "Title shown when KYC verification has failed",
        translations: {
          hi: { formal: "KYC सत्यापन विफल" },
        },
      },
    ],
  },
  {
    code: "fintech-kfs-starter-hi",
    name: "Digital Lending KFS Starter — Hindi (formal)",
    description:
      "Starter set of Key Facts Statement strings for Indian digital lending apps, " +
      "translated into formal Hindi for RBI-supervised lending flows. " +
      "This is starter content — not legal advice. Have your compliance team " +
      "review every string before deploying to a regulated production flow.",
    vertical: "fintech",
    regulator: "RBI",
    jurisdiction: "IN",
    languages: ["hi"],
    registers: ["formal"],
    items: [
      {
        key: "kfs.loan_amount",
        context: "KFS field showing the sanctioned loan amount",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "स्वीकृत ऋण राशि" },
        },
      },
      {
        key: "kfs.total_interest_charge",
        context: "KFS field showing total interest payable over the loan term",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "ऋण अवधि के दौरान देय कुल ब्याज राशि" },
        },
      },
      {
        key: "kfs.processing_other_fees",
        context: "KFS field listing processing fees and other upfront charges",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "प्रसंस्करण शुल्क और अन्य लागू शुल्क" },
        },
      },
      {
        key: "kfs.apr",
        context: "KFS field showing annual percentage rate",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "वार्षिक प्रतिशत दर (APR)" },
        },
      },
      {
        key: "kfs.total_repayment_amount",
        context: "KFS field showing principal, interest, and all charges payable",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "उधारकर्ता द्वारा देय कुल पुनर्भुगतान राशि" },
        },
      },
      {
        key: "kfs.repayment_schedule_frequency",
        context: "KFS field describing repayment schedule and frequency",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "पुनर्भुगतान अनुसूची और भुगतान की आवृत्ति" },
        },
      },
      {
        key: "kfs.penal_charges_disclosure",
        context: "Disclosure of penal charges for delayed or missed payment",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "विलंब या चूक की स्थिति में लागू दंडात्मक शुल्क का विवरण" },
        },
      },
      {
        key: "kfs.cooling_off_period",
        context: "Notice explaining the borrower's cooling-off or look-up period",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Cooling-off period",
        translations: {
          hi: { formal: "निर्धारित कूलिंग-ऑफ अवधि में आप बिना दंड के ऋण समाप्त कर सकते/सकती हैं।" },
        },
      },
      {
        key: "kfs.recovery_agent_policy",
        context: "Disclosure about recovery agent assignment and conduct policy",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Recovery practices",
        translations: {
          hi: { formal: "वसूली एजेंट की नियुक्ति और आचरण नीति का विवरण" },
        },
      },
      {
        key: "kfs.grievance_officer_contact",
        context: "KFS field for grievance redressal officer contact details",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Grievance redressal",
        translations: {
          hi: { formal: "शिकायत निवारण अधिकारी का नाम और संपर्क विवरण" },
        },
      },
      {
        key: "kfs.lsp_lender_disclosure",
        context: "Disclosure naming the lender and lending service provider",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - LSP/lender disclosure",
        translations: {
          hi: { formal: "ऋणदाता और ऋण सेवा प्रदाता (LSP) का नाम" },
        },
      },
      {
        key: "kfs.prepayment_terms",
        context: "KFS field describing foreclosure or prepayment terms",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "पूर्व भुगतान या ऋण बंद करने की शर्तें" },
        },
      },
      {
        key: "kfs.emi_amount",
        context: "KFS field showing the equated monthly installment amount",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "समान मासिक किस्त (EMI) की राशि" },
        },
      },
      {
        key: "kfs.contingency_charges",
        context: "KFS field listing contingent charges that may apply later",
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
        translations: {
          hi: { formal: "भविष्य में लागू हो सकने वाले आकस्मिक शुल्क" },
        },
      },
    ],
  },
];

export async function seedVerticalPacks(): Promise<void> {
  let upserts = 0;
  for (const pack of SAMPLE_PACKS) {
    // Refresh: replace the sample's content but keep its _id stable so any
    // imports that already happened still trace back to a valid pack.
    const existing = await VerticalPack.findOne({ code: pack.code, isSample: true });
    if (existing) {
      existing.set({ ...pack, isSample: true, official: false, updatedAt: new Date() });
      await existing.save();
    } else {
      // Don't overwrite a non-sample pack with the same code (e.g. a customer
      // who customized a pack and removed the isSample flag).
      const taken = await VerticalPack.findOne({ code: pack.code });
      if (taken) continue;
      await VerticalPack.create({
        ...pack,
        isSample: true,
        official: false,
      });
    }
    upserts++;
  }
  if (upserts > 0) {
    console.log(`[Migration] Refreshed ${upserts} sample vertical pack(s)`);
  }
}
