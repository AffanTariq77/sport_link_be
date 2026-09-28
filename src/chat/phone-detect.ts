// Spec 10: detect Pakistani phone numbers typed into chat, including spaced digits and digits written as words,
// so the sender can be warned before sharing one. Deliberately broad: a false warning costs one tap.

const WORDS: Record<string, string> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  // Roman Urdu, as commonly typed in Pakistan.
  sifar: '0',
  ek: '1',
  aik: '1',
  do: '2',
  teen: '3',
  char: '4',
  chaar: '4',
  panch: '5',
  paanch: '5',
  chay: '6',
  chhe: '6',
  saat: '7',
  aath: '8',
  nau: '9',
  no: '9',
};

// Mobile (03xx xxxxxxx, +92 3xx..., 0092 3xx...) and landline with area code (0xx xxxxxxx).
const PATTERN = /(?:\+?92|0092|0)3\d{9}|(?:\+?92|0092|0)[1-9]\d{8,9}/;

export function containsPhoneNumber(text: string) {
  const spelled = text
    .toLowerCase()
    .replace(/[a-z]+/g, (word) => WORDS[word] ?? ` ${word} `)
    .replace(/(?<=\d)[\s\-.()/]+(?=[\d+])/g, '') // join digits split by spaces or punctuation
    .replace(/\s+/g, ' ');
  return PATTERN.test(spelled.replace(/(?<=\d) (?=\d)/g, ''));
}
