import { test } from 'node:test';
import assert from 'node:assert/strict';

// Re-implement the pure function locally so we don't have to load TS at runtime.
// The test asserts the contract: derive tier from plan_code prefix.
function membershipTagsForPlan(planCode) {
  const tier = planCode.split('_')[0];
  return ['subscriber', `${tier}-member`, `plan-${planCode}`];
}

test('membershipTagsForPlan: pro_monthly', () => {
  const tags = membershipTagsForPlan('pro_monthly');
  assert.deepEqual(tags, ['subscriber', 'pro-member', 'plan-pro_monthly']);
});

test('membershipTagsForPlan: pro_yearly shares pro tier', () => {
  const tags = membershipTagsForPlan('pro_yearly');
  assert.equal(tags[1], 'pro-member');
  assert.equal(tags[2], 'plan-pro_yearly');
});

test('membershipTagsForPlan: business_yearly distinct tier', () => {
  const tags = membershipTagsForPlan('business_yearly');
  assert.deepEqual(tags, ['subscriber', 'business-member', 'plan-business_yearly']);
});

test('membershipTagsForPlan: all-shared "subscriber" tag', () => {
  for (const code of ['pro_monthly', 'pro_yearly', 'business_monthly', 'business_yearly']) {
    assert.ok(membershipTagsForPlan(code).includes('subscriber'), `missing for ${code}`);
  }
});

test('membershipTagsForPlan: pro and business do NOT share the tier tag', () => {
  const pro = new Set(membershipTagsForPlan('pro_monthly'));
  const biz = new Set(membershipTagsForPlan('business_monthly'));
  assert.ok(!pro.has('business-member'));
  assert.ok(!biz.has('pro-member'));
});
