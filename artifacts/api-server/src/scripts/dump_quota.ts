import { executeStatement } from "../lib/databricks-client";

const WAREHOUSE_ID = "ac4f2677b84273dc";
const QUERY = `SELECT
  \`Performance Period\`, \`Employee For Lookup\`, \`Employee ID\`, \`Group\`,
  \`Monthly Showcase Starting Book MRR\`, \`Showcase Ending MRR Goal\`,
  \`Showcase Ending MRR Goal\` - \`Monthly Showcase Starting Book MRR\` AS sc_net_mrr_goal,
  \`Showcase Churn %\` * \`Monthly Showcase Starting Book MRR\` AS gnr_sc_churn_goal,
  \`Showcase Regional Avg MRR Added\` AS gnr_sc_mrr_added_goal,
  \`Monthly MBP Starting Book MRR\`, \`MBP Ending MRR Goal\`,
  \`MBP Ending MRR Goal\` - \`Monthly MBP Starting Book MRR\` AS mbp_net_mrr_goal,
  \`MBP Churn Goal\` AS gnr_mbp_churn_goal, \`MBP MRR Added Goal\` AS gnr_mbp_mrr_added_goal,
  \`Showcase Current Month Single Month Goal\`, \`MBP Current Month Single Month Goal\`,
  \`Single Month Ramping?\`, \`Single Month Ramping for PPS\`,
  \`Showcase Live MRR Quota\`, \`MBP Live MRR Quota\`
FROM finance.ipfo_anaplan_bronze.pa_pps
WHERE \`Performance Period\` IN (DATE_TRUNC('month', CURRENT_DATE()), ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE()), -1))
  AND \`Group\` IN ('G&R', 'Acquisition')`;

const data: any = await executeStatement(QUERY, { warehouseId: WAREHOUSE_ID });
console.log("STATE:", data.status?.state);
const cols = data.manifest?.schema?.columns?.map((c: any) => c.name) || [];
const rows = data.result?.data_array || [];
console.log("ROW COUNT:", rows.length);
console.log("COLUMNS:", JSON.stringify(cols));
console.log("FIRST 5 ROWS:");
for (const r of rows.slice(0, 5)) console.log(JSON.stringify(r));
console.log("LAST 2 ROWS:");
for (const r of rows.slice(-2)) console.log(JSON.stringify(r));
const periods = new Set(rows.map((r: any) => r[0]));
console.log("DISTINCT Performance Period:", [...periods].join(" | "));
const groups: Record<string, number> = {};
for (const r of rows) groups[r[3]] = (groups[r[3]] || 0) + 1;
console.log("Group counts:", JSON.stringify(groups));
