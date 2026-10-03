export type ProtectedRange = Readonly<{ start: number; end: number }>;

// This is an output validator for a small, unambiguous subset of Jan's policy,
// not a general age/entity detector. Whole first-person clauses keep separate
// people, quoted introductions, past ages, and measurement units out of the
// recognized grammar. All offsets refer to the original UTF-16 string.
// Once released, changing this grammar requires a new semanticValidation
// revision so retained configurations keep the same validator behavior.
const CURRENT_AGE = /^(?:I(?:[ \t]+am|['’]m)|my[ \t]+(?:current[ \t]+)?age[ \t]+is)[ \t]+(?:(?:still|currently|now)[ \t]+)?(?<age>(?:[0-8]?\d|eighty[- ]nine)(?:[ \t]+years[ \t]+(?:old|of[ \t]+age))?)$/i;
const BIRTH_THEN_AGE = /^I[ \t]+was[ \t]+born[ \t]+in[ \t]+(?<year>1936)[ \t]+and[ \t]+(?:I[ \t]+)?am[ \t]+(?:(?:still|currently|now)[ \t]+)?(?<age>(?:89|eighty[- ]nine)(?:[ \t]+years[ \t]+(?:old|of[ \t]+age))?)$/i;
const AGE_THEN_BIRTH = /^I(?:[ \t]+am|['’]m)[ \t]+(?:(?:still|currently|now)[ \t]+)?(?<age>(?:89|eighty[- ]nine)(?:[ \t]+years[ \t]+(?:old|of[ \t]+age))?)[ \t]+and[ \t]+(?:I[ \t]+)?was[ \t]+born[ \t]+in[ \t]+(?<year>1936)$/i;
const ORDINARY_BIRTH_YEAR = /^(?:I[ \t]+was[ \t]+born[ \t]+in|my[ \t]+birth[ \t]+year[ \t]+is)[ \t]+(?<year>\d{4})$/i;

export function janV13ProtectedRanges(rawMessage: string): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	for (const segment of rawMessage.matchAll(/[^.!?;\r\n]+/g)) {
		const clause = segment[0].trim();
		const start = segment.index + segment[0].indexOf(clause);
		const add = (value: string) => {
			// Each recognized value occurs once in these tightly bounded clauses.
			const valueStart = start + clause.lastIndexOf(value);
			ranges.push({ start: valueStart, end: valueStart + value.length });
		};
		const linked = BIRTH_THEN_AGE.exec(clause) ?? AGE_THEN_BIRTH.exec(clause);
		if (linked?.groups) {
			add(linked.groups.year);
			add(linked.groups.age);
			continue;
		}
		const age = CURRENT_AGE.exec(clause);
		if (age?.groups) add(age.groups.age);
		const birth = ORDINARY_BIRTH_YEAR.exec(clause);
		if (birth?.groups && Number(birth.groups.year) >= 1937 && Number(birth.groups.year) <= 2026) {
			add(birth.groups.year);
		}
	}
	return ranges;
}
