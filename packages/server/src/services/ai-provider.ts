/**
 * AI Translation Provider
 *
 * Abstraction layer for AI-powered translations.
 * Currently uses Google Gemini, but designed so you can swap
 * to Claude, OpenAI, or any other provider by:
 *   1. Adding a new class that implements AITranslationProvider
 *   2. Adding a case in getAIProvider()
 *
 * The provider takes English UI strings + optional context,
 * and returns translations in the target language at the requested register.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Register } from "../models/Translation";

// ─── Interface ──────────────────────────────────────────────────

export interface TranslationInput {
  key: string;
  text: string;
  context?: string;
}

export interface MemoryExample {
  sourceText: string;
  translatedText: string;
}

export interface GlossaryTerm {
  term: string;
  translation: string;
}

export interface VoiceInput {
  key: string;
  text: string;
}

export interface VoiceOutput {
  ipa: string;
  ssml: string;
}

export interface AITranslationProvider {
  /**
   * Translate an array of English UI strings to a target language at a specific register.
   * Optionally accepts translation memory examples and glossary terms for consistency.
   * Returns a map of { key: translatedText }.
   */
  translate(
    texts: TranslationInput[],
    targetLang: string,
    targetLangName: string,
    memory?: MemoryExample[],
    glossary?: GlossaryTerm[],
    register?: Register,
    vertical?: string | null
  ): Promise<Record<string, string>>;

  /**
   * Generate voice-ready outputs (IPA phonetic transcription + SSML markup)
   * for translated UI strings. Used to stitch the screen layer to the voice
   * layer so a customer's TTS pipeline can reuse the same i18n keys.
   *
   * Returns a map of { key: { ipa, ssml } }.
   */
  generateVoice(
    inputs: VoiceInput[],
    lang: string,
    langName: string,
    register?: Register
  ): Promise<Record<string, VoiceOutput>>;
}

// ─── Vertical-specific prompt addenda ──────────────────────────
//
// When a project tags itself with a vertical (e.g. "fintech"), we splice a
// short domain note into the prompt. This isn't a substitute for legal
// review — the regulator-pinned vertical packs do the heavy lifting — but
// it nudges the model toward the correct register of jargon.

const VERTICAL_GUIDE: Record<string, string> = {
  fintech:
    "Domain: Indian fintech / banking. Use formal banking terminology where " +
    "applicable (KYC, OTP, IFSC, UPI, FATCA). Match the formality of RBI-supervised " +
    "consumer apps. When translating money-related terms, prefer the Indian " +
    "lakh/crore convention over the Western million/billion.",
  insurance:
    "Domain: Indian insurance (IRDAI-regulated). Use formal insurance terminology " +
    "(policy holder, sum assured, premium, beneficiary, nominee, claim, settlement, " +
    "endorsement, surrender, lapse). Tone is institutional and trust-building.",
  health:
    "Domain: Indian healthcare / pharma. Be explicit about consent and data use. " +
    "Prefer plain-language patient-friendly phrasing over medical jargon when both work.",
  ecommerce:
    "Domain: South Asian consumer e-commerce. Tone is friendly and conversion-oriented. " +
    "Use familiar shopping vocabulary (cart, order, delivery, payment, refund, return). " +
    "When the register is 'casual', code-mixing with English is expected and natural.",
  gov:
    "Domain: government / public-sector UI. Use formal, neutral language. Avoid " +
    "colloquialisms. Defer to official Sanskritized vocabulary in Hindi over " +
    "Persian-derived alternatives.",
  edtech:
    "Domain: South Asian education tech. Audience is students and parents. Use " +
    "encouraging, clear language. Where the register is 'casual', match the way " +
    "students text — code-mixing is fine.",
};

// ─── Register style guides ──────────────────────────────────────
//
// These are the actual instructions handed to the model. The "casual"
// guide explicitly invites code-mixing because that's how Gen-Z South
// Asians type — and the moat depends on us treating that as correct,
// not as "wrong" Hindi/Nepali/Urdu.

const REGISTER_STYLE_GUIDE: Record<Register, string> = {
  default: `Use a neutral, conversational tone appropriate for general-purpose UI strings.
Prefer clarity over formality. Stick to the native script of the target language.`,

  formal: `Use a highly formal, respectful register suitable for legal, banking, government,
or insurance UIs. Use honorific pronouns (आप / آپ / আপনি / தாங்கள் etc.) and verb forms.
Prefer native-language vocabulary; avoid English loanwords unless the technical term has no
established native equivalent. Sound trustworthy and institutional.`,

  casual: `Use a conversational, Gen-Z friendly tone — write like a friend, not a bureaucrat.
Code-mixing with English is encouraged when it sounds more natural to a young urban user
(e.g. "Order करें" instead of "आदेश दें", "Cart में add करो" instead of "टोकरी में जोड़ें").
Use casual pronouns (तू/तुम / تم / তুমি / நீ etc.) where appropriate. Borrow common English
nouns/verbs that are already in everyday spoken use. Keep the script of the target language
but treat English loanwords as first-class citizens.`,
};

// ─── Gemini Provider ────────────────────────────────────────────

class GeminiProvider implements AITranslationProvider {
  private model;

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  }

  async translate(
    texts: TranslationInput[],
    targetLang: string,
    targetLangName: string,
    memory?: MemoryExample[],
    glossary?: GlossaryTerm[],
    register: Register = "default",
    vertical?: string | null
  ): Promise<Record<string, string>> {
    if (texts.length === 0) return {};

    // Build a structured list of strings to translate
    const items = texts.map((t) => {
      let entry = `"${t.key}": "${t.text}"`;
      if (t.context) {
        entry += ` (context: ${t.context})`;
      }
      return entry;
    });

    // Build glossary section if available
    let glossarySection = "";
    if (glossary && glossary.length > 0) {
      const terms = glossary.map((g) => `  "${g.term}" → "${g.translation}"`);
      glossarySection = `
GLOSSARY — always use these exact translations for these terms:
${terms.join("\n")}

`;
    }

    // Build translation memory section if available
    let memorySection = "";
    if (memory && memory.length > 0) {
      const examples = memory.slice(0, 20).map(
        (m) => `  "${m.sourceText}" → "${m.translatedText}"`
      );
      memorySection = `
TRANSLATION MEMORY — use these human-verified translations as a style/terminology guide:
${examples.join("\n")}

Follow the same tone, formality level, and terminology choices shown above.
`;
    }

    const styleGuide = REGISTER_STYLE_GUIDE[register] || REGISTER_STYLE_GUIDE.default;
    const verticalGuide = vertical && VERTICAL_GUIDE[vertical] ? VERTICAL_GUIDE[vertical] : "";
    const verticalSection = verticalGuide ? `\nDOMAIN GUIDE:\n${verticalGuide}\n` : "";

    // Latin-script variants get an explicit Romanization rule. Without this,
    // Gemini happily "helps" by producing Devanagari/Bengali/etc. — defeating
    // the entire point of code-mixed locales.
    const isLatinScript = targetLang.endsWith("-Latn");
    const scriptInstruction = isLatinScript
      ? `\nSCRIPT REQUIREMENT (CRITICAL):
- Output MUST be in the Latin alphabet (a–z, A–Z) only.
- Do NOT use Devanagari, Bengali, Gurmukhi, Arabic, or any non-Latin script.
- Romanize using common informal conventions Gen-Z South Asians actually type
  (e.g. "kar do" not "kara do", "kaisa hai" not "kaisaa haiy"). Match how
  people text on WhatsApp, not academic IAST/ISO 15919 transliteration.
- For "casual" register specifically, freely mix English words where they
  flow naturally — that's the whole point of Hinglish/Banglish/Roman Urdu.\n`
      : "";

    const prompt = `You are a professional UI translator specializing in South Asian languages.

Translate the following UI strings from English to ${targetLangName} (${targetLang}) at the "${register}" register.

REGISTER GUIDE for "${register}":
${styleGuide}
${scriptInstruction}${verticalSection}
GENERAL RULES:
- These are UI strings for a website/app — keep translations concise and natural
- Preserve any {placeholder} variables exactly as-is (e.g. {name}, {count})
- Do NOT translate placeholder variables
- Use the context hints (if provided) to choose the right meaning
- Return ONLY valid JSON — no markdown, no code blocks, no explanation
- The JSON should be an object mapping each key to its translated string
${glossarySection}${memorySection}
STRINGS TO TRANSLATE:
${items.join("\n")}

Return JSON in this exact format:
{
  "key1": "translated text",
  "key2": "translated text"
}`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = result.response.text();

      // Extract JSON from the response (handle markdown code blocks)
      const jsonStr = response
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      const parsed = JSON.parse(jsonStr);

      // Validate: ensure all keys are present and values are strings
      const output: Record<string, string> = {};
      for (const t of texts) {
        if (parsed[t.key] && typeof parsed[t.key] === "string") {
          output[t.key] = parsed[t.key];
        }
      }

      return output;
    } catch (error: any) {
      console.error("[BhashaJS AI] Gemini translation failed:", error.message);
      throw new Error(`AI translation failed: ${error.message}`);
    }
  }

  async generateVoice(
    inputs: VoiceInput[],
    lang: string,
    langName: string,
    register: Register = "default"
  ): Promise<Record<string, VoiceOutput>> {
    if (inputs.length === 0) return {};

    const items = inputs.map((i) => `"${i.key}": "${i.text}"`).join("\n");

    // The SSML guidance is intentionally pragmatic — production TTS engines
    // (AWS Polly, Google Cloud TTS, Azure, ElevenLabs) all consume SSML 1.0,
    // so we keep markup to the conservative subset they share. Customers
    // who want richer prosody can post-process.
    const prompt = `You are a phonetics + speech-synthesis expert specializing in South Asian languages.

For each UI string in ${langName} (${lang}) at the "${register}" register, produce two outputs:

1. **IPA**: International Phonetic Alphabet transcription. Use broad transcription
   (phonemic, not narrow). Mark word boundaries with spaces. For Hindi/Marathi/Nepali
   use Devanagari→IPA conventions; for Bengali use Bengali→IPA; for Tamil/Telugu/
   Kannada/Malayalam use Dravidian→IPA. For Latin-script variants (e.g. Hinglish,
   Roman Nepali), still emit IPA based on how the text is meant to be pronounced
   in spoken Hindi/Nepali/etc., NOT how an English speaker would read the Latin letters.

2. **SSML**: SSML 1.0 markup wrapped in <speak> tags. Add minimal helpful hints —
   <break time="200ms"/> between sentences if natural, <emphasis> for important
   nouns, and a top-level xml:lang="${lang}" attribute. Do NOT use vendor-specific
   extensions (no <amazon:*>, no <google:*>). Keep the SSML readable and small.

RULES:
- Preserve any {placeholder} variables exactly as text in both outputs
  (a TTS engine will substitute them at render time).
- Return ONLY valid JSON — no markdown, no code blocks, no prose.
- The JSON shape must be exactly:
  { "<key>": { "ipa": "...", "ssml": "<speak xml:lang=\\"${lang}\\">...</speak>" } }

STRINGS:
${items}`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = result.response.text();
      const jsonStr = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(jsonStr);

      const output: Record<string, VoiceOutput> = {};
      for (const i of inputs) {
        const cell = parsed[i.key];
        if (
          cell &&
          typeof cell === "object" &&
          typeof cell.ipa === "string" &&
          typeof cell.ssml === "string"
        ) {
          output[i.key] = { ipa: cell.ipa, ssml: cell.ssml };
        }
      }
      return output;
    } catch (error: any) {
      console.error("[BhashaJS AI] Voice generation failed:", error.message);
      throw new Error(`Voice generation failed: ${error.message}`);
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Get the configured AI translation provider.
 *
 * Set AI_PROVIDER in .env to switch providers:
 *   - "gemini" (default) — Google Gemini
 *   - "claude" — Anthropic Claude (not yet implemented)
 *   - "openai" — OpenAI GPT (not yet implemented)
 *
 * To add a new provider:
 *   1. Create a class implementing AITranslationProvider
 *   2. Add a case here
 *   3. Add the API key env var
 */
export function getAIProvider(): AITranslationProvider {
  const provider = process.env.AI_PROVIDER || "gemini";

  switch (provider) {
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set in .env");
      }
      return new GeminiProvider(apiKey);
    }

    // Future providers:
    // case "claude": { ... }
    // case "openai": { ... }

    default:
      throw new Error(`Unknown AI provider: ${provider}. Supported: gemini`);
  }
}
