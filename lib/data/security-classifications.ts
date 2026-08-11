/**
 * Static classification lookup for ETFs, mutual funds, leveraged products,
 * and well-known securities. Used by the classification engine as the primary
 * source for fund-level data that TWS/EDGAR can't provide (e.g., ETF category,
 * geography, style).
 *
 * For individual stocks, we store GICS sector mappings here as well. TWS
 * enrichment provides more granular sector/industry data, but this serves as
 * a reliable fallback.
 */

export interface SecurityClassification {
  fund_category: string;
  geography: string;
  market_cap_category?: string;
  style?: string;
  /** Also fix security_type if misclassified */
  fix_security_type?: string;
}

/**
 * Lookup keyed by symbol. Covers widely-held ETFs, mutual funds, and
 * well-known securities so classification works out of the box.
 *
 * Categories follow Morningstar-style taxonomy:
 * - Equity: "US Large Cap Equity", "US Small Cap Equity", "International Developed Equity", etc.
 * - Fixed Income: "US Aggregate Bond", "US Treasury", "TIPS", "Emerging Markets Bond", etc.
 * - Alternatives: "Real Estate", "Commodities", "Leveraged/Inverse"
 * - Cash: "Cash Equivalent"
 */
export const SECURITY_CLASSIFICATIONS: Record<string, SecurityClassification> = {
  // ─── Vanguard ETFs ──────────────────────────────────────────────

  VTI:  { fund_category: "US Total Market Equity", geography: "US", market_cap_category: "Multi-Cap", style: "Blend" },
  VEU:  { fund_category: "International Equity", geography: "International Developed", market_cap_category: "Multi-Cap", style: "Blend" },
  VHT:  { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  VGT:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  VDC:  { fund_category: "US Sector Equity (Consumer Staples)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  VIS:  { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  VNQ:  { fund_category: "Real Estate", geography: "US", market_cap_category: "Multi-Cap", style: "Blend" },
  VPL:  { fund_category: "International Equity", geography: "Asia Pacific", market_cap_category: "Multi-Cap", style: "Blend" },
  VPU:  { fund_category: "US Sector Equity (Utilities)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },

  // ─── Vanguard Mutual Funds ──────────────────────────────────────

  VFIAX: { fund_category: "US Large Cap Equity", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  VEXPX: { fund_category: "US Small Cap Equity", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  VHGEX: { fund_category: "Global Equity", geography: "Global", market_cap_category: "Multi-Cap", style: "Blend" },
  VQNPX: { fund_category: "US Large Cap Equity", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  VVIAX: { fund_category: "US Large Cap Equity", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  VSMAX: { fund_category: "US Small Cap Equity", geography: "US", market_cap_category: "Small Cap", style: "Blend" },
  VCORX: { fund_category: "US Aggregate Bond", geography: "US" },
  VEMBX: { fund_category: "Emerging Markets Bond", geography: "Emerging Markets" },
  VIPSX: { fund_category: "TIPS", geography: "US" },
  VMBSX: { fund_category: "US Mortgage-Backed Securities", geography: "US" },
  VUBFX: { fund_category: "US Ultra-Short Bond", geography: "US" },

  // ─── Money Market Funds (misclassified as "stock") ──────────────

  VMFXX: { fund_category: "Cash Equivalent", geography: "US", fix_security_type: "money_market" },
  VFFXX: { fund_category: "Cash Equivalent", geography: "US", fix_security_type: "money_market" },
  VFMXX: { fund_category: "Cash Equivalent", geography: "US", fix_security_type: "money_market" },
  "VANGUARD FEDERAL MONEY MARKET FUND": { fund_category: "Cash Equivalent", geography: "US", fix_security_type: "money_market" },

  // ─── iShares / BlackRock ETFs ───────────────────────────────────

  ACWV: { fund_category: "Global Equity", geography: "Global", market_cap_category: "Multi-Cap", style: "Blend" },
  EEMV: { fund_category: "Emerging Markets Equity", geography: "Emerging Markets", market_cap_category: "Multi-Cap", style: "Blend" },
  EIS:  { fund_category: "International Equity", geography: "Israel", market_cap_category: "Multi-Cap", style: "Blend" },
  EWJ:  { fund_category: "International Equity", geography: "Japan", market_cap_category: "Multi-Cap", style: "Blend" },
  EWU:  { fund_category: "International Equity", geography: "United Kingdom", market_cap_category: "Multi-Cap", style: "Blend" },
  IDEV: { fund_category: "International Developed Equity", geography: "International Developed", market_cap_category: "Multi-Cap", style: "Blend" },
  INDA: { fund_category: "Emerging Markets Equity", geography: "India", market_cap_category: "Multi-Cap", style: "Blend" },

  // ─── State Street / SPDR ETFs ───────────────────────────────────

  SPY:  { fund_category: "US Large Cap Equity", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  XLV:  { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  XLK:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  XLU:  { fund_category: "US Sector Equity (Utilities)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  XRT:  { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Multi-Cap", style: "Blend" },
  XHB:  { fund_category: "US Sector Equity (Real Estate/Homebuilders)", geography: "US", market_cap_category: "Multi-Cap", style: "Blend" },
  SPTL: { fund_category: "US Long-Term Treasury", geography: "US" },

  // ─── Other ETFs ─────────────────────────────────────────────────

  QQQ:  { fund_category: "US Large Cap Equity", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  IWM:  { fund_category: "US Small Cap Equity", geography: "US", market_cap_category: "Small Cap", style: "Blend" },
  RSP:  { fund_category: "US Large Cap Equity", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  SMH:  { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  BBH:  { fund_category: "US Sector Equity (Health Care/Biotech)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  METV: { fund_category: "US Thematic Equity (Metaverse)", geography: "US", market_cap_category: "Multi-Cap", style: "Growth" },
  LTPZ: { fund_category: "TIPS", geography: "US" },
  TLT:  { fund_category: "US Long-Term Treasury", geography: "US" },
  TBT:  { fund_category: "Leveraged/Inverse", geography: "US" },
  ARKK: { fund_category: "US Thematic Equity (Innovation)", geography: "US", market_cap_category: "Multi-Cap", style: "Growth" },
  ARKF: { fund_category: "US Thematic Equity (Fintech)", geography: "US", market_cap_category: "Multi-Cap", style: "Growth" },
  JETS: { fund_category: "US Sector Equity (Airlines)", geography: "US", market_cap_category: "Multi-Cap", style: "Blend" },
  KRE:  { fund_category: "US Sector Equity (Regional Banks)", geography: "US", market_cap_category: "Multi-Cap", style: "Blend" },
  KWEB: { fund_category: "China Equity", geography: "China", market_cap_category: "Multi-Cap", style: "Growth" },
  MAGS: { fund_category: "US Large Cap Equity (Mega-Cap Tech)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  SARK: { fund_category: "Leveraged/Inverse", geography: "US" },
  IGV:  { fund_category: "US Sector Equity (Software)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  SPHB: { fund_category: "US Large Cap Equity (High Beta)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },

  // ─── Leveraged / Inverse Products ───────────────────────────────

  TQQQ: { fund_category: "Leveraged/Inverse", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  SQQQ: { fund_category: "Leveraged/Inverse", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  FNGU: { fund_category: "Leveraged/Inverse", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  SDOW: { fund_category: "Leveraged/Inverse", geography: "US", market_cap_category: "Large Cap" },
  TNA:  { fund_category: "Leveraged/Inverse", geography: "US", market_cap_category: "Small Cap" },
  TSLQ: { fund_category: "Leveraged/Inverse", geography: "US", market_cap_category: "Large Cap" },
  UDOW: { fund_category: "Leveraged/Inverse", geography: "US", market_cap_category: "Large Cap" },
  UCO:  { fund_category: "Leveraged/Inverse (Commodities)", geography: "Global" },
  USO:  { fund_category: "Commodities (Oil)", geography: "Global" },

  // ─── Individual Stocks — US Mega/Large Cap Tech ─────────────────

  AAPL: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  MSFT: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  GOOG: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  GOOGL: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  AMZN: { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  META: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  NVDA: { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  AVGO: { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  TSLA: { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  NFLX: { fund_category: "US Sector Equity (Communication Services)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  CRM:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  ORCL: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  INTU: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  QCOM: { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  AMD:  { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  INTC: { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  MU:   { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },

  // ─── US Large Cap — Financial ───────────────────────────────────

  JPM:  { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  GS:   { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  BAC:  { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  V:    { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  MA:   { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  "BRK/B": { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  COIN: { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },

  // ─── US Large Cap — Health Care ─────────────────────────────────

  UNH:  { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  VRTX: { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  LIN:  { fund_category: "US Sector Equity (Materials)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  DHR:  { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },

  // ─── US Large Cap — Industrials/Energy/Other ────────────────────

  HD:   { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  ACN:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  XOM:  { fund_category: "US Sector Equity (Energy)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  VLO:  { fund_category: "US Sector Equity (Energy)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  CEG:  { fund_category: "US Sector Equity (Utilities)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  VST:  { fund_category: "US Sector Equity (Utilities)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  KO:   { fund_category: "US Sector Equity (Consumer Staples)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  NKE:  { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  NSC:  { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  CSX:  { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  PLD:  { fund_category: "Real Estate", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  UBER: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  TGT:  { fund_category: "US Sector Equity (Consumer Staples)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  HPQ:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  KR:   { fund_category: "US Sector Equity (Consumer Staples)", geography: "US", market_cap_category: "Large Cap", style: "Value" },

  // ─── US Mid/Small Cap Tech ──────────────────────────────────────

  DDOG: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  SNOW: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  NET:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  PLTR: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  SPOT: { fund_category: "US Sector Equity (Communication Services)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  SNAP: { fund_category: "US Sector Equity (Communication Services)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  PINS: { fund_category: "US Sector Equity (Communication Services)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  RDDT: { fund_category: "US Sector Equity (Communication Services)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  TTD:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  DBX:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  GTLB: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  U:    { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  RBLX: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  WIX:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  HIMS: { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  TDOC: { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  OSCR: { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  OCUL: { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  HOOD: { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  AFRM: { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  CVNA: { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  SHOP: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  PSTG: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  VRT:  { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  PWR:  { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  PRIM: { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  XPO:  { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  APP:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },

  // ─── US Smaller / Specialty ─────────────────────────────────────

  ABNB: { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  CPRT: { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  CSGP: { fund_category: "US Sector Equity (Real Estate/Technology)", geography: "US", market_cap_category: "Large Cap", style: "Growth" },
  DKNG: { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  DIS:  { fund_category: "US Sector Equity (Communication Services)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  ET:   { fund_category: "US Sector Equity (Energy)", geography: "US", market_cap_category: "Large Cap", style: "Value" },
  FOR:  { fund_category: "US Sector Equity (Real Estate/Homebuilders)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  GPRO: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  GFL:  { fund_category: "US Sector Equity (Industrials)", geography: "Canada", market_cap_category: "Large Cap", style: "Growth" },
  IMAX: { fund_category: "US Sector Equity (Communication Services)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  JEF:  { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Mid Cap", style: "Blend" },
  KVYO: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  LAND: { fund_category: "Real Estate", geography: "US", market_cap_category: "Small Cap", style: "Value" },
  LITE: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  MP:   { fund_category: "US Sector Equity (Materials)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  OKLO: { fund_category: "US Sector Equity (Utilities/Nuclear)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  OPEN: { fund_category: "US Sector Equity (Real Estate/Technology)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  PAYC: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  PCTY: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  RH:   { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  RKT:  { fund_category: "US Sector Equity (Financial)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  REAL: { fund_category: "US Sector Equity (Consumer Discretionary)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  RGTI: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  SPHR: { fund_category: "US Sector Equity (Communication Services)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  STNG: { fund_category: "US Sector Equity (Energy)", geography: "US", market_cap_category: "Mid Cap", style: "Value" },
  TER:  { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Large Cap", style: "Blend" },
  TTMI: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Blend" },
  RMBS: { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  AMKR: { fund_category: "US Sector Equity (Semiconductors)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  CLH:  { fund_category: "US Sector Equity (Industrials)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  APPN: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  CIEN: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },
  ESTA: { fund_category: "US Sector Equity (Health Care)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  HPP:  { fund_category: "Real Estate", geography: "US", market_cap_category: "Small Cap", style: "Value" },
  HUN:  { fund_category: "US Sector Equity (Materials)", geography: "US", market_cap_category: "Mid Cap", style: "Value" },
  CPT:  { fund_category: "Real Estate", geography: "US", market_cap_category: "Mid Cap", style: "Blend" },
  KRC:  { fund_category: "Real Estate", geography: "US", market_cap_category: "Mid Cap", style: "Value" },
  CLPR: { fund_category: "Real Estate", geography: "US", market_cap_category: "Small Cap", style: "Value" },
  DHT:  { fund_category: "US Sector Equity (Energy)", geography: "US", market_cap_category: "Small Cap", style: "Value" },
  DJT:  { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Small Cap", style: "Growth" },
  HHH:  { fund_category: "Real Estate", geography: "US", market_cap_category: "Mid Cap", style: "Growth" },

  // ─── International Stocks ───────────────────────────────────────

  TSM:  { fund_category: "International Equity", geography: "Taiwan", market_cap_category: "Large Cap", style: "Growth" },
  ASML: { fund_category: "International Equity", geography: "Netherlands", market_cap_category: "Large Cap", style: "Growth" },
  BABA: { fund_category: "China Equity", geography: "China", market_cap_category: "Large Cap", style: "Value" },
  BIDU: { fund_category: "China Equity", geography: "China", market_cap_category: "Large Cap", style: "Value" },
  PDD:  { fund_category: "China Equity", geography: "China", market_cap_category: "Large Cap", style: "Growth" },
  TCEHY: { fund_category: "China Equity", geography: "China", market_cap_category: "Large Cap", style: "Growth" },
  MELI: { fund_category: "International Equity", geography: "Latin America", market_cap_category: "Large Cap", style: "Growth" },
  GRAB: { fund_category: "International Equity", geography: "Southeast Asia", market_cap_category: "Mid Cap", style: "Growth" },
  MC:   { fund_category: "International Equity", geography: "France", market_cap_category: "Large Cap", style: "Growth" },
  GLXY: { fund_category: "International Equity", geography: "Canada", market_cap_category: "Mid Cap", style: "Growth" },
  AKAM: { fund_category: "US Sector Equity (Technology)", geography: "US", market_cap_category: "Mid Cap", style: "Blend" },
};

