
export const SAMPLE_LABEL = "cached sample, not live";

interface SampleFact {
  start?: string;
  end: string;
  val: number;
  fy: number;
  fp: string;
  form: string;
  filed: string;
}

interface SampleCompany {
  submissions: {
    cik: string;
    name: string;
    tickers: string[];
    filings: { recent: { accessionNumber: string[]; filingDate: string[]; reportDate: string[]; form: string[]; primaryDocument: string[] } };
  };
  facts: { cik: number; entityName: string; facts: { "us-gaap": Record<string, { label: string; units: { USD: SampleFact[] } }> } };
}

const M = 1_000_000;

function filings(rows: [form: string, filed: string, report: string][]): SampleCompany["submissions"]["filings"] {
  return {
    recent: {
      accessionNumber: rows.map(() => ""),
      filingDate: rows.map((r) => r[1]),
      reportDate: rows.map((r) => r[2]),
      form: rows.map((r) => r[0]),
      primaryDocument: rows.map(() => ""),
    },
  };
}

const annual = (rows: [start: string, end: string, val: number, fy: number, filed: string][]): SampleFact[] =>
  rows.map(([start, end, val, fy, filed]) => ({ start, end, val, fy, fp: "FY", form: "10-K", filed }));
const instant = (rows: [end: string, val: number, fy: number, filed: string][]): SampleFact[] =>
  rows.map(([end, val, fy, filed]) => ({ end, val, fy, fp: "FY", form: "10-K", filed }));

export const SEC_SAMPLES: Record<string, SampleCompany> = {
  AAPL: {
    submissions: {
      cik: "320193",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      filings: filings([
        ["10-K", "2025-10-31", "2025-09-27"],
        ["8-K", "2025-10-30", "2025-10-30"],
        ["10-Q", "2025-08-01", "2025-06-28"],
        ["8-K", "2025-07-31", "2025-07-31"],
        ["10-Q", "2025-05-02", "2025-03-29"],
        ["10-Q", "2025-01-31", "2024-12-28"],
        ["10-K", "2024-11-01", "2024-09-28"],
      ]),
    },
    facts: {
      cik: 320193,
      entityName: "Apple Inc.",
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            label: "Revenue from Contract with Customer, Excluding Assessed Tax",
            units: {
              USD: annual([
                ["2020-09-27", "2021-09-25", 365_817 * M, 2021, "2021-10-29"],
                ["2021-09-26", "2022-09-24", 394_328 * M, 2022, "2022-10-28"],
                ["2022-09-25", "2023-09-30", 383_285 * M, 2023, "2023-11-03"],
                ["2023-10-01", "2024-09-28", 391_035 * M, 2024, "2024-11-01"],
                ["2024-09-29", "2025-09-27", 416_161 * M, 2025, "2025-10-31"],
              ]),
            },
          },
          NetIncomeLoss: {
            label: "Net Income (Loss) Attributable to Parent",
            units: {
              USD: annual([
                ["2020-09-27", "2021-09-25", 94_680 * M, 2021, "2021-10-29"],
                ["2021-09-26", "2022-09-24", 99_803 * M, 2022, "2022-10-28"],
                ["2022-09-25", "2023-09-30", 96_995 * M, 2023, "2023-11-03"],
                ["2023-10-01", "2024-09-28", 93_736 * M, 2024, "2024-11-01"],
                ["2024-09-29", "2025-09-27", 112_010 * M, 2025, "2025-10-31"],
              ]),
            },
          },
          Assets: {
            label: "Assets",
            units: { USD: instant([["2023-09-30", 352_583 * M, 2023, "2023-11-03"], ["2024-09-28", 364_980 * M, 2024, "2024-11-01"], ["2025-09-27", 359_241 * M, 2025, "2025-10-31"]]) },
          },
          Liabilities: {
            label: "Liabilities",
            units: { USD: instant([["2023-09-30", 290_437 * M, 2023, "2023-11-03"], ["2024-09-28", 308_030 * M, 2024, "2024-11-01"], ["2025-09-27", 285_508 * M, 2025, "2025-10-31"]]) },
          },
          CashAndCashEquivalentsAtCarryingValue: {
            label: "Cash and Cash Equivalents, at Carrying Value",
            units: { USD: instant([["2023-09-30", 29_965 * M, 2023, "2023-11-03"], ["2024-09-28", 29_943 * M, 2024, "2024-11-01"], ["2025-09-27", 35_934 * M, 2025, "2025-10-31"]]) },
          },
        },
      },
    },
  },
  MSFT: {
    submissions: {
      cik: "789019",
      name: "MICROSOFT CORP",
      tickers: ["MSFT"],
      filings: filings([
        ["10-Q", "2025-10-29", "2025-09-30"],
        ["8-K", "2025-10-29", "2025-10-29"],
        ["10-K", "2025-07-30", "2025-06-30"],
        ["8-K", "2025-07-30", "2025-07-30"],
        ["10-Q", "2025-04-30", "2025-03-31"],
        ["10-Q", "2025-01-29", "2024-12-31"],
        ["10-K", "2024-07-30", "2024-06-30"],
      ]),
    },
    facts: {
      cik: 789019,
      entityName: "MICROSOFT CORPORATION",
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            label: "Revenue from Contract with Customer, Excluding Assessed Tax",
            units: {
              USD: annual([
                ["2020-07-01", "2021-06-30", 168_088 * M, 2021, "2021-07-29"],
                ["2021-07-01", "2022-06-30", 198_270 * M, 2022, "2022-07-28"],
                ["2022-07-01", "2023-06-30", 211_915 * M, 2023, "2023-07-27"],
                ["2023-07-01", "2024-06-30", 245_122 * M, 2024, "2024-07-30"],
                ["2024-07-01", "2025-06-30", 281_724 * M, 2025, "2025-07-30"],
              ]),
            },
          },
          NetIncomeLoss: {
            label: "Net Income (Loss) Attributable to Parent",
            units: {
              USD: annual([
                ["2020-07-01", "2021-06-30", 61_271 * M, 2021, "2021-07-29"],
                ["2021-07-01", "2022-06-30", 72_738 * M, 2022, "2022-07-28"],
                ["2022-07-01", "2023-06-30", 72_361 * M, 2023, "2023-07-27"],
                ["2023-07-01", "2024-06-30", 88_136 * M, 2024, "2024-07-30"],
                ["2024-07-01", "2025-06-30", 101_832 * M, 2025, "2025-07-30"],
              ]),
            },
          },
          Assets: {
            label: "Assets",
            units: { USD: instant([["2023-06-30", 411_976 * M, 2023, "2023-07-27"], ["2024-06-30", 512_163 * M, 2024, "2024-07-30"], ["2025-06-30", 619_003 * M, 2025, "2025-07-30"]]) },
          },
          Liabilities: {
            label: "Liabilities",
            units: { USD: instant([["2023-06-30", 205_753 * M, 2023, "2023-07-27"], ["2024-06-30", 243_686 * M, 2024, "2024-07-30"], ["2025-06-30", 275_524 * M, 2025, "2025-07-30"]]) },
          },
          CashAndCashEquivalentsAtCarryingValue: {
            label: "Cash and Cash Equivalents, at Carrying Value",
            units: { USD: instant([["2023-06-30", 34_704 * M, 2023, "2023-07-27"], ["2024-06-30", 18_315 * M, 2024, "2024-07-30"], ["2025-06-30", 30_242 * M, 2025, "2025-07-30"]]) },
          },
        },
      },
    },
  },
};
