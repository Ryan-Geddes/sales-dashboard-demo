// Task #428: a single monotonic stamp that advances whenever ANY cache feeding
// the computed pipeline result is cleared or refreshes its data. The computed
// pipeline-result cache (see getLivePipelineData) folds this version into its
// key so a result is only ever served while every underlying input is unchanged.
//
// Two kinds of call sites bump it:
//   * explicit clear/invalidate of a contributing cache (so a freshly cleared
//     cache is visible to the result-cache lookup immediately), and
//   * a fresh TTL-expiry store of new data into a contributing cache (so an
//     independently expiring source cache also invalidates the result cache).
let dataVersion = 0;

export function getDataVersion(): number {
  return dataVersion;
}

export function bumpDataVersion(): void {
  dataVersion++;
}
