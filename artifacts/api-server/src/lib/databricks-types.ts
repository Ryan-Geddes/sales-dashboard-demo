// Minimal shapes for the subset of the Databricks SQL Statements API we use.
// See https://docs.databricks.com/api/workspace/statementexecution.

export interface DatabricksStatementResponse {
  statement_id?: string;
  status?: {
    state?: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "CLOSED";
    error?: { message?: string };
  };
  result?: {
    data_array?: string[][];
  };
}
