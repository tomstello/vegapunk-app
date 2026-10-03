import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateFixture, reportedSpans, validateFixtures } from '../scripts/scrubber-eval.mjs';

const one = (text, sensitive, category = 'NAME', retain = []) => ({
	id: 'example', text, expected: [{ text: sensitive, category }], retain
});

test('partial name prefix/suffix does not count as complete sensitive coverage', () => {
	const f = one('My name is Alice Example.', 'Alice Example');
	for (const result of ['My name is [NAME_1] Example.', 'My name is Alice [NAME_1].']) {
		const scored = evaluateFixture(f, result);
		assert.equal(scored.found.length, 0);
		assert.ok(scored.failures.some((failure) => failure.missed));
		assert.ok(scored.reported.every((r) => !r.truePositive));
	}
});

test('complete sensitive span may be covered by separate same-category replacements', () => {
	const scored = evaluateFixture(one('Name: Alice Example.', 'Alice Example'), 'Name: [NAME_1] [NAME_2].');
	assert.equal(scored.found.length, 1);
	assert.deepEqual(scored.failures, []);
});

test('retaining a name elsewhere cannot hide one missed occurrence', () => {
	const scored = evaluateFixture(one('Alice called. Alice asked.', 'Alice'), '[NAME_1] called. Alice asked.');
	assert.equal(scored.expected.length, 2);
	assert.equal(scored.found.length, 1);
	assert.equal(scored.failures.filter((f) => f.missed).length, 1);
});

test('whole ZIP coverage rejects only removing the trailing digits', () => {
	const scored = evaluateFixture(one('ZIP 12345-6789.', '12345-6789', 'ADDRESS'), 'ZIP 12345-[ADDRESS_1].');
	assert.equal(scored.found.length, 0);
	assert.ok(scored.failures.some((f) => f.missed));
});

test('wrong category cannot satisfy recall', () => {
	const scored = evaluateFixture(one('Fax: 202-555-0199.', '202-555-0199', 'FAX'), 'Fax: [PHONE_1].');
	assert.equal(scored.found.length, 0);
	assert.ok(scored.failures.some((f) => f.falsePositive));
});

test('date components together or separately pass while ordinary year survives', () => {
	const f = { id: 'date', text: 'DOB 05/14/1980.', expected: [
		{ text: '05', category: 'DATES' }, { text: '14', category: 'DATES' }
	], retain: ['1980'] };
	assert.deepEqual(evaluateFixture(f, 'DOB [DATES_1]/1980.').failures, []);
	assert.deepEqual(evaluateFixture(f, 'DOB [DATES_1]/[DATES_2]/1980.').failures, []);
	assert.ok(evaluateFixture(f, 'DOB [DATES_1].').failures.some((r) => r.mustRetain === '1980'));
});

test('retention is checked by original occurrence, not just a surviving copy', () => {
	const f = { id: 'date', text: 'Year 1980. Birthday May 14, 1980.', expected: [
		{ text: 'May', category: 'DATES' }, { text: '14', category: 'DATES' }
	], retain: ['1980'] };
	const scored = evaluateFixture(f, 'Year 1980. Birthday [DATES_1].');
	assert.ok(scored.failures.some((r) => r.mustRetain === '1980'));
});

test('numeric collision allows redacting age but forbids unrelated same number', () => {
	const f = { id: 'age', text: 'I am 90 years old; effectiveness is 90 percent.',
		expected: [{ text: '90', category: 'DATES', occurrence: 0 }],
		allowRedact: ['years old'],
		retain: [{ text: '90', occurrence: 1 }] };
	assert.deepEqual(evaluateFixture(f, 'I am [DATES_1]; effectiveness is 90 percent.').failures, []);
	assert.ok(evaluateFixture(f, 'I am [DATES_1] years old; effectiveness is [DATES_1] percent.')
		.failures.some((r) => r.mustRetain));
});

test('existing literal placeholders do not count as fresh redactions', () => {
	const result = reportedSpans('Ask [NAME_1].', 'Ask [NAME_1].');
	assert.deepEqual(result.spans, []);
});

test('rewrites and ambiguous reconstruction fail instead of guessing spans', () => {
	assert.equal(reportedSpans('Alice called.', '[NAME_1] phoned.'), null);
	assert.equal(reportedSpans('Alice Ann Example', '[NAME_1] [NAME_2]'), null);
});

test('placeholder reuse assertion must overlap the expected occurrence', () => {
	const f = { id: 'reuse', text: 'Existing [NAME_2]. New Alice.',
		expected: [{ text: 'Alice', category: 'NAME', expectPlaceholder: '[NAME_2]' }] };
	assert.ok(evaluateFixture(f, 'Existing [NAME_2]. New [NAME_3].').failures.some((r) => r.missedPlaceholder));
});

test('empty expected list detects false positive redaction', () => {
	const scored = evaluateFixture({ id: 'safe', text: 'I am 89.', expected: [], retain: ['89'] }, 'I am [DATES_1].');
	assert.ok(scored.failures.some((f) => f.falsePositive));
	assert.ok(scored.failures.some((f) => f.mustRetain));
});

test('erasing a whole sentence never passes merely because it covers the name', () => {
	const f = one('Jane likes apples.', 'Jane');
	assert.ok(evaluateFixture(f, '[NAME_1]').failures.some((r) => r.overRedaction));
	assert.equal(evaluateFixture(f, '[NAME_1]').reported[0].truePositive, false);
	assert.deepEqual(evaluateFixture(f, '[NAME_1] likes apples.').failures, []);
});

test('optional context must be explicitly allowed; it does not replace retention', () => {
	const f = one('Age: 90 years old.', '90', 'DATES');
	assert.ok(evaluateFixture(f, 'Age: [DATES_1].').failures.some((r) => r.overRedaction));
	assert.deepEqual(evaluateFixture({ ...f, allowRedact: ['years old'] }, 'Age: [DATES_1].').failures, []);
});

test('fixture validation catches missing spans, duplicates, unsupported labels and overlap', () => {
	const good = one('Name Alice; age 89.', 'Alice', 'NAME', ['89']);
	assert.throws(() => validateFixtures({ cases: [good, good] }, ['NAME']), /duplicate/);
	assert.throws(() => validateFixtures({ cases: [good] }, ['DATES']), /unsupported/);
	assert.throws(() => validateFixtures({ cases: [{ ...good, retain: ['Alice'] }] }, ['NAME']), /overlap/);
	assert.throws(() => validateFixtures({ cases: [{ ...good, retain: ['not present'] }] }, ['NAME']), /verbatim/);
});

test('Jan suite is synthetic, bounded and covers every requested label', async () => {
	const suite = JSON.parse(await readFile(new URL('./fixtures/pii-jan-v13.json', import.meta.url), 'utf8'));
	assert.equal(suite.synthetic, true);
	const result = validateFixtures(suite, suite.categories);
	assert.ok(result.cases >= 40 && result.cases <= 71);
	assert.equal(suite.categories.length, 18);
	assert.deepEqual(new Set(result.categories), new Set(suite.categories));
	assert.ok(suite.cases.every((fixture) => [...fixture.text].length <= 1400));
});
