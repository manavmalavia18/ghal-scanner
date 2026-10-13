import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HIRINGCAFE_QUERIES,
  parseHiringCafeQueries,
  acceptHiringCafeJob,
} from '../lib/hiringcafe-query.mjs';

test('default HiringCafe queries cover the broadened software-role set deterministically', () => {
  assert.deepEqual(DEFAULT_HIRINGCAFE_QUERIES, [
    'software engineer',
    'software developer',
    'backend engineer',
    'frontend engineer',
    'full stack engineer',
    'full stack developer',
    'platform engineer',
    'devops engineer',
    'site reliability engineer',
    'data engineer',
    'machine learning engineer',
    'mobile engineer',
    'ios engineer',
    'android engineer',
    'qa automation engineer',
    'security engineer',
  ]);
  assert.deepEqual(
    parseHiringCafeQueries(' software engineer | backend engineer | software engineer | frontend engineer '),
    ['software engineer', 'backend engineer', 'frontend engineer'],
  );
});

test('baseline query keeps its existing broad behavior', () => {
  assert.equal(acceptHiringCafeJob({ title: 'Manufacturing Software Coordinator' }, { baseline: true }), true);
});

test('expansion queries accept relevant early-career software titles across broadened roles', () => {
  for (const title of [
    'Junior Software Developer',
    'Backend Engineer',
    'Frontend Engineer',
    'Software Engineering Intern',
    'Full Stack Developer',
    'Platform Engineer',
    'DevOps Engineer',
    'Site Reliability Engineer',
    'Data Engineer',
    'Machine Learning Engineer',
    'Mobile Engineer',
    'iOS Engineer',
    'Android Engineer',
    'QA Automation Engineer',
    'Security Engineer',
  ]) {
    assert.equal(acceptHiringCafeJob({ title }, { baseline: false }), true, title);
  }
});

test('expansion queries reject senior, management, and physical-engineering noise', () => {
  for (const title of [
    'Senior Backend Engineer',
    'Staff Frontend Engineer',
    'Engineering Manager',
    'Lead Software Developer',
    'Civil Engineer',
    'Manufacturing Engineer',
    'Mechanical Design Engineer',
  ]) {
    assert.equal(acceptHiringCafeJob({ title }, { baseline: false }), false, title);
  }
});
