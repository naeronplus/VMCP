import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { median, mad, filterOutliers, robustMedian } from './stats.js';

describe('stats / MAD', () => {
  it('computes median and MAD', () => {
    assert.equal(median([1, 2, 3, 4, 5]), 3);
    assert.equal(mad([1, 2, 3, 4, 5]), 1);
  });

  it('filters noisy outliers', () => {
    const values = [100, 102, 101, 99, 1000];
    const inliers = filterOutliers(values);
    assert.ok(!inliers.includes(4));
    assert.ok(robustMedian(values) < 200);
  });
});
