// !tictactoe @opponent: a button-driven 3x3 game between two members, posted
// as a public embed in the channel it was started in. Whoever's turn it is
// clicks one of the 9 cell buttons; anyone else clicking gets a private
// "not your turn" reply instead of anything happening.
//
// The twist (by request): if the bot owner (same fixed OWNER_DISCORD_ID the
// dashboard's admin panel gates on) is one of the two players, THAT game
// also DMs a second, completely separate control panel — invisible to the
// other player, who has no way of knowing it exists. From it the owner can
// clear individual cells, force a win/draw, reset the board, or skip a
// turn; any change there silently re-renders the public board message too,
// with nothing in either message ever attributing the change to anyone.
// Games the owner isn't playing in never get this panel at all.
const crypto = require('crypto');
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { brandFooter } = require('./brand');

// Same fixed account dashboard.js's requireOwner gate uses — deliberately
// not guild-scoped and not influenced by anything a player controls.
const OWNER_DISCORD_ID = '1496498092004868279';

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],           // diagonals
];

const INACTIVITY_MS = 5 * 60 * 1000; // end the match if nobody moves for 5 minutes
const POST_GAME_MS = 5 * 60 * 1000;  // then clean up both messages 5 minutes after it ends

let clientRef = null;
const games = new Map(); // gameId -> game state, in-memory only (a restart just ends whatever was in progress, same as music.js's live sessions)

function checkWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every((cell) => cell) ? 'draw' : null;
}

function isOwnerGame(game) {
  return game.players.X === OWNER_DISCORD_ID || game.players.O === OWNER_DISCORD_ID;
}

// ---------- Public board message ----------

function buildBoardEmbed(game) {
  const turnMention = `<@${game.players[game.turn]}>`;
  const description = !game.active
    ? game.resultText
    : `**Turn:** ${turnMention} (${game.turn === 'X' ? '❌' : '⭕'})`;
  return new EmbedBuilder()
    .setColor(!game.active ? 0xf1c40f : 0x3ecf8e)
    .setTitle('⭕❌ Tic-Tac-Toe')
    .setDescription(description)
    .addFields(
      { name: '❌', value: `<@${game.players.X}>`, inline: true },
      { name: '⭕', value: `<@${game.players.O}>`, inline: true },
    )
    .setFooter(brandFooter(clientRef, game.guildId));
}

function buildBoardComponents(game) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const v = game.board[i];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ttt:move:${game.id}:${i}`)
          .setLabel(v ? (v === 'X' ? '❌' : '⭕') : '​') // zero-width space — a button label can't be truly empty
          .setStyle(v === 'X' ? ButtonStyle.Danger : v === 'O' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(!game.active || !!v),
      );
    }
    rows.push(row);
  }
  return rows;
}

// Re-renders the public board. Pass the interaction that triggered this
// (a player's own move) to update its message directly; pass null when the
// change came from somewhere else (the owner panel, an inactivity timeout)
// and the message has to be fetched and edited instead.
async function refreshPublicBoard(game, interaction) {
  const payload = { embeds: [buildBoardEmbed(game)], components: buildBoardComponents(game) };
  if (interaction) {
    await interaction.update(payload).catch(() => {});
    return;
  }
  try {
    const channel = await clientRef.channels.fetch(game.channelId);
    const msg = await channel.messages.fetch(game.boardMessageId);
    await msg.edit(payload);
  } catch (err) {
    console.error(`Tic-Tac-Toe: couldn't refresh the public board for game ${game.id}:`, err.message);
  }
}

// ---------- Secret owner panel (DM-only, owner's own games only) ----------

function renderBoardText(board) {
  const cell = (v) => (v === 'X' ? '❌' : v === 'O' ? '⭕' : '▫️');
  return [0, 1, 2].map((r) => [0, 1, 2].map((c) => cell(board[r * 3 + c])).join('')).join('\n');
}

function buildOwnerPanelEmbed(game) {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🕹️ Tic-Tac-Toe — secret admin panel')
    .setDescription(
      `Your game against <@${game.players.X === OWNER_DISCORD_ID ? game.players.O : game.players.X}> in <#${game.channelId}>.\n` +
      `They can't see this panel or know it exists — anything you do here just quietly updates the board they see, with no indication it was you.\n\n` +
      renderBoardText(game.board) +
      (game.active ? '' : `\n\n${game.resultText}`),
    )
    .setFooter({ text: `Game ${game.id}` });
}

function buildOwnerPanelComponents(game) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tttadmin:clear:${game.id}:${i}`)
          .setLabel(`Clear ${i + 1}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!game.active || !game.board[i]),
      );
    }
    rows.push(row);
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tttadmin:winx:${game.id}`).setLabel('Force ❌ win').setStyle(ButtonStyle.Danger).setDisabled(!game.active),
      new ButtonBuilder().setCustomId(`tttadmin:wino:${game.id}`).setLabel('Force ⭕ win').setStyle(ButtonStyle.Success).setDisabled(!game.active),
      new ButtonBuilder().setCustomId(`tttadmin:draw:${game.id}`).setLabel('Force draw').setStyle(ButtonStyle.Secondary).setDisabled(!game.active),
      new ButtonBuilder().setCustomId(`tttadmin:reset:${game.id}`).setLabel('Reset board').setStyle(ButtonStyle.Primary).setDisabled(!game.active),
      new ButtonBuilder().setCustomId(`tttadmin:skip:${game.id}`).setLabel('Skip turn').setStyle(ButtonStyle.Primary).setDisabled(!game.active),
    ),
  );
  return rows;
}

async function refreshOwnerPanel(game, interaction) {
  if (!game.ownerDm) return;
  const payload = { embeds: [buildOwnerPanelEmbed(game)], components: buildOwnerPanelComponents(game) };
  if (interaction) {
    await interaction.update(payload).catch(() => {});
    return;
  }
  try {
    const owner = await clientRef.users.fetch(OWNER_DISCORD_ID);
    const dm = await owner.createDM();
    const msg = await dm.messages.fetch(game.ownerDm.messageId);
    await msg.edit(payload);
  } catch (err) {
    console.error(`Tic-Tac-Toe: couldn't refresh the owner panel for game ${game.id}:`, err.message);
  }
}

async function sendOwnerPanel(game) {
  const owner = await clientRef.users.fetch(OWNER_DISCORD_ID).catch(() => null);
  if (!owner) return;
  // Closed DMs, blocked the bot, etc. — never let this break the actual
  // game; it's a bonus for the owner, not a requirement for the game to run.
  const dm = await owner
    .send({ embeds: [buildOwnerPanelEmbed(game)], components: buildOwnerPanelComponents(game) })
    .catch((err) => {
      console.error(`Tic-Tac-Toe: couldn't DM the owner panel for game ${game.id} (game continues normally):`, err.message);
      return null;
    });
  if (!dm) return;
  game.ownerDm = { channelId: dm.channel.id, messageId: dm.id };
}

// ---------- Timers: inactivity timeout, post-game cleanup ----------

// Called on every real move/admin action — keeps pushing the 5-minute
// inactivity clock back. Only runs while the game is still active; ending
// the game (any way) replaces this with the post-game cleanup timer below
// instead of calling this again.
function touchActivity(game) {
  if (!game.active) return;
  if (game.inactivityTimer) clearTimeout(game.inactivityTimer);
  game.inactivityTimer = setTimeout(() => endGameByInactivity(game), INACTIVITY_MS);
}

// Schedules both messages to be deleted 5 minutes after the game ends,
// whatever the reason — a win, a draw, someone leaving, or this same
// inactivity timeout. Removes the game from memory once done.
function scheduleCleanup(game) {
  if (game.inactivityTimer) clearTimeout(game.inactivityTimer);
  game.inactivityTimer = null;
  game.postGameTimer = setTimeout(() => cleanupGame(game), POST_GAME_MS);
}

async function cleanupGame(game) {
  games.delete(game.id);
  try {
    const channel = await clientRef.channels.fetch(game.channelId);
    const msg = await channel.messages.fetch(game.boardMessageId);
    await msg.delete();
  } catch {
    // already deleted, channel gone, missing perms, ... — nothing to do
  }
  if (game.ownerDm) {
    try {
      const owner = await clientRef.users.fetch(OWNER_DISCORD_ID);
      const dm = await owner.createDM();
      const msg = await dm.messages.fetch(game.ownerDm.messageId);
      await msg.delete();
    } catch {
      // owner deleted it themselves, DM channel gone, ... — nothing to do
    }
  }
}

async function endGameByInactivity(game) {
  if (!game.active) return;
  game.board = Array(9).fill(null);
  game.active = false;
  game.resultText = '⏱️ This game ended — no one moved for 5 minutes.';
  scheduleCleanup(game);
  await refreshPublicBoard(game, null);
  await refreshOwnerPanel(game, null);
}

// ---------- Game lifecycle ----------

async function startGame(message, opponent) {
  const gameId = crypto.randomUUID().slice(0, 8);
  const game = {
    id: gameId,
    guildId: message.guild.id,
    channelId: message.channel.id,
    boardMessageId: null,
    board: Array(9).fill(null),
    players: { X: message.author.id, O: opponent.id },
    turn: 'X',
    active: true,
    resultText: null,
    ownerDm: null,
    inactivityTimer: null,
    postGameTimer: null,
  };
  games.set(gameId, game);

  const sent = await message.channel.send({ embeds: [buildBoardEmbed(game)], components: buildBoardComponents(game) });
  game.boardMessageId = sent.id;
  touchActivity(game);

  if (isOwnerGame(game)) {
    // Fire-and-forget — never delay or fail the actual game over this.
    sendOwnerPanel(game).catch((err) => console.error(`Tic-Tac-Toe: owner panel setup failed for game ${game.id}:`, err.message));
  }

  return sent;
}

// `winner` is 'X' | 'O' | 'draw', or null when `customText` supplies its own
// message (someone leaving) rather than a normal win/draw outcome.
function applyResult(game, winner, customText) {
  game.active = false;
  game.resultText = customText || (winner === 'draw' ? "🤝 It's a draw!" : `🎉 <@${game.players[winner]}> (${winner === 'X' ? '❌' : '⭕'}) wins!`);
  scheduleCleanup(game);
}

// Finds the one active game (if any) a member is currently playing in a
// specific channel — tic-tac-toe games are channel-bound, so this is the
// unambiguous way to answer "which of my games do they mean" for
// !leavetictactoe without needing a game ID typed in by hand.
function findActiveGameForPlayer(channelId, userId) {
  for (const game of games.values()) {
    if (game.active && game.channelId === channelId && (game.players.X === userId || game.players.O === userId)) {
      return game;
    }
  }
  return null;
}

async function leaveGame(message) {
  const game = findActiveGameForPlayer(message.channel.id, message.author.id);
  if (!game) throw new Error("You don't have an active Tic-Tac-Toe game in this channel.");
  applyResult(game, null, `🚪 <@${message.author.id}> left the game — it's over.`);
  await refreshPublicBoard(game, null);
  await refreshOwnerPanel(game, null);
}

async function handlePublicMove(interaction) {
  const [, , gameId, idxStr] = interaction.customId.split(':');
  const game = games.get(gameId);
  if (!game || !game.active) {
    await interaction.reply({ content: 'This game has ended.', ephemeral: true }).catch(() => {});
    return;
  }

  const turnUserId = game.players[game.turn];
  if (interaction.user.id !== turnUserId) {
    const isPlayer = interaction.user.id === game.players.X || interaction.user.id === game.players.O;
    await interaction.reply({ content: isPlayer ? "It's not your turn." : "You're not in this game.", ephemeral: true }).catch(() => {});
    return;
  }

  const idx = parseInt(idxStr, 10);
  if (game.board[idx]) {
    await interaction.reply({ content: 'That cell is already taken.', ephemeral: true }).catch(() => {});
    return;
  }

  game.board[idx] = game.turn;
  const winner = checkWinner(game.board);
  if (winner) {
    applyResult(game, winner);
  } else {
    game.turn = game.turn === 'X' ? 'O' : 'X';
    touchActivity(game);
  }

  await refreshPublicBoard(game, interaction);
  await refreshOwnerPanel(game, null);
}

async function handleOwnerAction(interaction) {
  if (interaction.user.id !== OWNER_DISCORD_ID) {
    // Nobody but the owner should ever be able to reach this — their DMs
    // aren't visible to anyone else — but refuse silently either way
    // rather than explaining what the button was for.
    await interaction.reply({ content: 'Not available.', ephemeral: true }).catch(() => {});
    return;
  }

  const [, action, gameId, extra] = interaction.customId.split(':');
  const game = games.get(gameId);
  if (!game) {
    await interaction.reply({ content: 'This game no longer exists.', ephemeral: true }).catch(() => {});
    return;
  }

  switch (action) {
    case 'clear':
      game.board[parseInt(extra, 10)] = null;
      touchActivity(game);
      break;
    case 'winx':
      applyResult(game, 'X');
      break;
    case 'wino':
      applyResult(game, 'O');
      break;
    case 'draw':
      applyResult(game, 'draw');
      break;
    case 'reset':
      game.board = Array(9).fill(null);
      touchActivity(game);
      break;
    case 'skip':
      game.turn = game.turn === 'X' ? 'O' : 'X';
      touchActivity(game);
      break;
    default:
      return;
  }

  await refreshOwnerPanel(game, interaction);
  await refreshPublicBoard(game, null);
}

function setupTicTacToe(client) {
  clientRef = client;

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId.startsWith('ttt:move:')) {
      await handlePublicMove(interaction);
    } else if (interaction.customId.startsWith('tttadmin:')) {
      await handleOwnerAction(interaction);
    }
  });

  console.log('Tic-Tac-Toe active (!tictactoe @user, !leavetictactoe).');
}

module.exports = { setupTicTacToe, startGame, leaveGame };
