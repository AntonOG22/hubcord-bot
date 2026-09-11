// !imposter [discussionMinutes]: an Among-Us-style word/social-deduction
// game, played entirely through this channel + DMs. One random player
// becomes the Imposter; everyone else gets the same secret word (DMed
// privately) and takes turns describing it in chat WITHOUT saying it
// outright, while the Imposter — who doesn't know the word — has to bluff
// convincingly. After a timed discussion phase, everyone votes on who they
// think the Imposter is; if the group nails it, Crew wins, otherwise the
// Imposter gets away with it.
//
// One shared panel message is reused and re-rendered across all three
// phases (lobby -> discussion -> voting -> result) rather than posting a
// new message each time, so the channel doesn't fill up with one game's
// leftovers.
const crypto = require('crypto');
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { brandFooter } = require('./brand');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10; // keeps the voting buttons to 2 rows
const LOBBY_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_DISCUSSION_MINUTES = 3;
const VOTING_TIMEOUT_MS = 90 * 1000;

const WORD_BANK = [
  { category: 'Food', words: ['Pizza', 'Sushi', 'Burger', 'Tacos', 'Pasta', 'Ice Cream', 'Pancakes', 'Sandwich'] },
  { category: 'Animals', words: ['Elephant', 'Penguin', 'Dolphin', 'Tiger', 'Kangaroo', 'Octopus', 'Giraffe', 'Owl'] },
  { category: 'Places', words: ['Beach', 'Airport', 'Library', 'Hospital', 'Stadium', 'Museum', 'Zoo', 'Castle'] },
  { category: 'Jobs', words: ['Doctor', 'Teacher', 'Firefighter', 'Chef', 'Pilot', 'Astronaut', 'Plumber', 'Artist'] },
  { category: 'Movies & Games', words: ['Minecraft', 'Star Wars', 'Fortnite', 'Harry Potter', 'Mario', 'Pokemon', 'Titanic', 'Avatar'] },
  { category: 'Sports', words: ['Soccer', 'Basketball', 'Tennis', 'Swimming', 'Boxing', 'Golf', 'Skiing', 'Surfing'] },
  { category: 'Objects', words: ['Umbrella', 'Backpack', 'Telescope', 'Guitar', 'Camera', 'Bicycle', 'Candle', 'Mirror'] },
  { category: 'Weather', words: ['Thunderstorm', 'Rainbow', 'Blizzard', 'Hurricane', 'Fog', 'Sunshine', 'Tornado', 'Hail'] },
];

function pickWord() {
  const cat = WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)];
  const word = cat.words[Math.floor(Math.random() * cat.words.length)];
  return { category: cat.category, word };
}

let clientRef = null;
const games = new Map(); // gameId -> game state, in-memory only

function findActiveGame(channelId) {
  for (const game of games.values()) {
    if (game.channelId === channelId && game.phase !== 'ended') return game;
  }
  return null;
}

function clearGameTimer(game) {
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
}

// ---------- Rendering ----------

async function displayName(guildId, userId) {
  const guild = clientRef.guilds.cache.get(guildId);
  const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
  return member ? member.displayName : `<@${userId}>`;
}

function buildLobbyEmbed(game) {
  const list = game.players.length > 0 ? game.players.map((id) => `<@${id}>`).join('\n') : '*Nobody yet.*';
  return new EmbedBuilder()
    .setColor(0x3ecf8e)
    .setTitle('🕵️ Imposter — Lobby')
    .setDescription(
      `One random player becomes the Imposter; everyone else gets the same secret word and has to describe it without saying it. Vote out the Imposter to win!\n\n` +
      `**Players (${game.players.length}/${MAX_PLAYERS}, need ${MIN_PLAYERS}+):**\n${list}\n\n` +
      `Discussion time: **${game.discussionMinutes} min** · Host: <@${game.hostId}>`,
    )
    .setFooter(brandFooter(clientRef, game.guildId));
}

function buildLobbyComponents(game) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`imp:join:${game.id}`).setLabel('Join').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`imp:leave:${game.id}`).setLabel('Leave').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`imp:start:${game.id}`)
        .setLabel('Start')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(game.players.length < MIN_PLAYERS),
    ),
  ];
}

function buildDiscussionEmbed(game) {
  const list = game.players.map((id) => `<@${id}>`).join(', ');
  return new EmbedBuilder()
    .setColor(0x3ecf8e)
    .setTitle('🗣️ Imposter — Discussion')
    .setDescription(
      `Everyone check your DMs — you either got the secret word or you're the Imposter.\n\n` +
      `Take turns describing the word **without saying it** so the group can tell who doesn't actually know it. ` +
      `You have **${game.discussionMinutes} minute(s)**.\n\n` +
      `**Players:** ${list}`,
    )
    .setFooter({ text: 'The host can start voting early with the button below.' });
}

function buildDiscussionComponents(game) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`imp:startvote:${game.id}`).setLabel('Start Voting Now').setEmoji('🗳️').setStyle(ButtonStyle.Primary),
    ),
  ];
}

async function buildVotingEmbed(game) {
  const tally = new Map();
  for (const targetId of game.votes.values()) tally.set(targetId, (tally.get(targetId) || 0) + 1);
  const lines = await Promise.all(
    game.players.map(async (id) => `${await displayName(game.guildId, id)} — ${tally.get(id) || 0} vote(s)`),
  );
  return new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🗳️ Imposter — Voting')
    .setDescription(
      `Who do you think is the Imposter? Everyone gets one vote (you can change it until voting ends).\n\n${lines.join('\n')}\n\n` +
      `**${game.votes.size}/${game.players.length}** voted.`,
    )
    .setFooter({ text: `Voting ends automatically once everyone's in, or after ${VOTING_TIMEOUT_MS / 1000}s.` });
}

async function buildVotingComponents(game) {
  const rows = [];
  for (let i = 0; i < game.players.length; i += 5) {
    const row = new ActionRowBuilder();
    const slice = game.players.slice(i, i + 5);
    for (const id of slice) {
      const name = await displayName(game.guildId, id);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`imp:vote:${game.id}:${id}`)
          .setLabel(name.length > 30 ? name.slice(0, 30) : name)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  return rows;
}

async function buildResultEmbed(game) {
  const tally = new Map();
  for (const targetId of game.votes.values()) tally.set(targetId, (tally.get(targetId) || 0) + 1);
  let eliminated = null;
  let topVotes = -1;
  let tied = false;
  for (const [id, count] of tally) {
    if (count > topVotes) {
      topVotes = count;
      eliminated = id;
      tied = false;
    } else if (count === topVotes) {
      tied = true;
    }
  }
  const crewWon = !tied && eliminated === game.imposterId;

  const imposterName = await displayName(game.guildId, game.imposterId);
  const voteLines = await Promise.all(
    game.players.map(async (id) => `${await displayName(game.guildId, id)} — ${tally.get(id) || 0} vote(s)`),
  );

  let outcome;
  if (tied || !eliminated) {
    outcome = `🤷 The vote was a tie — nobody was voted out. **The Imposter (${imposterName}) got away with it!**`;
  } else if (crewWon) {
    outcome = `🎉 The Crew correctly voted out **${imposterName}**, the Imposter — **Crew wins!**`;
  } else {
    const votedOutName = await displayName(game.guildId, eliminated);
    outcome = `❌ The Crew voted out **${votedOutName}** — not the Imposter. **The Imposter (${imposterName}) wins!**`;
  }

  return new EmbedBuilder()
    .setColor(crewWon ? 0x2ecc71 : 0xe74c3c)
    .setTitle('🏁 Imposter — Result')
    .setDescription(
      `${outcome}\n\n**Secret word:** ${game.wordInfo.word} *(${game.wordInfo.category})*\n\n**Votes:**\n${voteLines.join('\n')}`,
    )
    .setFooter(brandFooter(clientRef, game.guildId));
}

async function refreshPanel(game, interaction) {
  let embed;
  let components;
  if (game.phase === 'lobby') {
    embed = buildLobbyEmbed(game);
    components = buildLobbyComponents(game);
  } else if (game.phase === 'discussion') {
    embed = buildDiscussionEmbed(game);
    components = buildDiscussionComponents(game);
  } else if (game.phase === 'voting') {
    embed = await buildVotingEmbed(game);
    components = await buildVotingComponents(game);
  } else {
    embed = await buildResultEmbed(game);
    components = [];
  }

  const payload = { embeds: [embed], components };
  if (interaction) {
    await interaction.update(payload).catch(() => {});
    return;
  }
  try {
    const channel = await clientRef.channels.fetch(game.channelId);
    const msg = await channel.messages.fetch(game.panelMessageId);
    await msg.edit(payload);
  } catch (err) {
    console.error(`Imposter: couldn't refresh the panel for game ${game.id}:`, err.message);
  }
}

// ---------- Phase transitions ----------

async function startDiscussion(game) {
  clearGameTimer(game);
  game.phase = 'discussion';
  game.timer = setTimeout(() => startVoting(game).catch((err) => console.error(`Imposter: startVoting failed for game ${game.id}:`, err.message)), game.discussionMinutes * 60 * 1000);
  await refreshPanel(game, null);
}

async function startVoting(game) {
  clearGameTimer(game);
  game.phase = 'voting';
  game.votes = new Map();
  game.timer = setTimeout(() => concludeGame(game).catch((err) => console.error(`Imposter: concludeGame failed for game ${game.id}:`, err.message)), VOTING_TIMEOUT_MS);
  await refreshPanel(game, null);
}

async function concludeGame(game) {
  clearGameTimer(game);
  game.phase = 'ended';
  await refreshPanel(game, null);
  games.delete(game.id);
}

// ---------- Lobby actions ----------

async function startLobby(message, discussionMinutes) {
  if (findActiveGame(message.channel.id)) {
    throw new Error('There\'s already an Imposter game running in this channel — finish it or use `!imposterstop` first.');
  }
  const gameId = crypto.randomUUID().slice(0, 8);
  const game = {
    id: gameId,
    guildId: message.guild.id,
    channelId: message.channel.id,
    panelMessageId: null,
    hostId: message.author.id,
    players: [message.author.id],
    discussionMinutes: Math.max(1, Math.min(10, discussionMinutes || DEFAULT_DISCUSSION_MINUTES)),
    phase: 'lobby',
    wordInfo: null,
    imposterId: null,
    votes: new Map(),
    timer: null,
  };
  games.set(gameId, game);

  const sent = await message.channel.send({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(game) });
  game.panelMessageId = sent.id;

  game.timer = setTimeout(async () => {
    if (game.phase !== 'lobby') return;
    game.phase = 'ended';
    await refreshPanel(game, null).catch(() => {});
    games.delete(game.id);
  }, LOBBY_TIMEOUT_MS);

  return sent;
}

async function handleJoin(interaction, game) {
  if (game.players.includes(interaction.user.id)) {
    await interaction.reply({ content: "You're already in.", ephemeral: true }).catch(() => {});
    return;
  }
  if (game.players.length >= MAX_PLAYERS) {
    await interaction.reply({ content: 'This lobby is full.', ephemeral: true }).catch(() => {});
    return;
  }
  game.players.push(interaction.user.id);
  await refreshPanel(game, interaction);
}

async function handleLeave(interaction, game) {
  if (!game.players.includes(interaction.user.id)) {
    await interaction.reply({ content: "You're not in this lobby.", ephemeral: true }).catch(() => {});
    return;
  }
  game.players = game.players.filter((id) => id !== interaction.user.id);
  if (interaction.user.id === game.hostId) game.hostId = game.players[0] || game.hostId; // hand off host instead of leaving it dangling
  if (game.players.length === 0) {
    clearGameTimer(game);
    game.phase = 'ended';
    games.delete(game.id);
    await interaction.update({ embeds: [buildLobbyEmbed(game)], components: [] }).catch(() => {});
    return;
  }
  await refreshPanel(game, interaction);
}

async function handleStart(interaction, game) {
  const isHost = interaction.user.id === game.hostId;
  const isAdmin = interaction.member?.permissions?.has('Administrator');
  if (!isHost && !isAdmin) {
    await interaction.reply({ content: `Only the host (<@${game.hostId}>) or an admin can start this game.`, ephemeral: true }).catch(() => {});
    return;
  }
  if (game.players.length < MIN_PLAYERS) {
    await interaction.reply({ content: `Need at least ${MIN_PLAYERS} players to start.`, ephemeral: true }).catch(() => {});
    return;
  }

  game.wordInfo = pickWord();
  game.imposterId = game.players[Math.floor(Math.random() * game.players.length)];

  const dmResults = await Promise.allSettled(
    game.players.map(async (id) => {
      const user = await clientRef.users.fetch(id);
      const embed =
        id === game.imposterId
          ? new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle('🕵️ You are the IMPOSTER!')
              .setDescription(
                `Everyone else has a secret word in the category **${game.wordInfo.category}** — you don't know what it is.\n\n` +
                `Bluff your way through the discussion and try not to get voted out!`,
              )
          : new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle('🤫 Your secret word')
              .setDescription(
                `**${game.wordInfo.word}** *(${game.wordInfo.category})*\n\n` +
                `Describe it during discussion **without saying it outright** — one of the players is the Imposter and doesn't know it.`,
              );
      await user.send({ embeds: [embed] });
    }),
  );

  const failed = dmResults
    .map((r, i) => (r.status === 'rejected' ? game.players[i] : null))
    .filter(Boolean);

  if (failed.length > 0) {
    await interaction
      .reply({
        content: `Couldn't DM ${failed.map((id) => `<@${id}>`).join(', ')} — they need to allow DMs from server members to play. Game not started.`,
        ephemeral: true,
      })
      .catch(() => {});
    game.wordInfo = null;
    game.imposterId = null;
    return;
  }

  await interaction.reply({ content: '📨 Roles sent — check your DMs!', ephemeral: true }).catch(() => {});
  await startDiscussion(game);
}

async function handleStartVote(interaction, game) {
  const isHost = interaction.user.id === game.hostId;
  const isAdmin = interaction.member?.permissions?.has('Administrator');
  if (!isHost && !isAdmin) {
    await interaction.reply({ content: `Only the host (<@${game.hostId}>) or an admin can start voting early.`, ephemeral: true }).catch(() => {});
    return;
  }
  await startVoting(game);
}

async function handleVote(interaction, game, targetId) {
  if (!game.players.includes(interaction.user.id)) {
    await interaction.reply({ content: "You're not playing in this game.", ephemeral: true }).catch(() => {});
    return;
  }
  game.votes.set(interaction.user.id, targetId);
  await interaction.reply({ content: `Vote recorded for <@${targetId}>. You can change it anytime before voting ends.`, ephemeral: true }).catch(() => {});
  await refreshPanel(game, null);
  if (game.votes.size >= game.players.length) await concludeGame(game);
}

// ---------- Accidental word-leak protection ----------
// A crew member typing the exact secret word in the discussion channel is
// the single most common way this kind of game accidentally spoils itself.
// Deleting it (when possible) and quietly telling them privately is a small
// touch that keeps a good game from being ruined by one slip.
function setupWordLeakGuard(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const game = findActiveGame(message.channel.id);
    if (!game || game.phase !== 'discussion' || !game.wordInfo) return;
    if (!game.players.includes(message.author.id) || message.author.id === game.imposterId) return;

    const escaped = game.wordInfo.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\b${escaped}\\b`, 'i').test(message.content)) return;

    // Warn them either way — if the bot can't actually delete it (missing
    // Manage Messages), that's still worth telling them privately, arguably
    // more so since the leak is now sitting there unremoved.
    const deleted = await message.delete().then(() => true, () => false);
    message.author
      .send(
        deleted
          ? `⚠️ I removed your message in <#${message.channel.id}> — it contained the secret word for the Imposter game. Describe it without saying it!`
          : `⚠️ Your message in <#${message.channel.id}> contains the secret word for the Imposter game, and I couldn't remove it (missing permissions there) — you may want to delete it yourself.`,
      )
      .catch(() => {});
  });
}

async function stopGame(message) {
  const game = findActiveGame(message.channel.id);
  if (!game) throw new Error('No active Imposter game in this channel.');
  const isHost = message.author.id === game.hostId;
  const isAdmin = message.member.permissions.has('Administrator');
  if (!isHost && !isAdmin) throw new Error(`Only the host (<@${game.hostId}>) or an admin can stop this game.`);

  clearGameTimer(game);
  game.phase = 'ended';
  games.delete(game.id);
  try {
    const channel = await clientRef.channels.fetch(game.channelId);
    const msg = await channel.messages.fetch(game.panelMessageId);
    await msg.edit({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('🕵️ Imposter — Stopped').setDescription(`Stopped by <@${message.author.id}>.`)], components: [] });
  } catch {
    // message already gone — fine
  }
}

function setupImposter(client) {
  clientRef = client;
  setupWordLeakGuard(client);

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith('imp:')) return;
    const [, action, gameId, extra] = interaction.customId.split(':');
    const game = games.get(gameId);
    if (!game || game.phase === 'ended') {
      await interaction.reply({ content: 'This game has ended.', ephemeral: true }).catch(() => {});
      return;
    }

    try {
      if (action === 'join') await handleJoin(interaction, game);
      else if (action === 'leave') await handleLeave(interaction, game);
      else if (action === 'start') await handleStart(interaction, game);
      else if (action === 'startvote') await handleStartVote(interaction, game);
      else if (action === 'vote') await handleVote(interaction, game, extra);
    } catch (err) {
      console.error(`Imposter: action "${action}" failed for game ${gameId}:`, err.message);
      await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true }).catch(() => {});
    }
  });

  console.log('Imposter active (!imposter [discussionMinutes], !imposterstop).');
}

module.exports = { setupImposter, startLobby, stopGame };
