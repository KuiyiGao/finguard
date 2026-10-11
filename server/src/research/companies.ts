
export interface Company {
  ticker: string;
  cik: string;
  name: string;
  aliases: string[];
  cfpb?: string;
  fdic?: string;
}

const c = (ticker: string, cik: number, name: string, aliases: string[], extra: Partial<Company> = {}): Company => ({
  ticker,
  cik: String(cik).padStart(10, "0"),
  name,
  aliases,
  ...extra,
});

export const COMPANIES: Company[] = [
  c("AAPL", 320193, "Apple Inc.", ["apple"]),
  c("MSFT", 789019, "Microsoft Corp", ["microsoft"]),
  c("AMZN", 1018724, "Amazon.com, Inc.", ["amazon"]),
  c("GOOGL", 1652044, "Alphabet Inc.", ["alphabet", "google"]),
  c("META", 1326801, "Meta Platforms, Inc.", ["meta", "facebook"]),
  c("NVDA", 1045810, "NVIDIA Corp", ["nvidia"]),
  c("TSLA", 1318605, "Tesla, Inc.", ["tesla"]),
  c("BRK-B", 1067983, "Berkshire Hathaway Inc", ["berkshire", "berkshire hathaway"]),
  c("JPM", 19617, "JPMorgan Chase & Co", ["jpmorgan", "jp morgan", "chase", "jpmorgan chase"], { cfpb: "JPMorgan Chase", fdic: "JPMorgan Chase Bank" }),
  c("BAC", 70858, "Bank of America Corp", ["bank of america", "bofa"], { cfpb: "Bank of America", fdic: "Bank of America" }),
  c("WFC", 72971, "Wells Fargo & Company", ["wells fargo"], { cfpb: "Wells Fargo", fdic: "Wells Fargo Bank" }),
  c("C", 831001, "Citigroup Inc", ["citigroup", "citi", "citibank"], { cfpb: "Citibank", fdic: "Citibank" }),
  c("COF", 927628, "Capital One Financial Corp", ["capital one"], { cfpb: "Capital One", fdic: "Capital One" }),
  c("GS", 886982, "Goldman Sachs Group Inc", ["goldman", "goldman sachs"], { cfpb: "Goldman Sachs", fdic: "Goldman Sachs Bank" }),
  c("V", 1403161, "Visa Inc.", ["visa"]),
  c("MA", 1141391, "Mastercard Inc", ["mastercard"]),
  c("WMT", 104169, "Walmart Inc.", ["walmart"]),
  c("JNJ", 200406, "Johnson & Johnson", ["johnson & johnson", "johnson and johnson"]),
  c("PG", 80424, "Procter & Gamble Co", ["procter & gamble", "procter and gamble", "p&g"]),
  c("XOM", 34088, "Exxon Mobil Corp", ["exxon", "exxonmobil", "exxon mobil"]),
  c("KO", 21344, "Coca-Cola Co", ["coca-cola", "coca cola", "coke"]),
  c("NFLX", 1065280, "Netflix, Inc.", ["netflix"]),
  c("COST", 909832, "Costco Wholesale Corp", ["costco"]),
  c("DIS", 1744489, "Walt Disney Co", ["disney", "walt disney"]),
];

const BY_TICKER = new Map(COMPANIES.map((x) => [x.ticker, x]));

export function normalizeTicker(raw: unknown): string {
  const t = String(raw ?? "").trim().toUpperCase().replace(/\./g, "-");
  return /^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(t) ? t : "";
}

export function companyByTicker(ticker: string): Company | undefined {
  return BY_TICKER.get(normalizeTicker(ticker));
}

const NOT_TICKERS = new Set(["I", "A", "AN", "THE", "IS", "IT", "HOW", "WHAT", "SEC", "FDIC", "CFPB", "OK", "US", "USA", "AND", "OR", "OF", "ON", "IN", "DO", "MY", "ME", "AM", "PM", "ET", "Q", "FY", "EPS", "CEO", "ETF", "IRA", "APR", "APY"]);

export function findCompany(text: string): Company | undefined {
  const dollar = text.match(/\$([A-Za-z]{1,5}(?:[.-][A-Za-z]{1,2})?)\b/);
  if (dollar) {
    const hit = companyByTicker(dollar[1]!);
    if (hit) return hit;
  }
  for (const m of text.matchAll(/\b[A-Z]{1,5}(?:[.-][A-Z]{1,2})?\b/g)) {
    if (NOT_TICKERS.has(m[0])) continue;
    const hit = companyByTicker(m[0]);
    if (hit) return hit;
  }
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9&.\- ]+/g, " ").replace(/[.](?=\s|$)/g, " ").replace(/\s+/g, " ")} `;
  let best: { company: Company; length: number } | undefined;
  for (const company of COMPANIES)
    for (const alias of company.aliases)
      if (lower.includes(` ${alias} `) && (!best || alias.length > best.length)) best = { company, length: alias.length };
  if (best) return best.company;
  for (const word of lower.trim().split(" ")) {
    const hit = word.length >= 3 ? companyByTicker(word) : undefined;
    if (hit) return hit;
  }
  return undefined;
}
