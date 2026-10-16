import test from 'node:test';
import assert from 'node:assert/strict';
import { atsKindFromSource, boardUrlForAts, parseWellfoundNextData, dedupeByBoardUrl } from '../lib/wellfound-parse.mjs';

test('atsKindFromSource maps known Wellfound ATS source strings', () => {
  assert.equal(atsKindFromSource('AtsIntegration::Greenhouse::Listing'), 'greenhouse');
  assert.equal(atsKindFromSource('AtsIntegration::Ashby::Listing'), 'ashby');
  assert.equal(atsKindFromSource('AtsIntegration::Lever::Listing'), 'lever');
});

test('atsKindFromSource returns empty string for unsupported/unknown ATS sources', () => {
  assert.equal(atsKindFromSource('AtsIntegration::Workday::Listing'), '');
  assert.equal(atsKindFromSource('SomethingCustom'), '');
  assert.equal(atsKindFromSource(''), '');
  assert.equal(atsKindFromSource(undefined), '');
});

test('boardUrlForAts constructs the correct official board URL per ATS kind', () => {
  assert.equal(boardUrlForAts('greenhouse', 'acme'), 'https://job-boards.greenhouse.io/acme');
  assert.equal(boardUrlForAts('ashby', 'acme'), 'https://jobs.ashbyhq.com/acme');
  assert.equal(boardUrlForAts('lever', 'acme'), 'https://jobs.lever.co/acme');
});

test('boardUrlForAts returns empty string for unknown kind or missing slug', () => {
  assert.equal(boardUrlForAts('workday', 'acme'), '');
  assert.equal(boardUrlForAts('ashby', ''), '');
  assert.equal(boardUrlForAts('ashby', null), '');
});

function fixtureNextData() {
  return {
    props: {
      pageProps: {
        apolloState: {
          data: {
            'StartupResult:1': {
              __typename: 'StartupResult',
              name: 'Check',
              slug: 'checkhq',
              highlightedJobListings: [{ __ref: 'JobListingSearchResult:100' }, { __ref: 'JobListingSearchResult:101' }],
            },
            'StartupResult:2': {
              __typename: 'StartupResult',
              name: 'Chalk',
              slug: 'chalk-ai',
              highlightedJobListings: [{ __ref: 'JobListingSearchResult:200' }],
            },
            'JobListingSearchResult:100': {
              __typename: 'JobListingSearchResult',
              atsSource: 'AtsIntegration::Ashby::Listing',
              title: 'Software Engineer',
              compensation: '$142k – $187k',
              locationNames: ['New York'],
              remote: false,
              liveStartAt: 1792022526,
            },
            'JobListingSearchResult:101': {
              __typename: 'JobListingSearchResult',
              atsSource: 'AtsIntegration::Ashby::Listing',
              title: 'Staff Software Engineer',
              compensation: '$228k – $264k',
              locationNames: ['United States'],
              remote: true,
              liveStartAt: 1791800000,
            },
            'JobListingSearchResult:200': {
              __typename: 'JobListingSearchResult',
              atsSource: 'AtsIntegration::Greenhouse::Listing',
              title: 'Forward Deployed Engineer',
              compensation: '$170k – $250k',
              locationNames: ['New York City'],
              remote: false,
              liveStartAt: 1791900000,
            },
            // An unlinked JobListingSearchResult that no StartupResult points
            // to — should be ignored, not crash.
            'JobListingSearchResult:999': {
              __typename: 'JobListingSearchResult',
              atsSource: 'AtsIntegration::Ashby::Listing',
              title: 'Orphan Job',
            },
          },
        },
      },
    },
  };
}

test('parseWellfoundNextData extracts title/company/url/location/salary/postedAt/ats for each linked job', () => {
  const rows = parseWellfoundNextData(fixtureNextData());
  assert.equal(rows.length, 3);

  const check1 = rows.find((r) => r.title === 'Software Engineer');
  assert.ok(check1);
  assert.equal(check1.company, 'Check');
  assert.equal(check1.url, 'https://jobs.ashbyhq.com/checkhq');
  assert.equal(check1.location, 'New York');
  assert.equal(check1.salary, '$142k – $187k');
  assert.equal(check1.ats, 'ashby');
  assert.equal(check1.postedAt, new Date(1792022526 * 1000).toISOString());
});

test('parseWellfoundNextData uses "Remote" as location when remote is true, ignoring locationNames', () => {
  const rows = parseWellfoundNextData(fixtureNextData());
  const staff = rows.find((r) => r.title === 'Staff Software Engineer');
  assert.equal(staff.location, 'Remote');
});

test('parseWellfoundNextData maps Greenhouse atsSource to the correct board URL', () => {
  const rows = parseWellfoundNextData(fixtureNextData());
  const chalk = rows.find((r) => r.company === 'Chalk');
  assert.equal(chalk.url, 'https://job-boards.greenhouse.io/chalk-ai');
  assert.equal(chalk.ats, 'greenhouse');
});

test('parseWellfoundNextData drops job listings with no linking StartupResult (orphans)', () => {
  const rows = parseWellfoundNextData(fixtureNextData());
  assert.ok(!rows.some((r) => r.title === 'Orphan Job'));
});

test('parseWellfoundNextData returns an empty array for malformed/missing apolloState rather than throwing', () => {
  assert.deepEqual(parseWellfoundNextData({}), []);
  assert.deepEqual(parseWellfoundNextData(null), []);
  assert.deepEqual(parseWellfoundNextData({ props: {} }), []);
});

test('dedupeByBoardUrl keeps only the first row per unique board URL', () => {
  const rows = [
    { url: 'https://jobs.ashbyhq.com/checkhq', title: 'A' },
    { url: 'https://jobs.ashbyhq.com/checkhq', title: 'B' },
    { url: 'https://job-boards.greenhouse.io/chalk-ai', title: 'C' },
  ];
  const out = dedupeByBoardUrl(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'A');
});
