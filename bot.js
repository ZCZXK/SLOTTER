const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ChannelType, 
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const Database = require('better-sqlite3');
const express = require('express');
require('dotenv').config();

// Web Server Setup (For Railway Keep-Alive / Health Checks)
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).json({ status: 'Online', timestamp: new Date().toISOString() }));
app.listen(PORT, () => console.log(`[HTTP] Health server running on port ${PORT}`));

// Database Initialization
const db = new Database('bot_data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS slot_codes (
    code TEXT PRIMARY KEY,
    durationMs INTEGER,
    used INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ping_codes (
    code TEXT PRIMARY KEY,
    type TEXT,
    amount INTEGER,
    used INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS active_slots (
    user_id TEXT PRIMARY KEY,
    channel_id TEXT,
    expires_at INTEGER,
    here_pings INTEGER DEFAULT 0,
    everyone_pings INTEGER DEFAULT 0,
    title TEXT DEFAULT 'Authorized Merchant Channel',
    description TEXT DEFAULT 'Welcome to my official slot channel!'
  );
  CREATE TABLE IF NOT EXISTS vouches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT,
    author_id TEXT,
    comment TEXT,
    timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    vouch_channel_id TEXT,
    vouch_emoji TEXT DEFAULT '⭐',
    slot_category_id TEXT
  );
`);

const PREFIX = '$';
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Helper Functions
function parseDuration(durationStr) {
  if (!durationStr) return null;
  const str = durationStr.toLowerCase();
  if (str === '1w') return 7 * 24 * 60 * 60 * 1000;
  if (str === '1m') return 30 * 24 * 60 * 60 * 1000;
  if (str === '3m') return 90 * 24 * 60 * 60 * 1000;
  if (str === 'lifetime') return Infinity;
  return null;
}

function generateCode(prefix) {
  return prefix + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function errorEmbed(title, description) {
  return new EmbedBuilder().setTitle('❌ ' + title).setDescription(description).setColor(0xED4245);
}

function successEmbed(title, description) {
  return new EmbedBuilder().setTitle('✅ ' + title).setDescription(description).setColor(0x57F287);
}

// Slash Command Registry Definitions
const slashCommands = [
  new SlashCommandBuilder().setName('setup').setDescription('Deploy VIP Slot and Ping redemption panels (Admin Only)'),
  new SlashCommandBuilder().setName('setcategory').setDescription('Set category for slot channels (Admin Only)')
    .addChannelOption(function(opt) { return opt.setName('category').setDescription('Target Category').addChannelTypes(ChannelType.GuildCategory).setRequired(true); }),
  new SlashCommandBuilder().setName('gslot').setDescription('Generate a slot activation key (Admin Only)')
    .addStringOption(function(opt) { return opt.setName('duration').setDescription('1w, 1m, 3m, or lifetime').setRequired(true); }),
  new SlashCommandBuilder().setName('gping').setDescription('Generate a ping credit key (Admin Only)')
    .addStringOption(function(opt) { return opt.setName('type').setDescription('Ping type').setRequired(true).addChoices({ name: 'here', value: 'here' }, { name: 'everyone', value: 'everyone' }); })
    .addIntegerOption(function(opt) { return opt.setName('amount').setDescription('Number of pings').setRequired(true); }),
  new SlashCommandBuilder().setName('setvouchchannel').setDescription('Set vouch channel (Admin Only)')
    .addChannelOption(function(opt) { return opt.setName('channel').setDescription('Vouch channel').setRequired(true); }),
  new SlashCommandBuilder().setName('setvouchreaction').setDescription('Set vouch reaction emoji (Admin Only)')
    .addStringOption(function(opt) { return opt.setName('emoji').setDescription('Emoji').setRequired(true); }),
  new SlashCommandBuilder().setName('title').setDescription('Set slot channel title')
    .addStringOption(function(opt) { return opt.setName('text').setDescription('New title').setRequired(true); }),
  new SlashCommandBuilder().setName('desc').setDescription('Set slot description')
    .addStringOption(function(opt) { return opt.setName('text').setDescription('New description').setRequired(true); }),
  new SlashCommandBuilder().setName('renameslot').setDescription('Rename slot channel')
    .addStringOption(function(opt) { return opt.setName('name').setDescription('New name suffix').setRequired(true); }),
  new SlashCommandBuilder().setName('stats').setDescription('View slot statistics and ping balance'),
  new SlashCommandBuilder().setName('nuke').setDescription('Clear all messages in your slot channel'),
  new SlashCommandBuilder().setName('here').setDescription('Send an @here ping in your slot')
    .addStringOption(function(opt) { return opt.setName('message').setDescription('Message payload').setRequired(true); }),
  new SlashCommandBuilder().setName('everyone').setDescription('Send an @everyone ping in your slot')
    .addStringOption(function(opt) { return opt.setName('message').setDescription('Message payload').setRequired(true); }),
  new SlashCommandBuilder().setName('vouch').setDescription('Vouch for a user')
    .addUserOption(function(opt) { return opt.setName('user').setDescription('Target user').setRequired(true); })
    .addStringOption(function(opt) { return opt.setName('comment').setDescription('Feedback comment').setRequired(true); }),
  new SlashCommandBuilder().setName('vouches').setDescription('View vouches for a user')
    .addUserOption(function(opt) { return opt.setName('user').setDescription('Target user').setRequired(false); })
].map(function(cmd) { return cmd.toJSON(); });

// Client Ready & Command Registration
client.once('ready', async function() {
  console.log('[SYSTEM] Logged in as ' + client.user.tag);

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('[SYSTEM] Global slash commands deployed successfully.');
  } catch (err) {
    console.error('[SYSTEM] Failed to register slash commands:', err);
  }

  // Cron Check for Expired Slots (Runs every 60 seconds)
  setInterval(async function() {
    const now = Date.now();
    const expiredSlots = db.prepare('SELECT * FROM active_slots WHERE expires_at != -1 AND expires_at <= ?').all(now);

    for (const slot of expiredSlots) {
      try {
        const guild = client.guilds.cache.first();
        if (guild) {
          const channel = guild.channels.cache.get(slot.channel_id);
          if (channel) await channel.delete('Slot duration expired.');
        }
      } catch (err) {
        console.error('Failed to clean up expired channel ' + slot.channel_id + ':', err);
      } finally {
        db.prepare('DELETE FROM active_slots WHERE user_id = ?').run(slot.user_id);
      }
    }
  }, 60000);
});

// Central Command Execution Engine
async function executeCommand(ctx) {
  const commandName = ctx.commandName;
  const args = ctx.args;
  const member = ctx.member;
  const guild = ctx.guild;
  const channel = ctx.channel;
  const author = ctx.author;
  const reply = ctx.reply;
  const deleteMsg = ctx.deleteMsg;

  // Admin Commands
  if (commandName === 'setup') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      return reply({ embeds: [errorEmbed('Access Denied', 'Requires Administrator permissions.')] });
    }
    const slotPanel = new EmbedBuilder()
      .setTitle('VIP Slot Management')
      .setDescription('Claim your dedicated text channel by redeeming a valid slot key below.')
      .setColor(0x2B2D31);
    const slotRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_claim_slot').setLabel('Activate Slot Key').setStyle(ButtonStyle.Success).setEmoji('🔑')
    );

    const pingPanel = new EmbedBuilder()
      .setTitle('Audience Reach Credits')
      .setDescription('Redeem additional announcement pings (@here / @everyone) for your active slot channel.')
      .setColor(0x2B2D31);
    const pingRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_claim_ping').setLabel('Redeem Ping Key').setStyle(ButtonStyle.Primary).setEmoji('🎟️')
    );

    await channel.send({ embeds: [slotPanel], components: [slotRow] });
    await channel.send({ embeds: [pingPanel], components: [pingRow] });
    if (deleteMsg) deleteMsg();
    return reply({ embeds: [successEmbed('Panels Deployed', 'Redemption panels generated successfully.')] });
  }

  if (commandName === 'setcategory') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      return reply({ embeds: [errorEmbed('Access Denied', 'Requires Administrator permissions.')] });
    }
    const catChannel = args.targetChannel || guild.channels.cache.get(args[0]);
    if (!catChannel || catChannel.type !== ChannelType.GuildCategory) {
      return reply({ embeds: [errorEmbed('Invalid Category', 'Provide a valid category ID or mention a category.')] });
    }

    db.prepare('INSERT INTO guild_config (guild_id, slot_category_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET slot_category_id = excluded.slot_category_id').run(guild.id, catChannel.id);
    return reply({ embeds: [successEmbed('Category Set', 'New slots will spawn in category: **' + catChannel.name + '**')] });
  }

  if (commandName === 'gslot') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return reply({ embeds: [errorEmbed('Access Denied', 'Requires Administrator permissions.')] });
    const durationStr = args[0] || '';
    const durationMs = parseDuration(durationStr);
    if (!durationMs) return reply({ embeds: [errorEmbed('Invalid Duration', 'Usage: `$gslot <1w|1m|3m|lifetime>` or `/gslot duration:<1w|1m|3m|lifetime>`')] });

    const code = generateCode('SLOT');
    db.prepare('INSERT INTO slot_codes (code, durationMs) VALUES (?, ?)').run(code, durationMs === Infinity ? -1 : durationMs);
    return reply({ embeds: [successEmbed('Slot Code Generated', '**Key:** `' + code + '`\n**Duration:** `' + durationStr.toUpperCase() + '`')] });
  }

  if (commandName === 'gping') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return reply({ embeds: [errorEmbed('Access Denied', 'Requires Administrator permissions.')] });
    const type = args[0] ? args[0].toLowerCase() : '';
    const amount = parseInt(args[1], 10);
    if (!['here', 'everyone'].includes(type) || isNaN(amount) || amount <= 0) {
      return reply({ embeds: [errorEmbed('Invalid Parameters', 'Usage: `$gping <here|everyone> <amount>`')] });
    }

    const code = generateCode('PING');
    db.prepare('INSERT INTO ping_codes (code, type, amount) VALUES (?, ?, ?)').run(code, type, amount);
    return reply({ embeds: [successEmbed('Ping Code Generated', '**Key:** `' + code + '`\n**Type:** `@' + type + '`\n**Amount:** `' + amount + '`')] });
  }

  if (commandName === 'setvouchchannel') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return reply({ embeds: [errorEmbed('Access Denied', 'Requires Administrator permissions.')] });
    const targetChan = args.targetChannel || channel;
    db.prepare('INSERT INTO guild_config (guild_id, vouch_channel_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET vouch_channel_id = excluded.vouch_channel_id').run(guild.id, targetChan.id);
    return reply({ embeds: [successEmbed('Vouch Channel Configured', 'Vouches restricted to <#' + targetChan.id + '>.')] });
  }

  if (commandName === 'setvouchreaction') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) return reply({ embeds: [errorEmbed('Access Denied', 'Requires Administrator permissions.')] });
    const emoji = args[0];
    if (!emoji) return reply({ embeds: [errorEmbed('Missing Emoji', 'Usage: `$setvouchreaction <emoji>`')] });

    db.prepare('INSERT INTO guild_config (guild_id, vouch_emoji) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET vouch_emoji = excluded.vouch_emoji').run(guild.id, emoji);
    return reply({ embeds: [successEmbed('Reaction Updated', 'Automatic vouch reaction set to ' + emoji)] });
  }

  // Merchant Slot Operations
  const slot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(author.id);

  if (['title', 'desc', 'renameslot', 'stats', 'nuke', 'here', 'everyone'].includes(commandName)) {
    if (!slot) return reply({ embeds: [errorEmbed('Unauthorized', 'You do not own an active slot.')] });
    if (channel.id !== slot.channel_id) return reply({ embeds: [errorEmbed('Restricted Area', 'This command can only be executed in your active slot channel.')] });
  }

  if (commandName === 'title') {
    const newTitle = args.join(' ');
    if (!newTitle) return reply({ embeds: [errorEmbed('Missing Title', 'Usage: `$title <new title>`')] });
    db.prepare('UPDATE active_slots SET title = ? WHERE user_id = ?').run(newTitle, author.id);
    return reply({ embeds: [successEmbed('Title Updated', 'Channel title set to: **' + newTitle + '**')] });
  }

  if (commandName === 'desc') {
    const newDesc = args.join(' ');
    if (!newDesc) return reply({ embeds: [errorEmbed('Missing Description', 'Usage: `$desc <new description>`')] });
    db.prepare('UPDATE active_slots SET description = ? WHERE user_id = ?').run(newDesc, author.id);
    return reply({ embeds: [successEmbed('Description Updated', 'Store description updated successfully.')] });
  }

  if (commandName === 'renameslot') {
    const rawName = args.join('-');
    const cleanName = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!cleanName) return reply({ embeds: [errorEmbed('Invalid Name', 'Provide a valid alphanumeric name.')] });
    await channel.setName('slot-' + cleanName);
    return reply({ embeds: [successEmbed('Slot Renamed', 'Channel renamed to `slot-' + cleanName + '`')] });
  }

  if (commandName === 'stats') {
    const expText = slot.expires_at === -1 ? '`Never (Lifetime)`' : '<t:' + Math.floor(slot.expires_at / 1000) + ':R>';
    const embed = new EmbedBuilder()
      .setTitle('Slot Statistics - ' + author.username)
      .addFields(
        { name: 'Expiration', value: expText, inline: true },
        { name: 'Ping Credits', value: '`' + slot.here_pings + 'x @here` | `' + slot.everyone_pings + 'x @everyone`', inline: true },
        { name: 'Title', value: '`' + slot.title + '`', inline: false },
        { name: 'Description', value: '```' + slot.description + '```', inline: false }
      ).setColor(0x5865F2);
    return reply({ embeds: [embed] }, false);
  }

  if (commandName === 'nuke') {
    const pos = channel.position;
    const parentId = channel.parentId;
    const newChan = await channel.clone();
    await channel.delete();
    await newChan.setPosition(pos);
    if (parentId) await newChan.setParent(parentId);
    db.prepare('UPDATE active_slots SET channel_id = ? WHERE user_id = ?').run(newChan.id, author.id);
    return newChan.send({ embeds: [successEmbed('Channel Cleared', 'Slot channel cleared successfully.')] });
  }

  if (commandName === 'here' || commandName === 'everyone') {
    const messageText = args.join(' ');
    if (!messageText) return reply({ embeds: [errorEmbed('Missing Message', 'Usage: `$' + commandName + ' <message>`')] });

    const colName = commandName === 'here' ? 'here_pings' : 'everyone_pings';
    if (slot[colName] <= 0) return reply({ embeds: [errorEmbed('Insufficient Balance', 'You have **0** `@' + commandName + '` credits remaining.')] });

    db.prepare('UPDATE active_slots SET ' + colName + ' = ' + colName + ' - 1 WHERE user_id = ?').run(author.id);
    if (deleteMsg) deleteMsg();
    return channel.send({ content: '@' + commandName + ' ' + messageText, allowedMentions: { parse: [commandName] } });
  }

  // Vouch Commands
  if (commandName === 'vouch') {
    const config = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guild.id);
    if (config && config.vouch_channel_id && channel.id !== config.vouch_channel_id) {
      if (deleteMsg) deleteMsg();
      return reply({ embeds: [errorEmbed('Wrong Channel', 'Vouches must be posted in <#' + config.vouch_channel_id + '>')] });
    }

    const target = args.targetUser;
    const comment = args.commentText;

    if (!target || !comment) return reply({ embeds: [errorEmbed('Invalid Syntax', 'Usage: `$vouch @user <comment>` or `/vouch user:@user comment:<comment>`')] });
    if (target.id === author.id) return reply({ embeds: [errorEmbed('Action Denied', 'You cannot vouch for yourself.')] });

    db.prepare('INSERT INTO vouches (target_id, author_id, comment, timestamp) VALUES (?, ?, ?, ?)').run(target.id, author.id, comment, Date.now());
    const total = db.prepare('SELECT COUNT(*) as count FROM vouches WHERE target_id = ?').get(target.id).count;

    const embed = new EmbedBuilder()
      .setTitle('Vouch Recorded')
      .addFields(
        { name: 'Merchant', value: '<@' + target.id + '>', inline: true },
        { name: 'Author', value: '<@' + author.id + '>', inline: true },
        { name: 'Comment', value: '```' + comment + '```' }
      )
      .setFooter({ text: 'Total Vouches: ' + total })
      .setColor(0x57F287);

    const vouchMsg = await channel.send({ embeds: [embed] });
    const reactionEmoji = (config && config.vouch_emoji) ? config.vouch_emoji : '⭐';
    try { await vouchMsg.react(reactionEmoji); } catch (err) {}
    if (deleteMsg) deleteMsg();
  }

  if (commandName === 'vouches') {
    const target = args.targetUser || author;
    const records = db.prepare('SELECT * FROM vouches WHERE target_id = ? ORDER BY timestamp DESC LIMIT 5').all(target.id);
    const total = db.prepare('SELECT COUNT(*) as count FROM vouches WHERE target_id = ?').get(target.id).count;

    if (records.length === 0) return reply({ embeds: [errorEmbed('No Records', target.username + ' has zero recorded vouches.')] });

    const list = records.map(function(r, i) {
      return '**#' + (i + 1) + '** by <@' + r.author_id + '> (<t:' + Math.floor(r.timestamp / 1000) + ':R>)\n└ *"' + r.comment + '"*';
    }).join('\n\n');

    return reply({ embeds: [new EmbedBuilder().setTitle('Vouches - ' + target.username).setDescription(list).setFooter({ text: 'Total Vouches: ' + total }).setColor(0x5865F2)] }, false);
  }
}

// 1. Message Listener (Prefix Commands)
client.on('messageCreate', async function(message) {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const rawArgs = message.content.slice(PREFIX.length).trim().split(/ +/);
  const commandName = rawArgs.shift().toLowerCase();

  const args = rawArgs;
  args.targetUser = message.mentions.users.first();
  args.targetChannel = message.mentions.channels.first();
  args.commentText = rawArgs.slice(1).join(' ');

  const reply = async function(payload, autoDelete) {
    if (typeof autoDelete === 'undefined') autoDelete = true;
    const sentMsg = await message.channel.send(payload);
    if (autoDelete) {
      setTimeout(function() {
        sentMsg.delete().catch(function() {});
      }, 5000);
    }
    return sentMsg;
  };

  const deleteMsg = async function() {
    if (message.deletable) {
      message.delete().catch(function() {});
    }
  };

  await executeCommand({
    commandName: commandName,
    args: args,
    member: message.member,
    guild: message.guild,
    channel: message.channel,
    author: message.author,
    reply: reply,
    deleteMsg: deleteMsg
  });
});

// 2. Interaction Listener (Slash Commands, Modals, Buttons)
client.on('interactionCreate', async function(interaction) {
  if (interaction.isChatInputCommand()) {
    const args = [];
    args.push(interaction.options.getString('duration') || '');
    args.push(interaction.options.getString('type') || '');
    if (interaction.options.getInteger('amount')) args.push(interaction.options.getInteger('amount').toString());
    args.push(interaction.options.getString('text') || interaction.options.getString('name') || '');

    args.targetUser = interaction.options.getUser('user');
    args.targetChannel = interaction.options.getChannel('category') || interaction.options.getChannel('channel');
    args.commentText = interaction.options.getString('comment');

    const reply = async function(payload) {
      payload.ephemeral = true;
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    };

    await executeCommand({
      commandName: interaction.commandName,
      args: args,
      member: interaction.member,
      guild: interaction.guild,
      channel: interaction.channel,
      author: interaction.user,
      reply: reply,
      deleteMsg: null
    });
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'btn_claim_slot') {
      const modal = new ModalBuilder().setCustomId('mdl_claim_slot').setTitle('Activate Slot Key');
      const input = new TextInputBuilder().setCustomId('inp_slot_code').setLabel('Slot Key').setStyle(TextInputStyle.Short).setPlaceholder('SLOT-XXXXXX').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'btn_claim_ping') {
      const modal = new ModalBuilder().setCustomId('mdl_claim_ping').setTitle('Redeem Ping Key');
      const input = new TextInputBuilder().setCustomId('inp_ping_code').setLabel('Ping Key').setStyle(TextInputStyle.Short).setPlaceholder('PING-XXXXXX').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'mdl_claim_slot') {
      const code = interaction.fields.getTextInputValue('inp_slot_code').trim();
      const codeData = db.prepare('SELECT * FROM slot_codes WHERE code = ? AND used = 0').get(code);

      if (!codeData) return interaction.reply({ embeds: [errorEmbed('Verification Failed', 'Invalid or already claimed key.')], ephemeral: true });

      const existing = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(interaction.user.id);
      if (existing) return interaction.reply({ embeds: [errorEmbed('Limit Reached', 'You already own an active slot channel.')], ephemeral: true });

      db.prepare('UPDATE slot_codes SET used = 1 WHERE code = ?').run(code);
      const expiresAt = codeData.durationMs === -1 ? -1 : Date.now() + codeData.durationMs;

      const config = db.prepare('SELECT slot_category_id FROM guild_config WHERE guild_id = ?').get(interaction.guild.id);

      const channelOptions = {
        name: 'slot-' + interaction.user.username,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: interaction.guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] }
        ]
      };

      if (config && config.slot_category_id) {
        channelOptions.parent = config.slot_category_id;
      }

      const channel = await interaction.guild.channels.create(channelOptions);

      db.prepare('INSERT INTO active_slots (user_id, channel_id, expires_at) VALUES (?, ?, ?)').run(interaction.user.id, channel.id, expiresAt);
      await interaction.reply({ embeds: [successEmbed('Slot Allocated', 'Merchant channel created: <#' + channel.id + '>')], ephemeral: true });

      const expText = expiresAt === -1 ? '`Never (Lifetime)`' : '<t:' + Math.floor(expiresAt / 1000) + ':R>';
      const welcomeEmbed = new EmbedBuilder()
        .setTitle('Authorized Merchant Channel')
        .setDescription('Welcome <@' + interaction.user.id + '>! This is your dedicated slot channel.')
        .addFields(
          { name: 'Owner', value: '<@' + interaction.user.id + '>', inline: true },
          { name: 'Expiration', value: expText, inline: true },
          { name: 'Ping Balance', value: '`0x @here` | `0x @everyone`', inline: true }
        ).setColor(0x57F287);

      return channel.send({ content: '<@' + interaction.user.id + '>', embeds: [welcomeEmbed] });
    }

    if (interaction.customId === 'mdl_claim_ping') {
      const code = interaction.fields.getTextInputValue('inp_ping_code').trim();
      const pingData = db.prepare('SELECT * FROM ping_codes WHERE code = ? AND used = 0').get(code);

      if (!pingData) return interaction.reply({ embeds: [errorEmbed('Verification Failed', 'Invalid or claimed ping key.')], ephemeral: true });

      const slot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(interaction.user.id);
      if (!slot) return interaction.reply({ embeds: [errorEmbed('Active Slot Required', 'You must possess an active slot channel to claim pings.')], ephemeral: true });

      db.prepare('UPDATE ping_codes SET used = 1 WHERE code = ?').run(code);
      const field = pingData.type === 'here' ? 'here_pings' : 'everyone_pings';
      db.prepare('UPDATE active_slots SET ' + field + ' = ' + field + ' + ? WHERE user_id = ?').run(pingData.amount, interaction.user.id);

      const updatedSlot = db.prepare('SELECT * FROM active_slots WHERE user_id = ?').get(interaction.user.id);
      return interaction.reply({ embeds: [successEmbed('Pings Deposited', 'Added **' + pingData.amount + 'x @' + pingData.type + '** mentions.\nBalance: `' + updatedSlot.here_pings + 'x @here` | `' + updatedSlot.everyone_pings + 'x @everyone`')], ephemeral: true });
    }
  }
});

// Login
client.login(process.env.DISCORD_TOKEN);