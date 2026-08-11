import ExcelJS from 'exceljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '..', 'deliverables', 'kelly-criterion-calculator.xlsx');

const wb = new ExcelJS.Workbook();
wb.creator = 'Kelly Calculator';
wb.created = new Date();

const ws = wb.addWorksheet('Kelly Calculator');

ws.columns = [
  { width: 44 },
  { width: 18 },
  { width: 62 },
];

const bold = { bold: true };
const header = { bold: true, size: 14 };
const sectionHeader = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
const sectionFill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF305496' },
};
const helperFill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF548235' },
};
const calloutFill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFE699' },
};
const inputFill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFF2CC' },
};
const outputFill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE2EFDA' },
};
const noteItalic = { italic: true, color: { argb: 'FF595959' } };

// ============================================================
// MAIN KELLY BLOCK (unchanged from task #25)
// ============================================================

// Title
ws.mergeCells('A1:C1');
const title = ws.getCell('A1');
title.value = 'Kelly Criterion Position-Sizing Calculator';
title.font = header;
title.alignment = { horizontal: 'left' };

// Inputs section
ws.mergeCells('A3:C3');
const inSec = ws.getCell('A3');
inSec.value = 'INPUTS';
inSec.font = sectionHeader;
inSec.fill = sectionFill;

const inputs = [
  ['Starting portfolio value ($)', 10000, '"$"#,##0.00'],
  ['Max gain from trade ($)', 500, '"$"#,##0.00'],
  ['Max loss from trade ($)', 200, '"$"#,##0.00'],
  ['Win probability (decimal 0–1)', 0.55, '0.00'],
  ['Kelly fraction multiplier (1=full, 0.5=half, 0.25=quarter)', 0.5, '0.00'],
];

inputs.forEach((row, i) => {
  const r = 4 + i;
  ws.getCell(`A${r}`).value = row[0];
  ws.getCell(`A${r}`).font = bold;
  ws.getCell(`B${r}`).value = row[1];
  ws.getCell(`B${r}`).numFmt = row[2];
  ws.getCell(`B${r}`).fill = inputFill;
});

// Outputs section
ws.mergeCells('A10:C10');
const outSec = ws.getCell('A10');
outSec.value = 'OUTPUTS';
outSec.font = sectionHeader;
outSec.fill = sectionFill;

// Cell refs:
// B4 portfolio, B5 gain, B6 loss, B7 prob, B8 multiplier
const outputs = [
  {
    row: 11,
    label: 'Payoff ratio b ( = max gain / max loss )',
    formula:
      'IF(B6<=0,"Error: max loss must be > 0",IF(B5<=0,"Error: max gain must be > 0",B5/B6))',
    numFmt: '0.0000',
  },
  {
    row: 12,
    label: 'Full Kelly fraction f* ( = (b·p − q) / b, clamped at 0 )',
    formula:
      'IF(OR(B7<0,B7>1),"Error: probability must be between 0 and 1",IF(B6<=0,"Error: max loss must be > 0",IF(B5<=0,"Error: max gain must be > 0",MAX(0,((B5/B6)*B7-(1-B7))/(B5/B6)))))',
    numFmt: '0.0000',
  },
  {
    row: 13,
    label: 'Adjusted Kelly ( = f* × multiplier )',
    formula: 'IF(ISNUMBER(B12),B12*B8,B12)',
    numFmt: '0.0000',
  },
  {
    row: 14,
    label: '% of portfolio to allocate (capital at risk)',
    formula:
      'IF(ISNUMBER(B13),IF(B13<=0,"Do not take trade",B13),B13)',
    numFmt: '0.00%',
  },
  {
    row: 15,
    label: '$ amount to risk on this trade',
    formula:
      'IF(ISNUMBER(B13),IF(B13<=0,0,B13*B4),B13)',
    numFmt: '"$"#,##0.00',
  },
];

outputs.forEach((o) => {
  ws.getCell(`A${o.row}`).value = o.label;
  ws.getCell(`A${o.row}`).font = bold;
  const cell = ws.getCell(`B${o.row}`);
  cell.value = { formula: o.formula };
  cell.numFmt = o.numFmt;
  cell.fill = outputFill;
});

// Note
ws.mergeCells('A17:C17');
ws.getCell('A17').value = 'NOTES';
ws.getCell('A17').font = sectionHeader;
ws.getCell('A17').fill = sectionFill;

const notes = [
  '"% to allocate" represents CAPITAL AT RISK — the dollar amount you would lose if your max-loss is hit.',
  'For stop-loss-based trades, position size ≠ risk amount. Example: risking $250 with a 5% stop means a $5,000 position.',
  'Assumes a binary win/loss outcome with the given probability. Does not account for correlated bets or continuous outcomes.',
  'Negative edge (Kelly < 0) shows "Do not take trade" — the math says skip it.',
  'Use the multiplier (cell B8) to apply fractional Kelly. Half-Kelly (0.5) is a common conservative default.',
];

notes.forEach((n, i) => {
  const r = 18 + i;
  ws.mergeCells(`A${r}:C${r}`);
  const c = ws.getCell(`A${r}`);
  c.value = '• ' + n;
  c.font = noteItalic;
  c.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(r).height = 30;
});

// ============================================================
// HELPER 1 — STOP-LOSS POSITION SIZER (rows 24–31)
// ============================================================

ws.mergeCells('A24:C24');
const h1 = ws.getCell('A24');
h1.value = 'HELPER 1 — STOP-LOSS POSITION SIZER (long stock with a stop)';
h1.font = sectionHeader;
h1.fill = helperFill;

// Inputs
const h1Inputs = [
  ['Entry price ($/share)', 50, '"$"#,##0.00'],
  ['Stop price ($/share)', 48, '"$"#,##0.00'],
];
h1Inputs.forEach((row, i) => {
  const r = 25 + i;
  ws.getCell(`A${r}`).value = row[0];
  ws.getCell(`A${r}`).font = bold;
  ws.getCell(`B${r}`).value = row[1];
  ws.getCell(`B${r}`).numFmt = row[2];
  ws.getCell(`B${r}`).fill = inputFill;
});

// Outputs (B25 entry, B26 stop; pulls B15 from main block as Kelly $ risk)
const h1Outputs = [
  {
    row: 27,
    label: 'Risk per share ( = entry − stop )',
    formula: 'IF(B26>=B25,"Error: stop must be below entry",B25-B26)',
    numFmt: '"$"#,##0.00',
  },
  {
    row: 28,
    label: 'Recommended shares ( = Kelly $ risk ÷ risk per share, floored )',
    formula:
      'IF(NOT(ISNUMBER(B27)),B27,IF(B27<=0,"Error: risk per share must be > 0",IF(NOT(ISNUMBER(B15)),"Error: main Kelly $ risk (B15) is not a number",FLOOR(B15/B27,1))))',
    numFmt: '#,##0',
  },
  {
    row: 29,
    label: 'Capital deployed ( = shares × entry )',
    formula: 'IF(ISNUMBER(B28),B28*B25,B28)',
    numFmt: '"$"#,##0.00',
  },
];
h1Outputs.forEach((o) => {
  ws.getCell(`A${o.row}`).value = o.label;
  ws.getCell(`A${o.row}`).font = bold;
  const cell = ws.getCell(`B${o.row}`);
  cell.value = { formula: o.formula };
  cell.numFmt = o.numFmt;
  cell.fill = outputFill;
});

// Note
ws.mergeCells('A30:C30');
const h1Note = ws.getCell('A30');
h1Note.value =
  '• Capital deployed (B29) is typically much larger than the Kelly $ risk (B15) — that is expected. Kelly sizes the loss you accept, not the position itself.';
h1Note.font = noteItalic;
h1Note.alignment = { wrapText: true, vertical: 'top' };
ws.getRow(30).height = 30;

// ============================================================
// HELPER 2 — SCENARIO MAX-LOSS OVERRIDE (rows 32–44)
// ============================================================

ws.mergeCells('A32:C32');
const h2 = ws.getCell('A32');
h2.value = 'HELPER 2 — SCENARIO MAX-LOSS OVERRIDE (cash-secured puts & similar)';
h2.font = sectionHeader;
h2.fill = helperFill;

const h2Inputs = [
  ['Strike price ($)', 100, '"$"#,##0.00'],
  ['Premium received ($/share)', 1.5, '"$"#,##0.00'],
  ['Contracts', 1, '#,##0'],
  ['Worst realistic underlying price at exit ($)', 90, '"$"#,##0.00'],
];
h2Inputs.forEach((row, i) => {
  const r = 33 + i;
  ws.getCell(`A${r}`).value = row[0];
  ws.getCell(`A${r}`).font = bold;
  ws.getCell(`B${r}`).value = row[1];
  ws.getCell(`B${r}`).numFmt = row[2];
  ws.getCell(`B${r}`).fill = inputFill;
});

// B33 strike, B34 premium, B35 contracts, B36 worst realistic
const h2Outputs = [
  {
    row: 37,
    label: 'Theoretical max loss ( = (strike − 0) × 100 × contracts − premium × 100 × contracts )',
    formula:
      'IF(B34<=0,"Error: premium must be > 0",IF(B33<=0,"Error: strike must be > 0",IF(B35<=0,"Error: contracts must be > 0",(B33*100*B35)-(B34*100*B35))))',
    numFmt: '"$"#,##0.00',
  },
  {
    row: 38,
    label: 'Scenario max loss — paste into main block B6 ↓',
    formula:
      'IF(B34<=0,"Error: premium must be > 0",IF(B33<=0,"Error: strike must be > 0",IF(B35<=0,"Error: contracts must be > 0",IF(B36<0,"Error: worst price must be ≥ 0",IF(B36>B33,"Error: worst price must be ≤ strike",MAX(0,((B33-B36)*100*B35)-(B34*100*B35)))))))',
    numFmt: '"$"#,##0.00',
  },
  {
    row: 39,
    label: 'Max gain ( = premium × 100 × contracts ) — paste into main block B5 ↑',
    formula:
      'IF(B34<=0,"Error: premium must be > 0",IF(B35<=0,"Error: contracts must be > 0",B34*100*B35))',
    numFmt: '"$"#,##0.00',
  },
];
h2Outputs.forEach((o) => {
  ws.getCell(`A${o.row}`).value = o.label;
  ws.getCell(`A${o.row}`).font = bold;
  const cell = ws.getCell(`B${o.row}`);
  cell.value = { formula: o.formula };
  cell.numFmt = o.numFmt;
  cell.fill = outputFill;
});

// Callout
ws.mergeCells('A41:C41');
const callout = ws.getCell('A41');
callout.value =
  '➡ COPY THESE INTO THE MAIN KELLY BLOCK: paste B39 (max gain) into cell B5, and paste B38 (scenario max loss) into cell B6.';
callout.font = bold;
callout.fill = calloutFill;
callout.alignment = { wrapText: true, vertical: 'middle' };
ws.getRow(41).height = 30;

// Notes
ws.mergeCells('A42:C42');
const h2Note1 = ws.getCell('A42');
h2Note1.value =
  '• Scenario max loss is a judgment call — Kelly will size based on whatever you put here. Pick a worst-realistic exit price you would actually act on, not the theoretical floor of $0.';
h2Note1.font = noteItalic;
h2Note1.alignment = { wrapText: true, vertical: 'top' };
ws.getRow(42).height = 30;

ws.mergeCells('A43:C43');
const h2Note2 = ws.getCell('A43');
h2Note2.value = {
  formula:
    '"• Cash collateral required (= strike × 100 × contracts) is a separate constraint from Kelly sizing. For these inputs: $" & TEXT(B33*100*B35,"#,##0.00") & "."',
};
h2Note2.font = noteItalic;
h2Note2.alignment = { wrapText: true, vertical: 'top' };
ws.getRow(43).height = 30;

// ============================================================
// HELPER 3 — TRADE-TYPE CHEAT SHEET (rows 45+)
// ============================================================

ws.mergeCells('A45:C45');
const h3 = ws.getCell('A45');
h3.value = 'HELPER 3 — TRADE-TYPE CHEAT SHEET (how to fill in the main Kelly inputs)';
h3.font = sectionHeader;
h3.fill = helperFill;

const cheats = [
  [
    'Long stock with a stop loss',
    'Use Helper 1. Max gain = your realistic price target gain ($), max loss = (entry − stop) × shares. Win prob = your edge estimate.',
  ],
  [
    'Cash-secured put',
    'Use Helper 2. Max gain = premium × 100 × contracts (B39). Max loss = scenario max loss (B38), NOT the theoretical floor. Win prob = probability the underlying stays above your worst-case exit.',
  ],
  [
    'Defined-risk option spread (credit/debit)',
    'Skip the helpers. Use the contract\'s defined max gain and max loss directly in B5 / B6. Win prob = probability of finishing on the profitable side at expiry.',
  ],
  [
    'Naked calls / undefined-risk shorts',
    'Recommended against — true max loss is unbounded. If you must, force Helper 2 with a hard scenario cap (worst realistic price you would buy back at) and treat the result as a floor on risk, not the truth.',
  ],
  [
    'Trades with planned partial profit-taking',
    'Use a probability-weighted expected gain as max gain (e.g. 0.5 × scale-out gain + 0.5 × runner gain). Note: this departs from strict binary Kelly — treat the result as approximate.',
  ],
];

cheats.forEach((row, i) => {
  const r = 46 + i;
  ws.getCell(`A${r}`).value = row[0];
  ws.getCell(`A${r}`).font = bold;
  ws.getCell(`A${r}`).alignment = { vertical: 'top', wrapText: true };
  ws.mergeCells(`B${r}:C${r}`);
  const c = ws.getCell(`B${r}`);
  c.value = row[1];
  c.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(r).height = 42;
});

await wb.xlsx.writeFile(outPath);
console.log('Wrote', outPath);
