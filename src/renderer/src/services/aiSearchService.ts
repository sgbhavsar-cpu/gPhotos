import { Photo, Person } from '../../../types';
import { notify } from './notifications';
import { ClassifyDescribeResult, buildBatchClassifyPrompt, parseBatchClassifyResponse } from './visionClassify';
import { getAllKnownTags, getEntry as getPhotoContentEntry } from './photoContentCache';

export type { ClassifyDescribeResult };

export type AiProvider = 'gemini' | 'openai' | 'local';

export interface AiSearchConfig {
  provider: AiProvider;
  geminiApiKey: string;
  openaiApiKey: string;
  geminiModel: string;
  openaiModel: string;
}

export interface AiPhotoFilter {
  queryText: string;
  explanation: string;
  peopleMustInclude?: string[];
  peopleMustExclude?: string[];
  alonePersonName?: string;
  /** "stavan and stuti only" / "only photo of monika" — the photo must show exactly peopleMustInclude, nobody else. */
  peopleExactOnly?: boolean;
  locationQuery?: string;
  /** Smart Flow content tags (photoContentCache) a matching photo must have ALL of (AND) — the '&tag' autocomplete. */
  tagsMustInclude?: string[];
  /** "&bird or &birds" — a matching photo must have AT LEAST ONE of these tags, not all of them. */
  tagsMatchAny?: string[];
  /** "but not &tag" / "except &tag" — a matching photo must have NONE of these tags. */
  tagsMustExclude?: string[];
  childhoodPersonName?: string;
  dateRange?: {
    start?: string;
    end?: string;
    year?: number;
    month?: number;
  };
  isFavorite?: boolean;
  hasFaces?: boolean;
}

export interface AiSearchResult {
  query: string;
  answer: string;
  filter: AiPhotoFilter;
  matchedPhotos: Photo[];
  matchedPeople: Person[];
  summaryTags: string[];
}


const STORAGE_KEY = 'gphotos_ai_search_config_v1';
// Smart Flows' cloud fallback is configured completely separately from "Search with AI" — the two
// features have different needs (one answers a single typed question; the other may classify
// hundreds of photos unattended) and a user may reasonably want a different provider, key, or none
// at all, for one without affecting the other.
const SMART_FLOWS_STORAGE_KEY = 'gphotos_smart_flows_ai_config_v1';

/** Every distinct place string actually recorded on a photo (city, country, or a free-text label) — what a photo can be matched against. */
function collectKnownLocationValues(photos: Photo[]): string[] {
  const values = new Set<string>();
  for (const p of photos) {
    if (p.location?.city) values.add(p.location.city);
    if (p.location?.country) values.add(p.location.country);
    if (p.location?.label) values.add(p.location.label);
  }
  return Array.from(values);
}

/**
 * Same values as collectKnownLocationValues, but split so a city/label value always outranks a
 * bare country value — used by smartLocalNlp's substring-match loop, which otherwise picks whichever
 * value happens to be checked first. Reported bug: searching "#andaman" (the autocomplete inserts
 * the library's own "Andaman, India" text) resolved to the country "India" instead of the specific
 * "Andaman" whenever some OTHER India photo's country value happened to land earlier in iteration
 * order than "Andaman" itself — silently matching the whole country instead of the one place.
 */
function collectKnownLocationValuesBySpecificity(photos: Photo[]): { specific: string[]; countries: string[] } {
  const specific = new Set<string>();
  const countries = new Set<string>();
  for (const p of photos) {
    if (p.location?.city) specific.add(p.location.city);
    if (p.location?.label) specific.add(p.location.label);
    if (p.location?.country) countries.add(p.location.country);
  }
  return { specific: Array.from(specific), countries: Array.from(countries) };
}

// LLM output is untrusted: a non-array / non-string field used to throw deep inside applyFilter.
const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : undefined;
const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const asBoolean = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
// The model may answer { "year": "2024" }: coerce, and keep only finite numbers (else the filter matches nothing).
const asFiniteNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && !v.trim() ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const asDateRange = (v: unknown): AiPhotoFilter['dateRange'] => {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  return { start: asString(r.start), end: asString(r.end), year: asFiniteNumber(r.year), month: asFiniteNumber(r.month) };
};

const BLANK_CONFIG = (): AiSearchConfig => ({
  provider: 'local',
  geminiApiKey: '',
  openaiApiKey: '',
  geminiModel: 'gemini-1.5-flash',
  openaiModel: 'gpt-4o-mini',
});

class AiSearchService {
  // "Search with AI" (the chat box) — unchanged from before this split.
  private config: AiSearchConfig = BLANK_CONFIG();
  // Smart Flows' own cloud fallback — starts blank/local too, same safe default: nothing is sent
  // anywhere until the user explicitly configures and consents to it.
  private smartFlowsConfig: AiSearchConfig = BLANK_CONFIG();

  constructor() {
    this.loadConfig();
    this.loadSmartFlowsConfig();
  }

  public loadConfig(): AiSearchConfig {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.config = { ...this.config, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to read AI search config from localStorage:', e);
    }
    return this.config;
  }

  public saveConfig(newConfig: Partial<AiSearchConfig>): AiSearchConfig {
    this.config = { ...this.config, ...newConfig };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch (e) {
      console.warn('Failed to save AI search config to localStorage:', e);
    }
    return this.config;
  }

  public getConfig(): AiSearchConfig {
    return { ...this.config };
  }

  public loadSmartFlowsConfig(): AiSearchConfig {
    try {
      const raw = localStorage.getItem(SMART_FLOWS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.smartFlowsConfig = { ...this.smartFlowsConfig, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to read Smart Flows AI config from localStorage:', e);
    }
    return this.smartFlowsConfig;
  }

  public saveSmartFlowsConfig(newConfig: Partial<AiSearchConfig>): AiSearchConfig {
    this.smartFlowsConfig = { ...this.smartFlowsConfig, ...newConfig };
    try {
      localStorage.setItem(SMART_FLOWS_STORAGE_KEY, JSON.stringify(this.smartFlowsConfig));
    } catch (e) {
      console.warn('Failed to save Smart Flows AI config to localStorage:', e);
    }
    return this.smartFlowsConfig;
  }

  public getSmartFlowsConfig(): AiSearchConfig {
    return { ...this.smartFlowsConfig };
  }

  /**
   * Execute natural language query across the library
   */
  public async search(
    query: string,
    photos: Photo[],
    people: Person[]
  ): Promise<AiSearchResult> {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
      return {
        query: '',
        answer: 'Please enter a search query.',
        filter: { queryText: '', explanation: '' },
        matchedPhotos: [],
        matchedPeople: [],
        summaryTags: [],
      };
    }

    let filter: AiPhotoFilter | null = null;

    // If Gemini or OpenAI is configured, try cloud LLM first
    if (this.config.provider === 'gemini' && this.config.geminiApiKey.trim()) {
      try {
        filter = await this.queryGemini(cleanQuery, people, photos);
      } catch (err) {
        console.warn('Gemini query failed, falling back to smart local NLP:', err);
        notify('warning', `Gemini search failed (${(err as Error)?.message || err}) — showing basic local search results instead.`);
      }
    } else if (this.config.provider === 'openai' && this.config.openaiApiKey.trim()) {
      try {
        filter = await this.queryOpenAI(cleanQuery, people, photos);
      } catch (err) {
        console.warn('OpenAI query failed, falling back to smart local NLP:', err);
        notify('warning', `OpenAI search failed (${(err as Error)?.message || err}) — showing basic local search results instead.`);
      }
    }

    // If cloud LLM was not used or failed, use smart local rule-based NLP
    if (!filter) {
      filter = this.smartLocalNlp(cleanQuery, people, photos);
    }

    // Apply the filter to photos
    const matchedPhotos = this.applyFilter(filter, photos, people);
    const matchedPeople = this.getReferencedPeople(filter, people);
    const summaryTags = this.generateSummaryTags(filter, matchedPhotos.length);

    return {
      query: cleanQuery,
      answer: filter.explanation,
      filter,
      matchedPhotos,
      matchedPeople,
      summaryTags,
    };
  }

  /**
   * Smart Local Rule-based NLP Engine
   * Capable of resolving:
   * - "Photo of rajshree's childhood"
   * - "Photo of sachin and monika"
   * - "Photo of sachin, monika and rajshree"
   * - "Photos of sachin in andaman"
   * - "Photo of monika alone"
   * - and many more combinations!
   */
  public smartLocalNlp(query: string, people: Person[], photos: Photo[]): AiPhotoFilter {
    const q = query.toLowerCase();

    const filter: AiPhotoFilter = {
      queryText: query,
      explanation: '',
      peopleMustInclude: [],
      peopleMustExclude: [],
    };

    // 1. Detect "alone" / "solo" pattern: "Photo of monika alone", "alone photo of sachin", "monika by herself"
    const aloneMatch =
      q.match(/(?:photos?|pics?|pictures?)?\s*(?:of\s+)?([a-z0-9_ -]+?)\s+(?:alone|solo|by\s+herself|by\s+himself|single)/i) ||
      q.match(/(?:alone|solo|single)\s+(?:photos?|pics?|pictures?)?\s*(?:of\s+)?([a-z0-9_ -]+)/i);

    if (aloneMatch) {
      const candidateName = aloneMatch[1].trim();
      const matchedPerson = this.findBestPersonMatch(candidateName, people);
      if (matchedPerson) {
        filter.alonePersonName = matchedPerson.name;
        filter.peopleMustInclude = [matchedPerson.name];
        // Don't return here — "alone" can still be combined with a location/date/tag
        // ("only photo of monika alone at andaman"), detected by the steps below.
      }
    }

    // 2. Detect "childhood" / "young" / "baby" pattern: "Photo of rajshree's childhood", "rajshree childhood photo"
    const childhoodMatch =
      q.match(/(?:photos?|pics?|pictures?)?\s*(?:of\s+)?([a-z0-9_ -]+?)(?:'s)?\s+(?:childhood|younger|baby|kid|small\s+age)/i) ||
      q.match(/(?:childhood|baby|young)\s+(?:photos?|pics?|pictures?)?\s*(?:of\s+)?([a-z0-9_ -]+)/i);

    if (childhoodMatch) {
      const candidateName = childhoodMatch[1].trim();
      const matchedPerson = this.findBestPersonMatch(candidateName, people);
      if (matchedPerson) {
        filter.childhoodPersonName = matchedPerson.name;
        filter.peopleMustInclude = [matchedPerson.name];
        // Don't return here, same reason as the "alone" branch above.
      }
    }

    // 3. Detect a location. Checked two ways:
    //    a) a place already known from the library's own photos, mentioned ANYWHERE in the query —
    //       this is what the "#place" autocomplete relies on: it inserts the bare place name with no
    //       preceding preposition (e.g. "Photo of Udaipur, India"), which the old preposition-only
    //       regex below never recognised as a location at all.
    //    b) falling back to "in andaman", "at goa", etc. for a place not yet geotagged in the library.
    let detectedLocation: string | undefined;
    // Specific values (city/label) checked in full BEFORE any country value, so a city never loses
    // to its own country just because the country happened to be seen first (see
    // collectKnownLocationValuesBySpecificity) — e.g. "#andaman" must resolve to "Andaman", not fall
    // through to matching every other "India" photo in the library.
    const { specific, countries } = collectKnownLocationValuesBySpecificity(photos);
    for (const loc of [...specific, ...countries]) {
      const regex = new RegExp(`\\b${this.escapeRegExp(loc.toLowerCase())}\\b`, 'i');
      if (regex.test(q)) {
        detectedLocation = loc; // the library's own clean value (e.g. just "Udaipur"), not whatever the user typed around it
        break;
      }
    }
    if (!detectedLocation) {
      const locationMatch = q.match(/\b(?:in|at|around|from|near)\s+([a-z0-9_ -]+?)(?:\s+with|\s+and|\s*$)/i);
      if (locationMatch) detectedLocation = locationMatch[1].trim();
    }
    if (detectedLocation) {
      // Verify it is not a person name
      const personConflict = this.findBestPersonMatch(detectedLocation, people);
      if (!personConflict) {
        filter.locationQuery = detectedLocation;
      }
    }

    // 4. Detect excluded people/tags: "photo of monika but not raji", "&cat but not &dog",
    // "monika except raji", "without raji". These clauses are normally trailing, so matching to
    // end-of-string keeps this simple and avoids the exclusion keyword itself (e.g. "not") being
    // mistaken for part of a name/tag elsewhere. Checked before inclusion detection below, so a
    // person/tag named in the exclusion clause is never ALSO picked up as something that must be
    // present — resolved against known tags first since the "&tag" autocomplete always inserts an
    // exact, unambiguous tag name, falling back to a person-name match otherwise.
    const excludeMatch = q.match(/\b(?:but\s+not|except(?:\s+for)?|excluding|without)\s+([a-z0-9_ ,&]+)$/i);
    const excludedPeople: Person[] = [];
    const excludedTags: string[] = [];
    if (excludeMatch) {
      const knownTagsLower = new Map(getAllKnownTags().map((t) => [t.toLowerCase(), t]));
      for (const token of excludeMatch[1].split(/,|&|\band\b/i)) {
        const clean = token.trim().toLowerCase();
        if (!clean) continue;
        const tagMatch = knownTagsLower.get(clean);
        if (tagMatch) {
          if (!excludedTags.includes(tagMatch)) excludedTags.push(tagMatch);
          continue;
        }
        const matched = this.findBestPersonMatch(clean, people);
        if (matched && !excludedPeople.includes(matched)) excludedPeople.push(matched);
      }
    }
    if (excludedPeople.length > 0) {
      filter.peopleMustExclude = excludedPeople.map((p) => p.name);
    }
    if (excludedTags.length > 0) {
      filter.tagsMustExclude = excludedTags;
    }

    // Everything from here on only looks at the part of the query BEFORE the exclusion clause
    // (if any), so a name/tag mentioned there is never also picked up as something required.
    const qForInclude = excludeMatch ? q.slice(0, excludeMatch.index) : q;

    // 5. Detect Smart Flow content tags mentioned in the query — what the "&tag" autocomplete
    // inserts verbatim (e.g. "Photo of a receipt tagged bill"), same approach as the "#place" known-
    // value loop above: only tags this library has actually recorded (photoContentCache) are
    // recognised, so a random word never gets misread as a tag filter. "&bird or &birds" means
    // EITHER tag (tagsMatchAny); with no "or" between multiple tags, every one is required (AND,
    // the original/default behavior) — "&bird and &cat" or just "&bird &cat" both still mean both.
    const foundTags = getAllKnownTags().filter((tag) => new RegExp(`\\b${this.escapeRegExp(tag.toLowerCase())}\\b`, 'i').test(qForInclude));
    if (foundTags.length > 1 && /\bor\b/i.test(qForInclude)) {
      filter.tagsMatchAny = foundTags;
    } else if (foundTags.length > 0) {
      filter.tagsMustInclude = foundTags;
    }

    // 6. Detect people names mentioned in query (e.g. "sachin and monika", "sachin, monika and rajshree").
    // Scanned only up to the exclusion clause above, so "raji" in "but not raji" isn't also picked up
    // here as someone who must be IN the photo.
    const foundPeople: Person[] = [];
    for (const person of people) {
      if (excludedPeople.includes(person)) continue;
      const nameLower = person.name.toLowerCase();
      // Match whole word name
      const regex = new RegExp(`\\b${this.escapeRegExp(nameLower)}\\b`, 'i');
      if (regex.test(qForInclude)) {
        foundPeople.push(person);
      }
    }

    if (foundPeople.length > 0) {
      filter.peopleMustInclude = foundPeople.map((p) => p.name);
    }

    // 7. "only" as an exclusivity marker — "Only photo of monika", "photo of stavan and stuti only" —
    // means the photo must show exactly these people and no one else. Independent of the
    // alone/solo/single keywords above (those already imply solo on their own); this covers plain
    // "only" and also works for a GROUP of names, which alonePersonName can't (it's single-person only).
    if (/\bonly\b/i.test(q) && foundPeople.length > 0 && !filter.alonePersonName && !filter.childhoodPersonName) {
      filter.peopleExactOnly = true;
    }

    // 8. Detect Year
    const yearMatch = q.match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) {
      filter.dateRange = { year: parseInt(yearMatch[1], 10) };
    }

    // 9. Detect Favorites
    if (/\b(favorite|favorites|starred|best\s+shots?)\b/i.test(q)) {
      filter.isFavorite = true;
    }

    // 10. Detect Portraits vs Scenery
    if (/\b(scenery|landscape|nature|no\s+people|without\s+people)\b/i.test(q)) {
      filter.hasFaces = false;
    }

    // Build human-friendly explanation
    const parts: string[] = [];
    if (filter.alonePersonName) {
      parts.push(`solo photos of ${filter.alonePersonName} alone (no other people in photo)`);
    } else if (filter.childhoodPersonName) {
      parts.push(`childhood & early memory photos of ${filter.childhoodPersonName}`);
    } else if (filter.peopleMustInclude && filter.peopleMustInclude.length > 0) {
      const onlySuffix = filter.peopleExactOnly ? ', and no one else' : '';
      if (filter.peopleMustInclude.length === 1) {
        parts.push(`photos of ${filter.peopleMustInclude[0]}${onlySuffix}`);
      } else {
        const names = [...filter.peopleMustInclude];
        const last = names.pop();
        parts.push(`photos featuring ${names.join(', ')} and ${last} together${onlySuffix}`);
      }
    } else {
      parts.push('photos');
    }

    if (filter.peopleMustExclude && filter.peopleMustExclude.length > 0) {
      parts.push(`without ${filter.peopleMustExclude.join(', ')}`);
    }

    if (filter.locationQuery) {
      parts.push(`taken in "${filter.locationQuery}"`);
    }

    if (filter.tagsMustInclude && filter.tagsMustInclude.length > 0) {
      parts.push(`tagged "${filter.tagsMustInclude.join('", "')}"`);
    }
    if (filter.tagsMatchAny && filter.tagsMatchAny.length > 0) {
      parts.push(`tagged "${filter.tagsMatchAny.join('" or "')}"`);
    }
    if (filter.tagsMustExclude && filter.tagsMustExclude.length > 0) {
      parts.push(`not tagged "${filter.tagsMustExclude.join('", "')}"`);
    }

    if (filter.dateRange?.year) {
      parts.push(`from year ${filter.dateRange.year}`);
    }

    if (filter.isFavorite) {
      parts.push(`marked as favorites`);
    }

    filter.explanation = `Showing ${parts.join(' ')}.`;
    return filter;
  }

  /**
   * Query Google Gemini API
   */
  private async queryGemini(
    query: string,
    people: Person[],
    photos: Photo[]
  ): Promise<AiPhotoFilter> {
    const knownPeople = people.map((p) => p.name);
    const knownLocations = collectKnownLocationValues(photos).slice(0, 30);
    const knownTags = getAllKnownTags().slice(0, 50);

    const prompt = `You are a smart photo assistant for a desktop photo library.
Translate the user's natural language photo search query into a structured JSON filter.

Available people in the library: ${JSON.stringify(knownPeople)}
Common locations in the library: ${JSON.stringify(knownLocations)}
Content tags recorded from AI photo analysis (e.g. "receipt", "bill", "screenshot"): ${JSON.stringify(knownTags)}

User Query: "${query}"

Return ONLY valid JSON matching this TypeScript structure:
{
  "explanation": "Human friendly explanation of what photos are shown",
  "peopleMustInclude": ["List of exact person names from available people who must appear in photo"],
  "peopleMustExclude": ["List of exact person names who must NOT appear, e.g. 'photo of monika but not raji' -> [\"raji\"]"],
  "alonePersonName": "Exact person name if query specifically asks for them alone/solo",
  "peopleExactOnly": "true if the query says 'only' these people and nobody else, e.g. 'only photo of monika', 'photo of stavan and stuti only' — false/null otherwise. Works with one name or a group.",
  "childhoodPersonName": "Exact person name if query asks for their childhood/baby/early years",
  "locationQuery": "The MOST SPECIFIC place mentioned (a city/place name), otherwise null. If the query names both a place and its country (e.g. 'Andaman, India'), use the specific place — just 'Andaman' — never the bare country alone, which would match every photo from that whole country instead of the one place meant.",
  "tagsMustInclude": ["List of exact content tags from the list above the query requires ALL of (AND) — the default when multiple tags are named with no 'or' between them"],
  "tagsMatchAny": ["List of exact content tags from the list above where the query only needs ONE of them, e.g. 'bird or birds' -> [\"bird\", \"birds\"]. Only used when the query says 'or' between tags — otherwise leave this empty and use tagsMustInclude."],
  "tagsMustExclude": ["List of exact content tags that must NOT be present, e.g. 'photo tagged cat but not dog' -> [\"dog\"]"],
  "dateRange": { "year": 2024 } // or null if no year mentioned
}
Do NOT return markdown fences or other text, ONLY the raw JSON object.`;

    const model = this.config.geminiModel || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.config.geminiApiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidateText) {
      throw new Error('Gemini returned an empty response.');
    }

    const parsed = JSON.parse(candidateText);
    return {
      queryText: query,
      explanation: parsed.explanation || `Filtered photos for: "${query}"`,
      peopleMustInclude: asStringArray(parsed.peopleMustInclude),
      peopleMustExclude: asStringArray(parsed.peopleMustExclude),
      peopleExactOnly: asBoolean(parsed.peopleExactOnly),
      alonePersonName: asString(parsed.alonePersonName),
      childhoodPersonName: asString(parsed.childhoodPersonName),
      locationQuery: asString(parsed.locationQuery),
      tagsMustInclude: asStringArray(parsed.tagsMustInclude),
      tagsMatchAny: asStringArray(parsed.tagsMatchAny),
      tagsMustExclude: asStringArray(parsed.tagsMustExclude),
      dateRange: asDateRange(parsed.dateRange),
    };
  }

  /**
   * Query OpenAI API
   */
  private async queryOpenAI(
    query: string,
    people: Person[],
    photos: Photo[]
  ): Promise<AiPhotoFilter> {
    const knownPeople = people.map((p) => p.name);
    const knownLocations = collectKnownLocationValues(photos).slice(0, 30);
    const knownTags = getAllKnownTags().slice(0, 50);

    const systemPrompt = `You are a smart photo library assistant.
Translate user photo search queries into structured JSON filters.
Available people: ${JSON.stringify(knownPeople)}
Locations: ${JSON.stringify(knownLocations)}
Content tags recorded from AI photo analysis: ${JSON.stringify(knownTags)}

Return ONLY JSON:
{
  "explanation": "Brief description",
  "peopleMustInclude": string[],
  "peopleMustExclude": string[], // e.g. "photo of monika but not raji" -> ["raji"]
  "alonePersonName": string | null,
  "peopleExactOnly": boolean | null, // true if query says "only" these people, nobody else (one name or a group)
  "childhoodPersonName": string | null,
  "locationQuery": string | null, // the MOST SPECIFIC place (a city/place name) — if the query names both a place and its country (e.g. "Andaman, India"), use just "Andaman", never the bare country alone, which would match every photo from that whole country
  "tagsMustInclude": string[], // ALL of these tags required (AND) — the default when no "or" is used
  "tagsMatchAny": string[], // ANY ONE of these tags — only when the query says "or" between tags, e.g. "bird or birds"
  "tagsMustExclude": string[], // e.g. "tagged cat but not dog" -> ["dog"]
  "dateRange": { "year": number } | null
}`;

    const model = this.config.openaiModel || 'gpt-4o-mini';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI returned empty message content.');
    }

    const parsed = JSON.parse(content);
    return {
      queryText: query,
      explanation: parsed.explanation || `Filtered photos for: "${query}"`,
      peopleMustInclude: asStringArray(parsed.peopleMustInclude),
      peopleMustExclude: asStringArray(parsed.peopleMustExclude),
      peopleExactOnly: asBoolean(parsed.peopleExactOnly),
      alonePersonName: asString(parsed.alonePersonName),
      childhoodPersonName: asString(parsed.childhoodPersonName),
      locationQuery: asString(parsed.locationQuery),
      tagsMustInclude: asStringArray(parsed.tagsMustInclude),
      tagsMatchAny: asStringArray(parsed.tagsMatchAny),
      tagsMustExclude: asStringArray(parsed.tagsMustExclude),
      dateRange: asDateRange(parsed.dateRange),
    };
  }

  /**
   * Ask the configured cloud provider whether each of up to a handful of photos' actual pixels
   * matches a free-text description ("a screenshot of a Facebook post", "a scanned bill", ...),
   * batched into one request to amortize the fixed prompt cost across the whole batch. Also
   * returns a general caption + tags for every photo regardless of match — Smart Flows caches
   * these locally so a DIFFERENT flow can often be answered from cache instead of spending
   * another vision call on the same photo. Unlike `search()` this looks at image pixels, not
   * metadata — there is no local/offline fallback, so it throws when no provider is configured.
   * Takes the provider config explicitly (rather than reading a shared one) since the only caller,
   * Smart Flows, has its own separate cloud configuration — see getSmartFlowsConfig().
   */
  public async classifyImagesBatch(
    items: Array<{ base64: string; mimeType: string }>,
    description: string,
    config: AiSearchConfig
  ): Promise<ClassifyDescribeResult[]> {
    if (items.length === 0) return [];
    if (config.provider === 'gemini' && config.geminiApiKey.trim()) {
      return this.classifyBatchWithGemini(items, description, config);
    }
    if (config.provider === 'openai' && config.openaiApiKey.trim()) {
      return this.classifyBatchWithOpenAI(items, description, config);
    }
    throw new Error('Set a Gemini or OpenAI API key in Smart Flows\' cloud settings first — classifying photos needs a cloud vision provider.');
  }

  private async classifyBatchWithGemini(
    items: Array<{ base64: string; mimeType: string }>,
    description: string,
    config: AiSearchConfig
  ): Promise<ClassifyDescribeResult[]> {
    const model = config.geminiModel || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;
    const parts: Array<Record<string, unknown>> = [{ text: buildBatchClassifyPrompt(items.length, description) }];
    items.forEach((item, i) => {
      parts.push({ text: `Image ${i + 1}:` });
      parts.push({ inlineData: { mimeType: item.mimeType, data: item.base64 } });
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    });
    if (!response.ok) throw new Error(`Gemini API error (${response.status}): ${await response.text()}`);

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned an empty response.');
    return parseBatchClassifyResponse(text, items.length);
  }

  private async classifyBatchWithOpenAI(
    items: Array<{ base64: string; mimeType: string }>,
    description: string,
    config: AiSearchConfig
  ): Promise<ClassifyDescribeResult[]> {
    const model = config.openaiModel || 'gpt-4o-mini';
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: buildBatchClassifyPrompt(items.length, description) }];
    items.forEach((item, i) => {
      content.push({ type: 'text', text: `Image ${i + 1}:` });
      content.push({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.base64}` } });
    });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiApiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI API error (${response.status}): ${await response.text()}`);

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('OpenAI returned empty message content.');
    // gpt-4o with response_format json_object must return an object, not a bare array — accept
    // either shape ({"results": [...]}, or the array itself) since the prompt asks for an array.
    let text = raw;
    try {
      const obj = JSON.parse(raw);
      if (!Array.isArray(obj) && Array.isArray(obj?.results)) text = JSON.stringify(obj.results);
    } catch {
      // fall through — parseBatchClassifyResponse will surface the JSON error
    }
    return parseBatchClassifyResponse(text, items.length);
  }

  /**
   * Filter library photos using the resolved filter specification
   */
  public applyFilter(filter: AiPhotoFilter, photos: Photo[], people: Person[]): Photo[] {
    let result = [...photos];

    // Helper map from person name (lowercase) to person ID
    const nameToId = new Map<string, string>();
    for (const p of people) {
      nameToId.set(p.name.toLowerCase(), p.id);
    }

    // 1. Alone person filter
    if (filter.alonePersonName) {
      const personId = nameToId.get(filter.alonePersonName.toLowerCase());
      if (personId) {
        result = result.filter((photo) => {
          if (!photo.faces || photo.faces.length !== 1) return false;
          return photo.faces[0].personId === personId;
        });
      }
    }
    // 2. Childhood person filter
    else if (filter.childhoodPersonName) {
      const personId = nameToId.get(filter.childhoodPersonName.toLowerCase());
      if (personId) {
        // Find all photos with this person
        const personPhotos = result.filter((p) =>
          p.faces?.some((f) => f.personId === personId)
        );

        // Sort ascending by date taken
        personPhotos.sort(
          (a, b) => new Date(a.dateTaken).getTime() - new Date(b.dateTaken).getTime()
        );

        // Childhood is the earliest 35% of photos or first 5 years of timestamps
        const cutoffCount = Math.max(1, Math.ceil(personPhotos.length * 0.35));
        result = personPhotos.slice(0, cutoffCount);
      }
    }
    // 3. Multiple people must be present together
    else if (filter.peopleMustInclude && filter.peopleMustInclude.length > 0) {
      const requiredIds: string[] = [];
      for (const name of filter.peopleMustInclude) {
        const id = nameToId.get(name.toLowerCase());
        if (id) requiredIds.push(id);
      }

      if (requiredIds.length > 0) {
        result = result.filter((photo) => {
          if (!photo.faces || photo.faces.length === 0) return false;
          const presentIds = new Set(photo.faces.map((f) => f.personId).filter(Boolean));
          // Photo must have EVERY required person
          if (!requiredIds.every((reqId) => presentIds.has(reqId))) return false;
          // "...only" / "only photo of..." — and no one ELSE in the photo either.
          if (filter.peopleExactOnly && ![...presentIds].every((id) => requiredIds.includes(id as string))) return false;
          return true;
        });
      }
    }

    // 3b. People who must NOT appear ("but not raji", "except raji") — independent of which of the
    // branches above matched, so it combines with alone/childhood/group queries too.
    if (filter.peopleMustExclude && filter.peopleMustExclude.length > 0) {
      const excludedIds = new Set(
        filter.peopleMustExclude.map((n) => nameToId.get(n.toLowerCase())).filter((id): id is string => Boolean(id))
      );
      if (excludedIds.size > 0) {
        result = result.filter((photo) => !photo.faces?.some((f) => f.personId && excludedIds.has(f.personId)));
      }
    }

    // 4. Location filter. locationQuery can be a single place ("Udaipur") or a combined
    // "City, Country" label (exactly what the "#place" autocomplete inserts, and what a cloud LLM
    // sometimes echoes back verbatim) — a photo's city/country are stored as separate fields, so
    // matching the combined string against any ONE field would never succeed. Every comma-separated
    // part is required to appear SOMEWHERE across the photo's own location fields instead.
    if (filter.locationQuery) {
      const locParts = filter.locationQuery.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      if (locParts.length > 0) {
        result = result.filter((p) => {
          const haystack = [p.location?.label, p.location?.city, p.location?.country].filter(Boolean).join(' ').toLowerCase();
          return locParts.every((part) => haystack.includes(part));
        });
      }
    }

    // 5. Smart Flow content tag filter — a photo must have EVERY required tag in its
    // photoContentCache entry (the durable, cross-flow cache described at the top of that file).
    // A photo Smart Flow has never looked at has no entry at all, so it correctly never matches.
    if (filter.tagsMustInclude && filter.tagsMustInclude.length > 0) {
      const requiredTags = filter.tagsMustInclude.map((t) => t.toLowerCase());
      result = result.filter((p) => {
        const photoTags = getPhotoContentEntry(p.id)?.tags;
        if (!photoTags || photoTags.length === 0) return false;
        const present = new Set(photoTags.map((t) => t.toLowerCase()));
        return requiredTags.every((t) => present.has(t));
      });
    }

    // 5b. "&bird or &birds" — a photo must have AT LEAST ONE of these tags, not all.
    if (filter.tagsMatchAny && filter.tagsMatchAny.length > 0) {
      const anyTags = filter.tagsMatchAny.map((t) => t.toLowerCase());
      result = result.filter((p) => {
        const photoTags = getPhotoContentEntry(p.id)?.tags;
        if (!photoTags || photoTags.length === 0) return false;
        const present = new Set(photoTags.map((t) => t.toLowerCase()));
        return anyTags.some((t) => present.has(t));
      });
    }

    // 5c. "but not &tag" — a photo must have NONE of these tags. A photo with no content-cache
    // entry at all trivially satisfies this (nothing to exclude), unlike the must-include filters.
    if (filter.tagsMustExclude && filter.tagsMustExclude.length > 0) {
      const excludedTags = filter.tagsMustExclude.map((t) => t.toLowerCase());
      result = result.filter((p) => {
        const photoTags = getPhotoContentEntry(p.id)?.tags;
        if (!photoTags || photoTags.length === 0) return true;
        const present = new Set(photoTags.map((t) => t.toLowerCase()));
        return !excludedTags.some((t) => present.has(t));
      });
    }

    // 6. Date / Year filter
    const yr = asFiniteNumber(filter.dateRange?.year);
    if (yr) {
      result = result.filter((p) => new Date(p.dateTaken).getFullYear() === yr);
    }

    // 7. Favorite filter
    if (filter.isFavorite) {
      result = result.filter((p) => p.isFavorite);
    }

    // 8. Face presence filter
    if (filter.hasFaces === false) {
      result = result.filter((p) => !p.faces || p.faces.length === 0);
    }

    return result;
  }

  private findBestPersonMatch(name: string, people: Person[]): Person | null {
    const clean = name.trim().toLowerCase();
    for (const p of people) {
      if (p.name.toLowerCase() === clean) return p;
    }
    for (const p of people) {
      if (p.name.toLowerCase().includes(clean) || clean.includes(p.name.toLowerCase())) {
        return p;
      }
    }
    return null;
  }

  private getReferencedPeople(filter: AiPhotoFilter, people: Person[]): Person[] {
    const names = new Set<string>();
    if (filter.alonePersonName) names.add(filter.alonePersonName.toLowerCase());
    if (filter.childhoodPersonName) names.add(filter.childhoodPersonName.toLowerCase());
    if (filter.peopleMustInclude) {
      filter.peopleMustInclude.forEach((n) => names.add(n.toLowerCase()));
    }

    return people.filter((p) => names.has(p.name.toLowerCase()));
  }

  private generateSummaryTags(filter: AiPhotoFilter, count: number): string[] {
    const tags: string[] = [];
    if (filter.alonePersonName) {
      tags.push(`Alone: ${filter.alonePersonName}`);
    } else if (filter.childhoodPersonName) {
      tags.push(`Childhood: ${filter.childhoodPersonName}`);
    } else if (filter.peopleMustInclude && filter.peopleMustInclude.length > 0) {
      tags.push(`People: ${filter.peopleMustInclude.join(', ')}${filter.peopleExactOnly ? ' only' : ''}`);
    }

    if (filter.peopleMustExclude && filter.peopleMustExclude.length > 0) {
      tags.push(`Without: ${filter.peopleMustExclude.join(', ')}`);
    }

    if (filter.locationQuery) {
      tags.push(`Place: ${filter.locationQuery}`);
    }

    if (filter.tagsMustInclude && filter.tagsMustInclude.length > 0) {
      tags.push(`Tags: ${filter.tagsMustInclude.join(', ')}`);
    }
    if (filter.tagsMatchAny && filter.tagsMatchAny.length > 0) {
      tags.push(`Tags (any): ${filter.tagsMatchAny.join(', ')}`);
    }
    if (filter.tagsMustExclude && filter.tagsMustExclude.length > 0) {
      tags.push(`Without tags: ${filter.tagsMustExclude.join(', ')}`);
    }

    if (filter.dateRange?.year) {
      tags.push(`Year: ${filter.dateRange.year}`);
    }

    if (filter.isFavorite) {
      tags.push(`Favorites`);
    }

    tags.push(`${count} photos`);
    return tags;
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export const aiSearchService = new AiSearchService();
