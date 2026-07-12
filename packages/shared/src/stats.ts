/**
 * Median Absolute Deviation helpers for nightly performance profiling (§11.2).
 */

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

/**
 * Flag outliers beyond med ± k * MAD (default k=3).
 * Returns indices of inliers.
 */
export function filterOutliers(values: number[], k = 3): number[] {
  if (values.length < 3) return values.map((_, i) => i);
  const med = median(values);
  const m = mad(values);
  // When MAD is 0, all equal or nearly so — keep all
  if (m === 0) return values.map((_, i) => i);
  const threshold = k * 1.4826 * m; // consistency constant for normal dist
  return values
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => Math.abs(v - med) <= threshold)
    .map(({ i }) => i);
}

export function robustMedian(values: number[]): number {
  const indices = filterOutliers(values);
  return median(indices.map((i) => values[i]!));
}
