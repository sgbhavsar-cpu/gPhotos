import { Photo, Person } from '../../types';

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
  locationQuery?: string;
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

class AiSearchService {
  private config: AiSearchConfig = {
    provider: 'local',
    geminiApiKey: '',
    openaiApiKey: '',
    geminiModel: 'gemini-1.5-flash',
    openaiModel: 'gpt-4o-mini',
  };

  constructor() {
    this.loadConfig();
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
      }
    } else if (this.config.provider === 'openai' && this.config.openaiApiKey.trim()) {
      try {
        filter = await this.queryOpenAI(cleanQuery, people, photos);
      } catch (err) {
        console.warn('OpenAI query failed, falling back to smart local NLP:', err);
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
        filter.explanation = `Showing solo photos of ${matchedPerson.name} alone (no other people in photo).`;
        return filter;
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
        filter.explanation = `Showing childhood & early memory photos of ${matchedPerson.name}.`;
        return filter;
      }
    }

    // 3. Detect location pattern: "in andaman", "at goa", "in paris", etc.
    const locationMatch = q.match(/\b(?:in|at|around|from|near)\s+([a-z0-9_ -]+?)(?:\s+with|\s+and|\s*$)/i);
    let detectedLocation: string | undefined;
    if (locationMatch) {
      detectedLocation = locationMatch[1].trim();
      // Verify it is not a person name
      const personConflict = this.findBestPersonMatch(detectedLocation, people);
      if (!personConflict) {
        filter.locationQuery = detectedLocation;
      }
    }

    // 4. Detect people names mentioned in query (e.g. "sachin and monika", "sachin, monika and rajshree")
    const foundPeople: Person[] = [];
    for (const person of people) {
      const nameLower = person.name.toLowerCase();
      // Match whole word name
      const regex = new RegExp(`\\b${this.escapeRegExp(nameLower)}\\b`, 'i');
      if (regex.test(q)) {
        foundPeople.push(person);
      }
    }

    if (foundPeople.length > 0) {
      filter.peopleMustInclude = foundPeople.map((p) => p.name);
    }

    // 5. Detect Year
    const yearMatch = q.match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) {
      filter.dateRange = { year: parseInt(yearMatch[1], 10) };
    }

    // 6. Detect Favorites
    if (/\b(favorite|favorites|starred|best\s+shots?)\b/i.test(q)) {
      filter.isFavorite = true;
    }

    // 7. Detect Portraits vs Scenery
    if (/\b(scenery|landscape|nature|no\s+people|without\s+people)\b/i.test(q)) {
      filter.hasFaces = false;
    }

    // Build human-friendly explanation
    const parts: string[] = [];
    if (filter.peopleMustInclude && filter.peopleMustInclude.length > 0) {
      if (filter.peopleMustInclude.length === 1) {
        parts.push(`photos of ${filter.peopleMustInclude[0]}`);
      } else {
        const names = [...filter.peopleMustInclude];
        const last = names.pop();
        parts.push(`photos featuring ${names.join(', ')} and ${last} together`);
      }
    } else {
      parts.push('photos');
    }

    if (filter.locationQuery) {
      parts.push(`taken in "${filter.locationQuery}"`);
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
    const knownLocations = Array.from(
      new Set(
        photos
          .map((p) => p.location?.city || p.location?.label)
          .filter(Boolean) as string[]
      )
    ).slice(0, 30);

    const prompt = `You are a smart photo assistant for a desktop photo library.
Translate the user's natural language photo search query into a structured JSON filter.

Available people in the library: ${JSON.stringify(knownPeople)}
Common locations in the library: ${JSON.stringify(knownLocations)}

User Query: "${query}"

Return ONLY valid JSON matching this TypeScript structure:
{
  "explanation": "Human friendly explanation of what photos are shown",
  "peopleMustInclude": ["List of exact person names from available people who must appear in photo"],
  "alonePersonName": "Exact person name if query specifically asks for them alone/solo",
  "childhoodPersonName": "Exact person name if query asks for their childhood/baby/early years",
  "locationQuery": "Place/city/country string if query specifies a location, otherwise null",
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
      peopleMustInclude: parsed.peopleMustInclude,
      alonePersonName: parsed.alonePersonName || undefined,
      childhoodPersonName: parsed.childhoodPersonName || undefined,
      locationQuery: parsed.locationQuery || undefined,
      dateRange: parsed.dateRange || undefined,
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
    const knownLocations = Array.from(
      new Set(
        photos
          .map((p) => p.location?.city || p.location?.label)
          .filter(Boolean) as string[]
      )
    ).slice(0, 30);

    const systemPrompt = `You are a smart photo library assistant.
Translate user photo search queries into structured JSON filters.
Available people: ${JSON.stringify(knownPeople)}
Locations: ${JSON.stringify(knownLocations)}

Return ONLY JSON:
{
  "explanation": "Brief description",
  "peopleMustInclude": string[],
  "alonePersonName": string | null,
  "childhoodPersonName": string | null,
  "locationQuery": string | null,
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
      peopleMustInclude: parsed.peopleMustInclude,
      alonePersonName: parsed.alonePersonName || undefined,
      childhoodPersonName: parsed.childhoodPersonName || undefined,
      locationQuery: parsed.locationQuery || undefined,
      dateRange: parsed.dateRange || undefined,
    };
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
          return requiredIds.every((reqId) => presentIds.has(reqId));
        });
      }
    }

    // 4. Location filter
    if (filter.locationQuery) {
      const locQ = filter.locationQuery.toLowerCase();
      result = result.filter((p) => {
        const label = p.location?.label?.toLowerCase() || '';
        const city = p.location?.city?.toLowerCase() || '';
        const country = p.location?.country?.toLowerCase() || '';
        return label.includes(locQ) || city.includes(locQ) || country.includes(locQ);
      });
    }

    // 5. Date / Year filter
    if (filter.dateRange?.year) {
      const yr = filter.dateRange.year;
      result = result.filter((p) => new Date(p.dateTaken).getFullYear() === yr);
    }

    // 6. Favorite filter
    if (filter.isFavorite) {
      result = result.filter((p) => p.isFavorite);
    }

    // 7. Face presence filter
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
      tags.push(`People: ${filter.peopleMustInclude.join(', ')}`);
    }

    if (filter.locationQuery) {
      tags.push(`Place: ${filter.locationQuery}`);
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
