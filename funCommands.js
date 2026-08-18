// Small fun content generators, triggered from the dashboard and posted as the bot.
const QUOTES = [
  'The secret of getting ahead is getting started. — Mark Twain',
  'Whether you think you can or you think you can\'t, you\'re right. — Henry Ford',
  'Do what you can, with what you have, where you are. — Theodore Roosevelt',
  'It always seems impossible until it\'s done. — Nelson Mandela',
  'A block placed together is a world built together.',
  'Diamonds are just coal that stuck it out under pressure.',
];

const TRIVIA = [
  { q: 'What material do you need to make a Nether Portal?', a: 'Obsidian' },
  { q: 'How many hearts does a fully-healed player have?', a: '10 hearts (20 HP)' },
  { q: 'What mob drops Ender Pearls?', a: 'Enderman' },
  { q: 'What tool is required to mine obsidian?', a: 'A diamond or netherite pickaxe' },
  { q: 'What is the maximum stack size for most items?', a: '64' },
];

const WOULD_YOU_RATHER = [
  'Would you rather fight 1 Warden or 100 Endermen?',
  'Would you rather have unlimited TNT or unlimited diamonds?',
  'Would you rather build only in Survival or only in Creative forever?',
  'Would you rather never use enchantments or never use potions?',
  'Would you rather explore only caves or only the Nether?',
];

const COMPLIMENTS = [
  'is doing an amazing job on this server!',
  'has the best builds around, no contest.',
  'always brightens up the chat.',
  'is basically an honorary staff member at this point.',
  'deserves way more credit than they get.',
];

const EIGHTBALL_ANSWERS = [
  'It is certain.', 'Without a doubt.', 'Yes, definitely.', 'You may rely on it.',
  'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Signs point to yes.',
  'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.',
  'Cannot predict now.', "Don't count on it.", 'My reply is no.',
  'My sources say no.', 'Outlook not so good.', 'Very doubtful.',
];

function eightBall() {
  return EIGHTBALL_ANSWERS[Math.floor(Math.random() * EIGHTBALL_ANSWERS.length)];
}

function rollDice(sides = 6) {
  return Math.floor(Math.random() * sides) + 1;
}

function coinFlip() {
  return Math.random() < 0.5 ? 'Heads' : 'Tails';
}

function randomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

function randomTrivia() {
  return TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
}

function randomWouldYouRather() {
  return WOULD_YOU_RATHER[Math.floor(Math.random() * WOULD_YOU_RATHER.length)];
}

function randomCompliment() {
  return COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
}

module.exports = { rollDice, coinFlip, randomQuote, randomTrivia, randomWouldYouRather, randomCompliment, eightBall };
