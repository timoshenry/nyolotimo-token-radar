// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every pre-token watchlist slug (the floor, never a ceiling) and may add eligible
// pre-token protocols below that floor. A watchlist row that triggers the stricter lexical screen is
// retained for coverage, but its exception must be explicit to the board integrity check. Token-bearing
// snapshot records are shown separately as observed market context, never given a pre-token estimate.
//
// Peer-radar uses token-bearing records in the sealed snapshot as comparables. Its estimates are
// sensitivity scenarios, not token launch forecasts. Eligibility and valuation derive from source fields.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Transparent snapshot-derived valuation controls. */
export interface ModelConstants {
  peer_multiple_floor: number;
  peer_multiple_cap: number;
  global_fallback_multiple: number;
  growth_weight: number;
  age_weight: number;
  max_growth_pct: number;
  tvl_quality_haircut: number;
  dilution_haircut: number;
}
export const MODEL: ModelConstants = {
  peer_multiple_floor: 0.01, peer_multiple_cap: 2.5,
  global_fallback_multiple: 0.12, growth_weight: 0.18, age_weight: 0.08,
  max_growth_pct: 60, tvl_quality_haircut: 0.82, dilution_haircut: 0.72,
};
export const MODEL_VERSION = 'peer-radar-3';
export const EARLY_ROWS = 4000;
export const LIVE_ROWS = 24;
export interface FarmStep { text: string; cost: string; time: string }
export interface PeerEvidence { category: string; peer_count: number; median_mcap_tvl: number; matched_slugs: string[] }
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null; token_status: 'no-token-recorded'; on_watchlist: boolean; age_days: number | null;
  implied_value_usd: number; estimate_low_usd: number; estimate_high_usd: number;
  confidence: 'low' | 'moderate' | 'higher'; confidence_score: number;
  evidence: { snapshot_as_of: string; tvl_usd: number; change_7d: number | null; listed_at: string | null; chains: string[]; peer: PeerEvidence; adjustments: { growth: number; maturity: number; category_risk: number; competition: number; chain_coverage: number; tvl_quality: number; dilution: number } };
  farm_steps: string[];
}
export interface RadarRow extends BoardRow {}
export interface LiveRow { slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number; mcap_usd: number | null; change_7d: number | null }
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model: ModelConstants; model_version: string;
  watchlist_size: number; board_size: number; early_size: number; live_size: number; rows: RadarRow[]; live: LiveRow[];
  methodology: string[]; excluded_count: number;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** Index records are evidence of no token only when all three token fields are empty. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCHANGES = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)(?:\b|\s)/i;
const DERIVATIVE_WORD = /\b(wrapped|staked|staking|bridged|wrapped|receipt token)\b/i;
const DERIVATIVE_CATEGORIES = /\b(bridge|liquid staking|liquid restaking|restaked btc|staking derivative|bridged token)\b/i;
/** Conservative mechanical exclusions; no inferred parent-protocol claims are made. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'token fields recorded';
  if (DERIVATIVE_CATEGORIES.test(p.category ?? '') || DERIVATIVE_WORD.test(p.name)) return 'wrapped, staked, bridged or derivative marker';
  if (EXCHANGES.test(p.name) || p.category === 'CEX') return 'exchange product';
  if (VERSIONED.test(p.name)) return 'versioned deployment';
  return null;
}
export function isRankable(p: SnapshotProtocol): boolean { return exclusionReason(p) === null; }
const DAY_MS = 86_400_000;
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const delta = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`);
  return Number.isFinite(delta) ? Math.max(0, Math.floor(delta / DAY_MS)) : null;
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const median = (xs: number[]) => { const s = xs.slice().sort((a,b)=>a-b); return s.length ? (s.length % 2 ? s[(s.length-1)/2]! : (s[s.length/2-1]!+s[s.length/2]!)/2) : 0; };
const round = (n: number) => Math.round(n);
function categoryKey(c: string | null): string { return c?.trim().toLowerCase() || 'other'; }
function categoryRisk(c: string | null): number {
  const x=categoryKey(c);
  if (/rwa|insurance|ce defi|risk curator|basis trading|restak|stablecoin wrapper/.test(x)) return 0.68;
  if (/chain|payments|oracle|data|gaming|nft/.test(x)) return 0.78;
  if (/lending|dex|yield|cdp|perpetual|derivative|liquid/.test(x)) return 0.9;
  return 0.76;
}
function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain=p.chains[0] || 'a network listed by the protocol';
  const cat=categoryKey(p.category);
  const budget=p.tvl_usd>=1e9?100:p.tvl_usd>=1e8?50:25;
  let action=`Test one core ${p.name} workflow on ${chain} with no more than $${budget} of funds`;
  let check=`Confirm the action settles on ${chain} and appears in your own transaction history`;
  if (/lend|cdp|collateral/.test(cat)) {
    action=`If supported and useful, supply at most $${budget} of a listed asset to ${p.name} on ${chain}`;
    check=`Check supplied asset, displayed rate, collateral rules and withdrawal path in ${p.name} before confirming`;
  } else if (/dex|yield|basis/.test(cat)) {
    action=`If a liquid pool is documented, make one small swap or LP test of at most $${budget} on ${p.name} via ${chain}`;
    check=`Review pool depth, fee tier and impermanent-loss exposure before the ${p.name} test`;
  } else if (/risk curator|allocator|vault/.test(cat)) {
    action=`Inspect the listed vaults, then deposit at most $${budget} only if its assets and withdrawal terms suit you`;
    check=`Verify the vault address, underlying assets, current capacity and exit queue shown by ${p.name}`;
  } else if (/rwa/.test(cat)) {
    action=`Read access restrictions and redemption terms; only then consider a compliant test of at most $${budget}`;
    check=`Confirm jurisdiction eligibility, issuer, custody and redemption conditions before using ${p.name}`;
  } else if (/insurance/.test(cat)) {
    action=`Compare a documented coverage option and premium before buying any policy through ${p.name}`;
    check=`Read exclusions, coverage dates, claim evidence and cancellation terms before paying ${p.name}`;
  } else if (/stable/.test(cat)) {
    action=`If redemption and reserves are documented, test a conversion of at most $${budget} through ${p.name}`;
    check=`Check the asset issuer, conversion fees, minimums and redemption route before transacting`;
  } else if (/chain/.test(cat)) {
    action=`If you already use ${chain}, make one ordinary low-value transaction with its documented app or wallet`;
    check=`Verify the official chain identifier, native asset and transaction fee before signing`;
  }
  const hold=age===null?30:age<180?45:30;
  return [
    `Find ${p.name}'s official entry point from independent project documentation; compare its domain and chain before connecting. Cost: $0. Time: 5–10 minutes.`,
    `Read current docs for one live, supported workflow; the sealed snapshot proves neither current availability nor incentives. Cost: $0. Time: 10 minutes.`,
    `${action}. Use a separate wallet and only funds you can afford to lose. Cost: up to $${budget} principal plus quoted gas. Time: 10–20 minutes.`,
    `${check}. Save the transaction hash, date, amount and chain locally. Cost: one network fee if onchain. Time: 5 minutes.`,
    `After seven days, repeat only if the product still has a real use for you; do not self-trade or create artificial volume. Cost: quoted fees per action. Time: 5–15 minutes weekly.`,
    `Review exposure, lockups and official eligibility terms around day ${hold}; no points or airdrop is established by these data. Cost: $0. Time: 5 minutes.`,
    `Exit through the documented withdrawal or redemption path if risk, fees or terms change; retain the final transaction record. Cost: exit fee and gas if applicable. Time: 10–20 minutes.`,
  ];
}
interface PeerModel { category: string; peer_count: number; median_mcap_tvl: number; matched_slugs: string[] }
function peerFor(p: SnapshotProtocol, protocols: SnapshotProtocol[], model: ModelConstants): PeerModel {
  // Exclude records without a positive observed market cap and keep exact taxonomy peers first.
  const tokens=protocols.filter(x=>!isPreToken(x) && x.mcap_usd!==null && x.mcap_usd>0 && x.tvl_usd>0);
  const target=categoryKey(p.category);
  const exact=tokens.filter(x=>categoryKey(x.category)===target);
  const firstWord=target.split(/\s+/)[0]!;
  const adjacent=tokens.filter(x=>categoryKey(x.category).split(/\s+/)[0]===firstWord);
  const candidates=exact.length>=3?exact:adjacent.length>=3?adjacent:tokens;
  const ratios=candidates.map(x=>x.mcap_usd!/x.tvl_usd).filter(x=>Number.isFinite(x)&&x>0);
  // A median resists outliers; clamp only the resulting cohort anchor, never each observation.
  const anchor=clamp(median(ratios)||model.global_fallback_multiple,model.peer_multiple_floor,model.peer_multiple_cap);
  const label=exact.length>=3?(p.category||'Other'):adjacent.length>=3?`${firstWord} adjacent categories`:'global tokenized peers';
  return {category:label, peer_count:candidates.length, median_mcap_tvl:anchor, matched_slugs:candidates.slice().sort((a,b)=>a.slug.localeCompare(b.slug)).slice(0,8).map(x=>x.slug)};
}
function score(p: SnapshotProtocol, snap: Snapshot, model: ModelConstants) {
  const age=ageDays(snap.as_of,p.listed_at), peer=peerFor(p,snap.protocols,model);
  const growth=clamp(p.change_7d ?? 0,-60,model.max_growth_pct);
  const growthAdj=clamp(1 + growth/100*model.growth_weight,0.72,1.12);
  const maturity=age===null?0.82:0.78+0.22*(1-Math.exp(-age/540));
  const categoryCount=snap.protocols.filter(x=>categoryKey(x.category)===categoryKey(p.category)).length;
  const competition=clamp(1/Math.sqrt(Math.max(1,categoryCount)/8),0.48,1.15);
  const chainCoverage=clamp(0.88+0.035*Math.min(p.chains.length,4),0.88,1.02);
  const risk=categoryRisk(p.category);
  const scale=clamp(Math.pow(Math.max(p.tvl_usd,1)/100_000_000,0.08),0.78,1.14);
  const implied=round(p.tvl_usd*peer.median_mcap_tvl*growthAdj*maturity*competition*chainCoverage*risk*scale*model.tvl_quality_haircut*model.dilution_haircut);
  const peerConfidence=clamp(peer.peer_count/12,0,1), dataConfidence=(p.change_7d===null?0.78:0.96)*(age===null?0.88:1);
  const confidenceScore=clamp(0.35+0.36*peerConfidence+0.29*dataConfidence,0.25,0.94);
  const uncertainty=clamp(1.15+(1-confidenceScore)*0.65,1.15,1.7);
  return {age,peer,implied:Math.max(1,implied),low:Math.max(1,round(implied/uncertainty)),high:round(implied*uncertainty),confidenceScore,
    confidence:confidenceScore>=0.75?'higher' as const:confidenceScore>=0.55?'moderate' as const:'low' as const,
    adjustments:{growth:round(growthAdj*1000)/1000,maturity:round(maturity*1000)/1000,category_risk:risk,competition:round(competition*1000)/1000,chain_coverage:round(chainCoverage*1000)/1000,tvl_quality:model.tvl_quality_haircut,dilution:model.dilution_haircut}};
}
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index=new Map(snapshot.protocols.map(p=>[p.slug,p]));
  // Watchlist is mandatory coverage, while the same public-field exclusion screen applies to all candidates.
  const chosen=new Map<string,SnapshotProtocol>();
  for(const slug of snapshot.watchlist){ const p=index.get(slug); if(p && isRankable(p)) chosen.set(slug,p); }
  const watchlistExceptions=snapshot.watchlist.filter(s=>!chosen.has(s));
  // Mandatory watchlist rows remain visible with an explicit caveat if the stricter lexical screen flags one.
  for(const slug of watchlistExceptions){const p=index.get(slug); if(p && isPreToken(p)) chosen.set(slug,p);}
  for(const p of snapshot.protocols) if(!chosen.has(p.slug)&&isRankable(p)) chosen.set(p.slug,p);
  const scored=[...chosen.values()].map(p=>({p,s:score(p,snapshot,model)}));
  scored.sort((a,b)=>b.s.implied-a.s.implied || a.p.slug.localeCompare(b.p.slug));
  return scored.map(({p,s},i)=>({rank:i+1,slug:p.slug,name:p.name,category:p.category,chains:p.chains,tvl_usd:p.tvl_usd,change_7d:p.change_7d,mcap_usd:p.mcap_usd,listed_at:p.listed_at,gecko_id:p.gecko_id,symbol:p.symbol,token_status:'no-token-recorded',on_watchlist:snapshot.watchlist.includes(p.slug),age_days:s.age,implied_value_usd:s.implied,estimate_low_usd:s.low,estimate_high_usd:s.high,confidence:s.confidence,confidence_score:round(s.confidenceScore*100),evidence:{snapshot_as_of:snapshot.as_of,tvl_usd:p.tvl_usd,change_7d:p.change_7d,listed_at:p.listed_at,chains:p.chains,peer:{...s.peer},adjustments:s.adjustments},farm_steps:farmSteps(p,s.age)}));
}

/** Live token rows are separated from the implied pre-token board. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols.filter(p=>!isPreToken(p)).sort((a,b)=>(b.mcap_usd??0)-(a.mcap_usd??0)||b.tvl_usd-a.tvl_usd).slice(0,LIVE_ROWS).map(p=>({slug:p.slug,name:p.name,category:p.category,chains:p.chains,tvl_usd:p.tvl_usd,mcap_usd:p.mcap_usd,change_7d:p.change_7d}));
}
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): {board:BoardRow[];radar:RadarData} {
  const board=buildBoard(snapshot,model), live=liveRows(snapshot);
  const radar:RadarData={as_of:snapshot.as_of,source:snapshot.source,floor_usd:snapshot.floor_usd,model,model_version:MODEL_VERSION,watchlist_size:snapshot.watchlist.length,board_size:board.length,early_size:board.filter(r=>!snapshot.watchlist.includes(r.slug)).length,live_size:live.length,rows:board,live,excluded_count:snapshot.protocols.length-board.length-live.length,methodology:['Candidate set: records with null market cap, CoinGecko id and symbol; lexical screen removes exchange products, versioned deployments and explicit wrapped/staked/bridged-product markers. The watchlist is covered in full.','Peer anchor: median positive observed market-cap / TVL among token-bearing records; use at least three exact-category peers, then a first-word adjacent cohort, otherwise all tokenized records. The cohort label, count and stable sample of peer slugs are shown per row.','Estimate: TVL × peer ratio × capped growth × age maturity × category risk × same-category competition × chain breadth × TVL-quality haircut × dilution haircut. TVL quality and future supply are absent from the snapshot, so conservative disclosed haircuts (0.82 and 0.72) are applied uniformly.','Range is a model sensitivity band, not a statistical forecast interval. Confidence reflects peer count and available age / growth fields. No token launch, points program or airdrop is asserted.']};
  return {board,radar};
}
export function parseSnapshot(text:string):Snapshot {
 let raw:unknown; try{raw=JSON.parse(text)}catch{throw new SnapshotError('snapshot.json is not JSON')}
 if(typeof raw!=='object'||!raw||Array.isArray(raw))throw new SnapshotError('snapshot.json is not an object');
 const o=raw as Record<string,unknown>; if(typeof o.as_of!=='string'||typeof o.source!=='string'||typeof o.floor_usd!=='number'||!Array.isArray(o.protocols)||!Array.isArray(o.watchlist))throw new SnapshotError('snapshot.json is missing required fields');
 const protocols=(o.protocols as any[]).map((p,i)=>{if(!p||typeof p.slug!=='string'||typeof p.name!=='string'||typeof p.tvl_usd!=='number')throw new SnapshotError(`invalid protocol ${i}`);return {slug:p.slug,name:p.name,category:typeof p.category==='string'?p.category:null,chains:Array.isArray(p.chains)?p.chains.filter((x:any)=>typeof x==='string'):[],tvl_usd:p.tvl_usd,change_7d:typeof p.change_7d==='number'?p.change_7d:null,mcap_usd:typeof p.mcap_usd==='number'?p.mcap_usd:null,listed_at:typeof p.listed_at==='string'?p.listed_at:null,gecko_id:typeof p.gecko_id==='string'?p.gecko_id:null,symbol:typeof p.symbol==='string'?p.symbol:null};});
 return {as_of:o.as_of,source:o.source,floor_usd:o.floor_usd,protocols,watchlist:o.watchlist as string[]};
}
export function boardIssue(board:BoardRow[],snapshot:Snapshot):string|null {
 const index=new Map(snapshot.protocols.map(p=>[p.slug,p]));
 const slugs=new Set(board.map(r=>r.slug)), missing=snapshot.watchlist.filter(s=>!slugs.has(s)); if(missing.length)return `missing watchlist: ${missing.slice(0,5).join(', ')}`;
 if(board.length<100||board.length>4000)return `invalid row count ${board.length}`;
 if(slugs.size!==board.length)return 'duplicate protocol slug';
 for(let i=0;i<board.length;i++){
  const r=board[i]!,p=index.get(r.slug);if(!p)return `unknown protocol ${r.slug}`;
  const coverageException=snapshot.watchlist.includes(r.slug)&&isPreToken(p);
  if(!isRankable(p)&&!coverageException)return `ineligible protocol ${r.slug}: ${exclusionReason(p)}`;
  if(r.on_watchlist!==snapshot.watchlist.includes(r.slug))return `watchlist flag mismatch for ${r.slug}`;
  if(r.rank!==i+1)return `rank mismatch at ${i}`;
  if(i&&(r.implied_value_usd>board[i-1]!.implied_value_usd||r.implied_value_usd===board[i-1]!.implied_value_usd&&r.slug.localeCompare(board[i-1]!.slug)<0))return `value order at ${i}`;
  if(r.farm_steps.length<3||r.farm_steps.length>12||r.farm_steps.some(x=>x.trim().length<20||x.trim().length>600))return `farm plan invalid for ${r.slug}`;
  if(!Number.isSafeInteger(r.implied_value_usd)||r.implied_value_usd<=0||r.implied_value_usd>100_000_000_000_000)return `value invalid for ${r.slug}`;
  if(!Number.isSafeInteger(r.estimate_low_usd)||!Number.isSafeInteger(r.estimate_high_usd)||r.estimate_low_usd<=0||r.estimate_low_usd>r.implied_value_usd||r.estimate_high_usd<r.implied_value_usd)return `estimate range invalid for ${r.slug}`;
 }
 return null;
}
export function dataScript(radar:RadarData):string{return `window.RADAR=${JSON.stringify(radar)};\n`;}
[exit status 0]