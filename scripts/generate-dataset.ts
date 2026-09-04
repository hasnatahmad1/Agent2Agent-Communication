import { writeFileSync, mkdirSync } from 'node:fs';
import { toCsv, type Row } from '../src/shared/csv.js';

/** Deterministic PRNG (mulberry32) so the dataset is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEADERS = ['roll_no', 'name', 'email', 'age', 'city', 'marks', 'enrolled_date'];

const FIRST = ['Ali', 'Sara', 'Bilal', 'Ayesha', 'Usman', 'Hina', 'Ahmed', 'Fatima',
  'Hamza', 'Zainab', 'Omar', 'Maryam', 'Talha', 'Noor', 'Saad', 'Iqra'];
const LAST = ['Raza', 'Khan', 'Ahmed', 'Malik', 'Sheikh', 'Butt', 'Chaudhry', 'Qureshi'];
const CITIES_CLEAN = ['Lahore', 'Karachi', 'Islamabad', 'Multan', 'Peshawar'];
const CITY_VARIANTS = ['lahore', 'LHR', ' Lahore ', 'khi', 'karachi', 'ISB'];
const MISSING = ['', 'N/A', 'NULL', '-'];
// Age is numeric-coerced by the "implausible age" check (Number('') === 0, which
// would falsely count as implausible), so age's missing tokens exclude ''.
const AGE_MISSING = ['N/A', 'NULL', '-'];

function isoDate(rand: () => number): string {
  const month = 1 + Math.floor(rand() * 12);
  const day = 1 + Math.floor(rand() * 28);
  return `2024-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function reformat(iso: string, style: number): string {
  const [y, m, d] = iso.split('-');
  if (style === 1) return `${d}/${m}/${y}`;
  if (style === 2) return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
  return iso;
}

export function generateDataset(): { headers: string[]; rows: Row[] } {
  const rand = rng(20260904);
  const rows: Row[] = [];

  // 383 base rows; 17 exact duplicates are appended afterwards to reach 400.
  for (let i = 0; i < 383; i++) {
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    const roll = String(1000 + i);

    let name = `${first} ${last}`;
    const nameStyle = rand();
    if (nameStyle < 0.06) name = `  ${name.toUpperCase()} `;
    else if (nameStyle < 0.11) name = name.toLowerCase();

    let email = `${first.toLowerCase()}.${last.toLowerCase()}@uni.edu.pk`;
    const emailStyle = rand();
    if (emailStyle < 0.035) email = `${first.toLowerCase()}@`;
    else if (emailStyle < 0.055) email = `${first.toLowerCase()}.uni.edu.pk`;

    let age = String(18 + Math.floor(rand() * 8));
    const ageStyle = rand();
    if (ageStyle < 0.025) age = 'twenty';
    else if (ageStyle < 0.04) age = '22 years';
    else if (ageStyle < 0.12) age = AGE_MISSING[Math.floor(rand() * AGE_MISSING.length)];

    let city: string;
    const cityStyle = rand();
    if (cityStyle < 0.21) city = CITY_VARIANTS[Math.floor(rand() * CITY_VARIANTS.length)];
    else if (cityStyle < 0.30) city = MISSING[Math.floor(rand() * MISSING.length)];
    else city = CITIES_CLEAN[Math.floor(rand() * CITIES_CLEAN.length)];

    let marks = String(35 + Math.floor(rand() * 61));
    const marksStyle = rand();
    if (marksStyle < 0.032) marks = String(101 + Math.floor(rand() * 10));
    else if (marksStyle < 0.049) marks = String(-1 - Math.floor(rand() * 8));
    else if (marksStyle < 0.077) marks = MISSING[Math.floor(rand() * MISSING.length)];

    const enrolled = reformat(isoDate(rand), Math.floor(rand() * 3));

    rows.push({
      roll_no: roll, name, email, age, city, marks, enrolled_date: enrolled,
    });
  }

  // Exactly 3 implausible ages — the deterministic input-required trigger.
  rows[7].age = '-5';
  rows[113].age = '-5';
  rows[251].age = '250';

  // 17 exact duplicates, spread across the file.
  for (let i = 0; i < 17; i++) {
    rows.push({ ...rows[i * 19] });
  }

  return { headers: HEADERS, rows };
}

// Running the script writes the file; importing it does not.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/generate-dataset.ts')) {
  const { headers, rows } = generateDataset();
  mkdirSync('data', { recursive: true });
  writeFileSync('data/students_raw.csv', toCsv(headers, rows), 'utf8');
  console.log(`Wrote data/students_raw.csv — ${rows.length} rows`);
}
