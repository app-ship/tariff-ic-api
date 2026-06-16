/**
 * Lightweight PubChem resolver.
 *
 * Calls PubChem's free public REST API directly so tariff-ic-api has no
 * runtime dependency on the deep-research service for material lookups.
 *
 * Two round-trips per resolve:
 *   1. /compound/name/{query}/property/...  → CID + core chemical props
 *   2. /compound/cid/{cid}/synonyms + /description (parallel)  → preferred name + CAS list
 */

import axios, { type AxiosInstance } from 'axios';

const BASE   = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

// PubChem's shared GCP egress can trigger 503 on burst traffic.
// We follow NCBI's guidelines: identify the tool + contact email in User-Agent,
// and retry with jittered exponential backoff on 429/503 (same policy used by
// the deep-research service — see utils/external_http.py).
const PUBCHEM_UA =
  process.env.INFIS_USER_AGENT ??
  'InfisTariffIC/1.0 (+https://infis.ai/bot; ops@infis.ai)';

const pubchem: AxiosInstance = axios.create({
  baseURL: BASE,
  timeout: 15_000,
  headers: {
    'Accept':     'application/json',
    'User-Agent': PUBCHEM_UA,
  },
});

/** Retry a PubChem GET up to `maxAttempts` times on transient errors (429/503). */
async function pubchemGet<T>(url: string, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data } = await pubchem.get<T>(url);
      return data;
    } catch (err: unknown) {
      lastErr = err;
      const status = (err as any)?.response?.status as number | undefined;
      // 429 = rate limited, 503 = PubChem overloaded — both are retryable
      if (status === 429 || status === 503) {
        if (attempt < maxAttempts) {
          // Jittered exponential back-off: ~500ms, ~1s, ~2s
          const baseMs = 500 * Math.pow(2, attempt - 1);
          const jitter  = Math.random() * baseMs * 0.5;
          await new Promise((r) => setTimeout(r, baseMs + jitter));
          continue;
        }
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ResolveRequest {
  query: string;
  material_name?: string;
}

export interface ResolveResult {
  query:              string;
  query_type:         'cas' | 'name';
  resolved:           boolean;
  source:             'pubchem' | 'none';
  pubchem_cid?:       number;
  name?:              string;
  iupac_name?:        string;
  primary_cas?:       string;
  cas_numbers:        string[];
  molecular_formula?: string;
  molecular_weight?:  number;
  inchi?:             string;
  inchikey?:          string;
  canonical_smiles?:  string;
  synonyms:           string[];
  confidence_score:   number;
  confidence_reason:  string;
  resolution_time_ms: number;
  resolved_at:        string;
  error?:             string;
  name_match_warning?: {
    has_warning:   boolean;
    severity:      string;
    resolved_name: string;
    user_name:     string;
    match_score:   number;
    message:       string;
  };
}

interface PubChemProps {
  CID:              number;
  MolecularFormula?: string;
  MolecularWeight?:  string;
  CanonicalSMILES?:  string;
  InChI?:            string;
  InChIKey?:         string;
  IUPACName?:        string;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function fetchProps(query: string): Promise<PubChemProps | null> {
  try {
    const data = await pubchemGet<unknown>(
      `/compound/name/${encodeURIComponent(query)}/property/MolecularFormula,MolecularWeight,CanonicalSMILES,InChI,InChIKey,IUPACName/JSON`,
    );
    const rows = (data as any)?.PropertyTable?.Properties as PubChemProps[] | undefined;
    return rows?.[0] ?? null;
  } catch (err: unknown) {
    if ((err as any)?.response?.status === 404) return null;
    throw err;
  }
}

async function fetchSynonyms(cid: number): Promise<string[]> {
  try {
    const data = await pubchemGet<unknown>(`/compound/cid/${cid}/synonyms/JSON`);
    return ((data as any)?.InformationList?.Information?.[0]?.Synonym as string[]) ?? [];
  } catch {
    return [];
  }
}

async function fetchTitle(cid: number): Promise<string | undefined> {
  try {
    const data = await pubchemGet<unknown>(`/compound/cid/${cid}/description/JSON`);
    const records: any[] = (data as any)?.InformationList?.Information ?? [];
    for (const r of records) {
      if (r.Title) return r.Title as string;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function notResolved(
  query: string,
  queryType: 'cas' | 'name',
  ms: number,
  reason: string,
): ResolveResult {
  return {
    query,
    query_type:         queryType,
    resolved:           false,
    source:             'none',
    cas_numbers:        [],
    synonyms:           [],
    confidence_score:   0,
    confidence_reason:  reason,
    resolution_time_ms: ms,
    resolved_at:        new Date().toISOString(),
    error:              reason,
  };
}

function nameMatchWarning(
  resolvedName: string,
  userName: string,
): ResolveResult['name_match_warning'] {
  const a = userName.trim().toLowerCase();
  const b = resolvedName.toLowerCase();
  if (!a || !b) return undefined;

  const shortA = a.slice(0, Math.min(8, a.length));
  const shortB = b.slice(0, Math.min(8, b.length));
  if (b.includes(shortA) || a.includes(shortB)) return undefined;

  return {
    has_warning:   true,
    severity:      'medium',
    resolved_name: resolvedName,
    user_name:     userName,
    match_score:   0.3,
    message:       `You entered "${userName}" but PubChem resolved this CAS to "${resolvedName}". Please verify this is the correct compound.`,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function resolveMaterial(req: ResolveRequest): Promise<ResolveResult> {
  const start     = Date.now();
  const query     = req.query.trim();
  const queryType = CAS_RE.test(query) ? 'cas' : ('name' as const);

  const props = await fetchProps(query);
  if (!props) {
    return notResolved(query, queryType, Date.now() - start, 'No compound found in PubChem');
  }

  const cid = props.CID;

  const [synonyms, title] = await Promise.all([
    fetchSynonyms(cid),
    fetchTitle(cid),
  ]);

  const casNumbers    = synonyms.filter((s) => CAS_RE.test(s));
  const preferredName = title ?? synonyms[0] ?? props.IUPACName ?? query;
  const primaryCas    = queryType === 'cas' ? query : casNumbers[0];

  const result: ResolveResult = {
    query,
    query_type:         queryType,
    resolved:           true,
    source:             'pubchem',
    pubchem_cid:        cid,
    name:               preferredName,
    iupac_name:         props.IUPACName,
    primary_cas:        primaryCas,
    cas_numbers:        casNumbers,
    molecular_formula:  props.MolecularFormula,
    molecular_weight:   props.MolecularWeight ? parseFloat(props.MolecularWeight) : undefined,
    inchi:              props.InChI,
    inchikey:           props.InChIKey,
    canonical_smiles:   props.CanonicalSMILES,
    synonyms:           synonyms.slice(0, 20),
    confidence_score:   0.95,
    confidence_reason:  'Direct PubChem REST match',
    resolution_time_ms: Date.now() - start,
    resolved_at:        new Date().toISOString(),
  };

  if (queryType === 'cas' && req.material_name) {
    result.name_match_warning = nameMatchWarning(preferredName, req.material_name);
  }

  return result;
}
